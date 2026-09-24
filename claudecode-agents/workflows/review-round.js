export const meta = {
  name: 'review-round',
  description:
    'Review a numbered round of a diff: a cheap mechanical pass, then the Opus reviewer verdict, then - with fix: true - a fix run whose commit git has to vouch for before the next round reviews it',
  whenToUse:
    'After a coder finishes a plan phase and before anything merges. By default one run is one round: it reviews and hands blocking findings back. With { fix: true } and an approved plan it commissions the fix itself, verifies the commit against git rather than against what coder said, re-points the review at that commit and goes round again.',
  phases: [
    { title: 'Pin the range', detail: 'resolve both ends to commits and record the worktrees that exist now' },
    { title: 'Scope the diff', detail: 'what changed, how much, and whether it touches anything sensitive' },
    { title: 'Round mechanical', detail: 'lint, types, tests and obvious smells, in parallel', model: 'sonnet' },
    { title: 'Round verdict', detail: 'the reviewer verdict and ranked findings' },
    { title: 'Round fixes', detail: 'the fix run, and the git evidence that it happened where it claims' },
  ],
}

// ---------------------------------------------------------------------------
// review-round
//
// A round is one pass, and rounds are numbered - the glossary's definition, not
// a loose word for iteration. Each round is the plan's two-stage review:
//
//   1. A Sonnet mechanical pass, four lanes in parallel, leaning on the
//      pr-review-toolkit plugin for lint, types, tests and obvious smells.
//      Cheap, so the expensive stage never spends judgement on a lint error.
//   2. The Opus reviewer verdict. The reviewer never edits - that is its whole
//      value, because a reviewer that fixes things means the diff the human approves
//      is not the diff he read.
//
// With `fix: true` the loop closes: blocking findings go to coder, and the next
// round re-reviews the result. The loop ends when a round returns no blocking
// findings, or at the round cap, which is reported rather than passed off as a
// clean review.
//
// WHAT THE LOOP BRANCHES ON, AND WHY IT IS NOT WHAT CODER SAID
//
// The previous version of this script commissioned coder and then lost the
// result. coder carries `isolation: worktree`, so its fixes land as commits in
// a worktree this script never learned the path of; nothing recorded a fix
// HEAD or moved the reviewed ref, so round two re-read the identical diff and
// ran to the cap while the fixes sat in a directory nobody looked at again.
// The loop was removed rather than left lying.
//
// It is back, on evidence. Every fact this script branches on - which worktree
// holds the fix, what it committed, whether that commit is built on the
// reviewed one, whether it is clean, which files it touched - comes from git,
// through lanes that run git and report what it said. coder's handoff is read
// for hints, and the hints are cross-checked and discarded on mismatch. What
// git cannot judge - whether the change is the *requested* change - is what the
// next round's reviewer is for, which is why a fix is never reported as good
// until a later round says so.
//
// TWO TRANSPORTS, AND WHY CODER GETS THE QUIET ONE
//
// A subagent spawned with a `schema` is forced through StructuredOutput, and
// the runtime then sends SubagentStop no `last_assistant_message` at all
// (measured 10 September 2026; hooks/README.md item 16). For a fleet agent that
// costs three things: the handoff-format gate never runs, no "## Done" comment
// reaches the card, and a `- Blocker: ` line - the only route to "Blocked by
// human" that works, since the runtime sends no status - cannot be emitted.
//
// So coder is spawned WITHOUT a schema. Its handoff comes back as a plain
// string, the hook still validates it, still comments the card, and still
// routes a blocker to the human. Everything this script needs to *decide* on comes
// instead from `gitLane` calls, which carry a schema and deliberately carry no
// `agentType`: the SubagentStop matcher lists only the ten fleet names, so
// those lanes are skipped by the gate and a schema costs them nothing.
//
// Note what that means and does not mean: no branch of enforce-agent-scope.sh
// governs an agentType-less lane either, so "read-only git only" in those
// prompts is an instruction, not enforcement. That is the same position the
// four mechanical lanes have always been in, and they run the project's test
// suite.
//
// Escalation lives here rather than in the reviewer body, because the agent
// frontmatter is static and a diff touching authentication, authorisation,
// secrets or credentials earns a deeper look. That is the lead's policy, and
// this script is the lead writing it down.
//
//   /claudecode-agents:review-round { "base": "main", "head": "HEAD", "issue": "session-refresh" }
//   /claudecode-agents:review-round { "range": "main...feature/refresh", "maxRounds": 2 }
//   /claudecode-agents:review-round { "range": "main...feature/refresh", "issue": "x", "fix": true }
//
// `fix` is opt-in. Worktree isolation for a workflow-spawned coder has not been
// observed once against a live Claude, and until it has, a run that commissions
// code by default is a run that surprises somebody.
// ---------------------------------------------------------------------------

const SCOUT = 'claudecode-agents:scout'
const REVIEWER = 'claudecode-agents:reviewer'
const CODER = 'claudecode-agents:coder'
const REFUTER = 'claudecode-agents:refuter'

const SENSITIVE =
  /(auth|authz|authn|login|logout|session|token|jwt|oauth|saml|oidc|password|passkey|credential|secret|crypto|cipher|hash|permission|entitlement|\.env|keychain|vault)/i

const SHA_RE = /^[0-9a-f]{7,40}$/i
// git prints whatever length it feels like, so the reviewed head abbreviated is
// still the reviewed head. Comparing with === would let it be adopted as the
// fix, and round two would re-review the code round one already read - which is
// the exact failure this loop was deleted for in the first place.
function sameCommit(a, b) {
  const x = String(a || '').toLowerCase()
  const y = String(b || '').toLowerCase()
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}
// The eval harness has never applied a schema, and neither has anything else
// this script's booleans arrive from. Two readings are both wrong: a truthy
// test makes the string "false" a blocking finding, and a strict `=== true`
// makes the string "true" a passing one - and that second failure approves a
// merge. So a reviewer's flag is read to FAIL CLOSED: anything that is not
// recognisably a no counts as blocking.
const NO_WORDS = new Set(['false', 'no', '0', ''])
// One reading for every flag that arrives from a model, used in both
// directions. A truthy test makes the string "false" a yes; a strict `=== true`
// makes the string "true" a no. Parse the word instead.
function saysYes(v) {
  if (typeof v === 'string') return !NO_WORDS.has(v.trim().toLowerCase())
  return Boolean(v)
}
// Not the negation of saysYes: absent and undefined are neither a yes nor a no,
// and the difference is what "confirmed isolated" turns on.
function saysNo(v) {
  if (v === false) return true
  return typeof v === 'string' && NO_WORDS.has(v.trim().toLowerCase()) && v.trim() !== ''
}

// git prints the path it resolved, and macOS resolves /tmp through /private, so
// string equality would leave a real worktree unfindable in its own list - and
// this check fails closed, so that would mean the loop never closes.
function samePath(a, b) {
  const trim = (p) => String(p || '').replace(/\/+$/, '')
  const x = trim(a)
  const y = trim(b)
  if (!x || !y) return false
  return x === y || '/private' + x === y || x === '/private' + y
}
function isBlocking(f) {
  return saysYes(f && f.blocking)
}

// The cap is the only thing bounding what this workflow spends, and `|| 3`
// accepted any truthy value - so a maxRounds of "three" made every comparison
// NaN-false and the loop commissioned coder until the process died. Numbers
// that bound spend get the same suspicion as the flag that authorises it.
function positiveInt(v, fallback, name) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) return { bad: String(v), name }
  return n
}
const VERDICTS = ['approve', 'approve with follow-ups', 'request changes']
const DISPOSITIONS = ['not attempted', 'attempted and failed', 'rejected as wrong']

const input = typeof args === 'string' ? { range: args } : args || {}
const rawRange = input.range || (input.base && input.head ? input.base + '...' + input.head : 'HEAD~1...HEAD')
const issue = input.issue || null
const maxRounds = positiveInt(input.maxRounds, 3, 'maxRounds')
const intentPath = issue ? 'docs/plans/' + issue + '.md' : input.plan || null
// Opt-in, and read strictly. `input.fix` arrives from a slash command's JSON,
// so anything other than a real `true` is not consent.
const autoFix = input.fix === true

// Mandatory under fix: true, and reachable on an ordinary review through
// refute: true. Reaching it outside a loop is how the role earns its place:
// one agent on a single round produces real evidence about its behaviour,
// where a refuter first exercised inside a loop is being trusted with
// compounding errors on its first outing.
const refute = autoFix || input.refute === true

// --- reading a handoff -----------------------------------------------------
//
// These are EXTRACTORS, not validators. The handoff gate lives in
// board-subagent-stop.sh and stays there; nothing here decides whether a
// handoff is well formed, only what it says. The section rules are the hook's,
// quoted rather than reinvented: `^## ` opens or closes a section, `^- ` at
// column 0 is an item, and a line that is exactly `- None` (with optional
// trailing blanks, matching the hook's anchored filter) is not an item at all.
// `evals/lib/handoff-parity.sh` is where these stay pinned to the hook.

function handoffSection(msg, name) {
  if (typeof msg !== 'string') return []
  // Every line below is the hook's, in the hook's order:
  //   tr -d '\r'
  //   awk '{ sub(/[[:space:]]+$/, "") } $0 == want {inside=1; next} /^## / {inside=0} inside'
  //   grep -E '^- '
  //   grep -vE '^- None$'
  // Every line is right-trimmed before the heading test, exactly as the hook
  // does - trailing whitespace is invisible in rendered markdown ("## Done  "
  // is the hard-line-break idiom), so it never changes what a line means.
  // Leading whitespace still matters: "-  None", two spaces after the dash,
  // is a real item. handoff-extractor-parity.sh fails the build if these two
  // ever disagree on any fixture.
  const want = '## ' + name
  const out = []
  let inside = false
  for (const raw of msg.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/[ \t\v\f]+$/, '')
    if (line === want) {
      inside = true
      continue
    }
    if (/^## /.test(line)) inside = false
    if (!inside) continue
    if (!/^- /.test(line)) continue
    if (line === '- None') continue
    out.push(line.slice(2))
  }
  return out
}

// The three bullets the fix prompt asks for. All optional: a run whose handoff
// carries none of them still verifies, because git is the source and these are
// only ever a cross-check.
function fixHints(msg) {
  const hints = { worktreePath: '', baseCommit: '', headCommit: '' }
  for (const item of handoffSection(msg, 'Done')) {
    const m = /^(worktree|base-commit|head-commit)\s*:\s*(\S+)/i.exec(item)
    if (!m) continue
    const key = { worktree: 'worktreePath', 'base-commit': 'baseCommit', 'head-commit': 'headCommit' }[m[1].toLowerCase()]
    if (key && !hints[key]) hints[key] = m[2]
  }
  return hints
}

function readHandoff(msg) {
  const decisions = handoffSection(msg, 'Decisions needed')
  return {
    hints: fixHints(msg),
    done: handoffSection(msg, 'Done'),
    notDone: handoffSection(msg, 'Not done'),
    unverified: handoffSection(msg, 'Unverified'),
    blockers: decisions.filter((d) => /^Blocker:\s*/i.test(d)).map((d) => d.replace(/^Blocker:\s*/i, '')),
    proposals: decisions.filter((d) => /^Propose (item|memory):\s*/i.test(d)),
  }
}

// coder.md explicitly permits declining a finding it believes is wrong. A
// "## Not done" bullet of the form `<disposition>: <text naming the file>` says
// which of the three happened; anything else is read as not attempted, because
// silence is not a refusal.
function dispositionOf(said, file) {
  const want = normalisePath(file)
  for (const item of said.notDone || []) {
    // The shape asked for is "<disposition>: <file> - <why>", so only the FIRST
    // word after the colon is the file. Scanning the whole line let a file
    // mentioned in the reasoning inherit another finding's disposition -
    // "rejected as wrong: src/a.ts - unlike src/b.ts which I did fix" marked
    // src/b.ts rejected, which is the opposite of what it says.
    const m = /^([a-z ]+):\s*(\S+)/i.exec(item)
    if (!m) continue
    const disposition = m[1].trim().toLowerCase()
    if (!DISPOSITIONS.includes(disposition)) continue
    // A model writes a path in backticks or bold as often as bare, and reading
    // `src/b.ts` as a different file from src/b.ts turns a reasoned refusal
    // into a silent omission.
    const named = normalisePath(m[2].replace(/^[`*_'"(\[]+|[`*_'"),.\]]+$/g, ''))
    if (pathsMatch(named, want) || named === want) return disposition
  }
  return 'not attempted'
}

// A reviewer's `file` is model text: it may arrive as `./src/a.ts`, as
// `src/a.ts:88`, or as an absolute path. git reports repo-relative paths. A
// format mismatch that hard-stops every legitimate fix would mean the loop
// never closes, so both sides are normalised and a suffix match is accepted as
// a logged fallback rather than a silent one.
function normalisePath(p) {
  return String(p || '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/:\d+(:\d+)?$/, '')
}

function pathsMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  // A suffix match is how an absolute path from a reviewer meets a
  // repo-relative one from git. It is not a licence to match on a bare
  // basename: "index.ts" would otherwise match every index.ts in the tree, and
  // a fix that touched an unrelated file of that name would satisfy the very
  // gate that exists to check it touched the right one. So the shorter side has
  // to carry at least one directory of its own before a suffix counts.
  const shorter = a.length < b.length ? a : b
  if (!shorter.includes('/')) return false
  return a.endsWith('/' + b) || b.endsWith('/' + a)
}

// --- the git lanes ---------------------------------------------------------
//
// No agentType, deliberately - see the header. These carry a schema because
// nothing downstream reads their prose, and because the matcher skips them so
// the schema costs no handoff.

const GIT_STATE_SCHEMA = {
  type: 'object',
  required: ['resolved', 'worktrees'],
  properties: {
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        // `role` rather than matching on the ref text: a lane that tidies
        // "feature/refresh" into "refs/heads/feature/refresh" would otherwise
        // silently resolve to nothing, and positional order is the same guess
        // this script refuses to make about the mechanical lanes.
        required: ['role', 'sha'],
        properties: {
          role: { type: 'string', enum: ['base', 'head'] },
          ref: { type: 'string' },
          sha: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    worktrees: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'head', 'isMain'],
        properties: {
          path: { type: 'string' },
          head: { type: 'string' },
          branch: { type: 'string' },
          dirty: { type: 'boolean' },
          isMain: { type: 'boolean' },
        },
      },
    },
    commandsRun: { type: 'array', items: { type: 'string' } },
    couldNotRun: { type: 'array', items: { type: 'string' } },
  },
}

const FIX_VERIFY_SCHEMA = {
  type: 'object',
  // `worktrees` is required, not optional, so the before-snapshot can be
  // refreshed between rounds. Left stale, round three would see round two's
  // worktree as still new, find two candidates and stop as ambiguous. That is
  // a contract with the lane rather than something the stubbed suite can
  // demonstrate - the lanes are stubs here, so nothing below proves it.
  required: ['headCommit', 'containsReviewedHead', 'dirty', 'filesChanged', 'commits', 'worktrees'],
  properties: {
    headCommit: { type: 'string' },
    containsReviewedHead: { type: 'boolean' },
    dirty: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    worktrees: GIT_STATE_SCHEMA.properties.worktrees,
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    isMain: { type: 'boolean' },
    forkPoint: { type: 'string' },
    candidates: { type: 'array', items: { type: 'string' } },
    isolatedSelfReport: { type: 'string' },
    commandsRun: { type: 'array', items: { type: 'string' } },
    couldNotRun: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN_GATE_SCHEMA = {
  type: 'object',
  required: ['planExists', 'planApproved', 'evidence'],
  properties: {
    planExists: { type: 'boolean' },
    planApproved: { type: 'boolean' },
    evidence: { type: 'string' },
  },
}

function gitLane(label, lines, schema) {
  return agent(lines.filter(Boolean).join('\n'), {
    model: 'sonnet',
    effort: 'low',
    phase: 'git state',
    label,
    schema,
  })
}

// --- pinning ---------------------------------------------------------------

function splitRange(r) {
  const three = r.indexOf('...')
  if (three > 0) return { base: r.slice(0, three), head: r.slice(three + 3), sep: '...' }
  const two = r.indexOf('..')
  if (two > 0) return { base: r.slice(0, two), head: r.slice(two + 2), sep: '..' }
  return { base: r + '~1', head: r, sep: '...' }
}

const ends = splitRange(rawRange)

// The cap is checked before anything spawns. A round past the cap has nothing
// to do, and resolving refs for a review that will not happen is just spend.
const startRound = positiveInt(input.round, 1, 'round')

// Refuse an unusable bound rather than running without one.
const badNumber = [maxRounds, startRound].find((v) => v && typeof v === 'object')
if (badNumber) {
  return {
    range: rawRange,
    issue,
    roundsRun: 0,
    stopped: 'unusable ' + badNumber.name,
    approved: false,
    verdict: 'no verdict',
    rounds: [],
    history: [],
    fixes: [],
    nextStep:
      badNumber.name + ' was "' + badNumber.bad + '", which is not a whole number of rounds. Nothing ran, because that value is the only thing bounding what this workflow spends.',
  }
}

if (startRound > maxRounds) {
  return {
    range: rawRange,
    issue,
    roundsRun: 0,
    stopped: 'round cap',
    verdict: 'no verdict',
    rounds: [],
    approved: false,
    history: [],
    fixes: [],
    nextStep:
      'Round ' + startRound + ' is past the cap of ' + maxRounds + '. This is not an approval and nothing was reviewed. Decide whether the change needs a different approach rather than another round.',
  }
}

phase('Pin the range')
const pinned = await gitLane(
  'pin refs',
  [
    'Report on a git repository and change nothing. Read-only git only.',
    'Run git rev-parse --verify "' + ends.base + '^{commit}" - that one is role "base" - and git rev-parse --verify "' + ends.head + '^{commit}", which is role "head".',
    'Report each as a resolved entry carrying its role, the ref you were given, and the full commit sha. If one does not resolve, report an empty sha for that role and put the error text in `error`.',
    'Then run git worktree list --porcelain and report every worktree: its path, its HEAD commit, its branch if it has one, whether git status --porcelain in it is non-empty (dirty), and isMain, which is true for the FIRST worktree the porcelain output names and false for every other.',
    'Do not review anything and do not offer an opinion.',
  ],
  GIT_STATE_SCHEMA,
)

const resolvedOf = (role) => ((pinned && pinned.resolved) || []).find((r) => r && r.role === role)
const reviewBase = (resolvedOf('base') || {}).sha || ''
let reviewedHead = (resolvedOf('head') || {}).sha || ''

if (!SHA_RE.test(reviewBase) || !SHA_RE.test(reviewedHead)) {
  // A symbolic base is not good enough to carry across rounds: if `main` moves
  // while this runs, round two reviews a different range from round one and the
  // claim that the rounds review the same cumulative change is false.
  return {
    range: rawRange,
    issue,
    roundsRun: 0,
    stopped: 'the reviewed head does not resolve',
    verdict: 'no verdict',
    rounds: [],
    approved: false,
    history: [],
    fixes: [],
    pinned: { base: reviewBase, head: reviewedHead, reported: (pinned && pinned.resolved) || [] },
    nextStep:
      'Neither end of ' + rawRange + ' could be pinned to a commit, so there is nothing to review and nothing to compare a later round against. Check the refs exist in this checkout and run again.',
  }
}

let worktreesBefore = (pinned && pinned.worktrees) || []
let reviewRange = reviewBase + '...' + reviewedHead
let checkoutPath = ''
// Reported at the end, and re-derived every round: a fix adds files, so
// whether the change touches anything sensitive is a fact about the code as it
// now stands rather than about the range this run started with.
let sensitive = false
let sensitiveFiles = []
log('Reviewing ' + rawRange + ', pinned to ' + reviewRange + '.')

// --- schemas ---------------------------------------------------------------

const LANES = [
  {
    name: 'lint and format',
    task: 'Run the repository lint and format checks over the changed files and report every violation the diff introduced. Use the pr-review-toolkit plugin checks where they cover this.',
  },
  {
    name: 'types and build',
    task: 'Run the type check and the build. Report every error the diff introduced, with file and line.',
  },
  {
    name: 'tests',
    task: 'Run the test suite, or the tests covering the changed files if the full suite is impractical. Report failures, and report any changed behaviour that no test covers. Say plainly which tests you actually ran.',
  },
  {
    name: 'obvious smells',
    task: 'Read the diff for the mechanical things a linter misses: dead code, a debug statement left in, a swallowed error, a copied block, a TODO shipped, a magic value, an unused import, a commented-out block. Report only what is mechanically checkable - leave judgement to the next stage.',
  },
]

const MECH_SCHEMA = {
  type: 'object',
  required: ['lane', 'ran', 'findings'],
  properties: {
    lane: { type: 'string' },
    ran: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'what'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          what: { type: 'string' },
        },
      },
    },
    couldNotRun: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'what', 'why', 'blocking'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          what: { type: 'string' },
          why: { type: 'string' },
          blocking: { type: 'boolean' },
        },
      },
    },
    unverified: { type: 'array', items: { type: 'string' } },
  },
}

// --- the fix gate ----------------------------------------------------------
//
// A pure function over what the verify lane reported, which is what makes the
// whole design testable without a git repository or a model. Returns the first
// disqualifying reason, or null when the commit may be reviewed.

function gateFix(v, blocking, head) {
  if (!v) return 'the fix verification returned nothing'

  if (!SHA_RE.test(String(v.headCommit || ''))) {
    if (saysYes(v.isMain)) return NOT_ISOLATED
    if ((v.candidates || []).length > 1)
      return 'more than one worktree could be the fix (' + v.candidates.join(', ') + '), so which commit to review would be a guess'
    return 'the fix run produced no commit'
  }
  // Ambiguity disqualifies whether or not the lane went on to pick one. A lane
  // that reports three candidates and then names a winner has guessed, and the
  // check used to sit inside the no-commit branch where it never saw this.
  if ((v.candidates || []).length > 1)
    return 'the verification named ' + v.candidates.length + ' candidate worktrees (' + v.candidates.join(', ') + ') and then chose one, so the commit to review is a guess'
  // A commit whose location is unknown cannot be re-reviewed, because every
  // later lane is told to work in that checkout. Adopting it sends round two to
  // read the original code and call the result verified.
  if (!v.worktreePath) return 'the verification found a commit but not the checkout holding it, so a later round has nowhere to read it'
  if (sameCommit(v.headCommit, head)) return 'the fix commit is the reviewed commit, so nothing was committed'
  // Isolation has to be CONFIRMED, not merely unmentioned. `isMain` is optional
  // in the schema, so a lane that omits it would otherwise prove isolation by
  // saying nothing - and in the probe both agents ran in the main checkout, so
  // silence is the shape this failure actually takes. Confirmation is an
  // explicit isMain: false, or the worktree list saying so about this path.
  // The worktree list is consulted FIRST, always. Guarding the cross-check
  // behind the flat field meant an `isMain: false` skipped it - so a payload
  // that contradicted itself in one object, flat field saying not-main while
  // its own list said that exact path IS main, was believed on the flat claim.
  // Fixing "absent" was not fixing "lying", and they are one branch apart.
  const entry = (v.worktrees || []).find((w) => w && w.path && samePath(w.path, v.worktreePath))
  if (entry) {
    if (saysYes(entry.isMain)) return NOT_ISOLATED
    if (!saysNo(entry.isMain)) return NOT_CONFIRMED_ISOLATED
    // The list says this path is not the main checkout. If the flat field says
    // it is, the payload contradicts itself and neither half can be trusted -
    // whichever way round the disagreement runs.
    if (saysYes(v.isMain)) return NOT_CONFIRMED_ISOLATED
  } else if (!saysNo(v.isMain)) {
    // No entry for this path: the flat field is all there is, and it has to be
    // an explicit no rather than merely not a yes.
    return NOT_CONFIRMED_ISOLATED
  }
  if (!saysYes(v.containsReviewedHead))
    return (
      'the fix is not built on the reviewed commit ' + head + (v.forkPoint ? ' - it forks at ' + v.forkPoint : '')
    )
  if (saysYes(v.dirty)) return 'the fix worktree has uncommitted changes, so the commit is not the whole fix'

  // The file-touch rule used to be skipped entirely when no finding named a
  // file, which meant an empty commit satisfied it. If there is nothing to
  // check the fix against, that is a reason to stop, not a reason to pass.
  const named = (blocking || []).map((f) => normalisePath(f.file)).filter(Boolean)
  if (!named.length)
    return 'no blocking finding names a file, so there is nothing to check the fix commit against'
  const changed = (v.filesChanged || []).map(normalisePath).filter(Boolean)
  const hit = named.filter((n) => changed.some((c) => pathsMatch(c, n)))
  if (!hit.length)
    return 'the fix commit touches none of the files the blocking findings name (' + named.join(', ') + ')'
  if (hit.length < named.length) log('The fix touches ' + hit.length + ' of ' + named.length + ' named files; the rest go back to the reviewer by name.')
  return null
}

const NOT_CONFIRMED_ISOLATED =
  'the fix run could not be confirmed isolated: nothing in the verification says whether that worktree is the main checkout, and an unconfirmed fix is not adopted'

const NOT_ISOLATED =
  'the fix run was not isolated: the only worktree whose HEAD moved is the main checkout, so the commit is on the shared working branch rather than in a worktree this run may re-review'

function unresolvedFrom(v, blocking, said) {
  const changed = (v.filesChanged || []).map(normalisePath).filter(Boolean)
  return (blocking || [])
    .filter((f) => !changed.some((c) => pathsMatch(c, normalisePath(f.file))))
    .map((f) => ({
      ...f,
      disposition: dispositionOf(said, f.file),
      why: 'the fix commit does not touch ' + f.file,
    }))
}

// --- the rounds ------------------------------------------------------------

const rounds = []
const fixes = []
let round = startRound
let stopped = 'clean'
let fixRequest = null

while (true) {
  const tag = 'Round ' + round

  if (round > maxRounds) {
    stopped = 'round cap'
    log(tag + ' is past the cap of ' + maxRounds + '. This is not an approval.')
    break
  }

  // Scope, inside the loop: a fix adds files, and whether the change is
  // sensitive has to be re-derived from the code as it now stands.
  phase('Scope the diff')
  const scopeResult = await agent(
    [
      'Report on a diff and change nothing. Read-only git only.',
      checkoutPath ? 'Run these in ' + checkoutPath + '. cd there first; that checkout holds the commits under review.' : '',
      'Run git diff --stat ' + reviewRange + ' and git diff --name-only ' + reviewRange + '.',
      'Return every changed path, the total lines added and removed, and the first line of each commit in the range.',
      'Do not review anything and do not offer an opinion.',
    ]
      .filter(Boolean)
      .join(' '),
    {
      agentType: SCOUT,
      label: 'scope ' + reviewRange,
      schema: {
        type: 'object',
        required: ['files', 'added', 'removed'],
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          added: { type: 'number' },
          removed: { type: 'number' },
          commits: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  )

  // A scope pass that failed and a diff that is genuinely empty are two
  // different facts about the world. Collapsing them reported a broken run as
  // "nothing to review", which reads exactly like a clean one.
  if (!scopeResult) {
    stopped = 'scope pass returned nothing'
    log(tag + ': the scope pass returned nothing, so what changed is unknown. Stopping rather than reviewing an empty list.')
    break
  }

  const scope = scopeResult
  if (!(scope.files || []).length) {
    stopped = rounds.length ? 'the fix range is empty' : 'nothing to review'
    break
  }

  sensitiveFiles = scope.files.filter((f) => SENSITIVE.test(f))
  sensitive = sensitiveFiles.length > 0
  log(
    tag +
      ': ' +
      scope.files.length +
      ' files, +' +
      scope.added +
      '/-' +
      scope.removed +
      (sensitive ? '. Sensitive paths present, so the verdict runs deeper: ' + sensitiveFiles.join(', ') : '.'),
  )

  // A barrier is right here: the verdict stage needs every lane's findings in
  // hand, so that it can see what the mechanical pass already took.
  phase(tag + ' mechanical')
  const mechRaw = await parallel(
    LANES.map(
      (lane) => () =>
        agent(
          [
            'Mechanical review pass, ' + tag + ', over the diff ' + reviewRange + '.',
            lane.task,
            checkoutPath
              ? 'Run everything in ' + checkoutPath + '. That is the checkout holding the commits under review; cd there first. Do not commit, do not check anything out, and do not modify tracked files.'
              : '',
            'Changed files:\n' + scope.files.join('\n'),
            'Report what you found and what you could not run. Do not fix anything and do not judge design.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          {
            model: 'sonnet',
            effort: 'low',
            phase: tag + ' mechanical',
            label: tag + ': ' + lane.name,
            schema: MECH_SCHEMA,
          },
        ),
    ),
  )
  const mechanical = mechRaw.filter(Boolean)

  // Settle the previous fix's test claims, if there was one. Found by lane
  // NAME: parallel() ordering in the real loader is unproven, and indexing
  // would settle a claim from whichever lane happened to land third.
  const prevFix = fixes[fixes.length - 1]
  if (prevFix && !prevFix.testResults.verified) {
    const testsLane = mechanical.find((m) => m && m.lane === 'tests')
    if (!testsLane) {
      prevFix.testResults.verifiedBy = 'no mechanical lane reported itself as "tests" in ' + tag + ', so the previous fix\'s test claims stay unverified'
      log(tag + ': no lane identified itself as tests, so the previous fix\'s test claims stay unverified.')
    } else if ((testsLane.findings || []).length) {
      prevFix.testResults.verifiedBy =
        'the tests lane in ' + tag + ' reported ' + testsLane.findings.length + ' finding(s) over the fix, so the claims are contradicted rather than confirmed'
    } else {
      prevFix.testResults.verified = true
      prevFix.testResults.verifiedBy = 'the tests lane in ' + tag + ' ran ' + ((testsLane.ran || []).join(', ') || 'no named command') + ' over the fix range with no findings'
    }
  }

  const mechCount = mechanical.reduce((n, m) => n + (m.findings || []).length, 0)
  if (mechanical.length < LANES.length) {
    log(tag + ': ' + (LANES.length - mechanical.length) + ' of ' + LANES.length + ' mechanical lanes returned nothing.')
  }
  log(tag + ': mechanical pass found ' + mechCount + ' items across ' + mechanical.length + ' lanes.')

  phase(tag + ' verdict')
  // No model override: the reviewer body already pins opus at high effort, and
  // the contract forbids conditional model logic in a body. Effort is raised
  // here only, because escalation is the lead's decision, not the agent's.
  const verdictOpts = {
    agentType: REVIEWER,
    phase: tag + ' verdict',
    label: tag + ' verdict',
    schema: VERDICT_SCHEMA,
  }
  if (sensitive) verdictOpts.effort = 'max'

  const prevUnresolved = prevFix ? prevFix.unresolvedFindings || [] : []
  const review = await agent(
    [
      'Review the diff ' + reviewRange + '. This is ' + tag + '.',
      checkoutPath ? 'Read it in ' + checkoutPath + ', which is the checkout holding these commits.' : '',
      intentPath
        ? 'The change claims to implement ' + intentPath + '. Read it first: a change reviewed against no stated intent has not been reviewed.'
        : 'No plan or spec was supplied. Say so in your report and review against the code as it stands.',
      'The mechanical pass has already run, so the easy findings are taken. Spend your effort where only judgement helps.',
      'Mechanical findings already reported:\n' + JSON.stringify(mechanical, null, 2),
      sensitive
        ? 'This diff touches sensitive paths - ' +
          sensitiveFiles.join(', ') +
          ' - so spend your full budget on those files: authorisation on every path, secrets handling, session and token lifetime, and what an attacker gets from each one.'
        : 'No path in this diff looks security-sensitive, so review it as ordinary code.',
      prevFix
        ? 'This is a re-review of a fix. What the previous round asked for:\n' +
          JSON.stringify(prevFix.requested || [], null, 2) +
          '\nSay for each of those whether it is now fixed, still open, or fixed in a way that introduces something new. Git has already confirmed that a commit exists, is built on the reviewed code and touches the right files; what it cannot confirm, and what you are here for, is whether the change is the change that was asked for.'
        : '',
      prevUnresolved.length
        ? 'The fix commit did not touch these files at all, so treat them as unaddressed unless the code says otherwise:\n' +
          JSON.stringify(prevUnresolved, null, 2)
        : '',
      'Give a one-sentence verdict, then the findings that justify it, worst first, each naming a file and a line, what breaks, and why that matters.',
      'Mark a finding blocking only when it must be fixed before merge. A reviewer who calls everything blocking gets ignored.',
      'Change nothing. Not a fix, not a test, not a note.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    verdictOpts,
  )

  rounds.push({ round, mechanical, verdict: review })

  if (!review) {
    stopped = 'reviewer returned nothing'
    log(tag + ': the reviewer returned nothing. Stopping rather than treating silence as approval.')
    break
  }

  // Coerce at the boundary. The eval harness has never applied a schema, and a
  // truthy read of `blocking` would let the string "false" block a merge while
  // an unrecognised verdict passed for approval.
  if (!VERDICTS.includes(review.verdict)) {
    log(tag + ': verdict "' + review.verdict + '" is not one of the three, so it is read as "request changes".')
    review.verdict = 'request changes'
  }
  const blocking = (review.findings || []).filter(isBlocking)
  log(tag + ': ' + review.verdict + ', ' + blocking.length + ' blocking of ' + (review.findings || []).length + '.')

  if (!blocking.length) {
    if (!refute) {
      stopped = 'clean'
      break
    }

    // A clean verdict is the reviewer failing to find something. It is not the
    // same as somebody failing to break it, and only the second is evidence.
    phase(tag + ' refutation')
    const refutation = await agent(
      [
        'Try to break the change in ' + reviewRange + '. This is ' + tag + '.',
        checkoutPath ? 'It is in ' + checkoutPath + '.' : '',
        'The reviewer found nothing blocking. That is what you are here to disagree with.',
        'Copy what you need OUTSIDE this project, mutate it there, and run the suite against each mutation. Never mutate the tree under test.',
        'Report every mutation that no test noticed, with the exact edit that produced it, as a "- Blocker: " line.',
        'A mutation that makes the process exit non-zero is a kill, not a survival.',
        'Say what you could not attack, in the same detail as what you did.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      // No schema, for the same reason coder gets none: a schema would delete
      // this handoff too, and with it the refuter's only route to the human.
      { agentType: REFUTER, phase: tag + ' refutation', label: tag + ' refutation' },
    )

    if (typeof refutation !== 'string' || !refutation.trim()) {
      stopped = 'refutation returned nothing'
      log(tag + ': the refutation returned nothing. Stopping rather than treating silence as unbreakable.')
      break
    }

    const broke = readHandoff(refutation)
    rounds[rounds.length - 1].refutation = { survivors: broke.blockers, said: broke.done }
    if (broke.blockers.length) {
      stopped = 'refuted'
      log(tag + ': ' + broke.blockers.length + ' mutation(s) survived. A clean verdict over tests that would not notice is not clean.')
      break
    }

    stopped = 'clean'
    break
  }

  // The default path, unchanged: review, and hand the fix back.
  if (!autoFix) {
    fixRequest = { range: reviewRange, plan: intentPath, findings: blocking, requiresApprovedPlan: true }
    rounds[rounds.length - 1].fixRequest = fixRequest
    stopped = 'fix handoff required'
    log(
      tag +
        ': ' +
        blocking.length +
        ' blocking finding(s). Pass fix: true with an approved plan to have this workflow commission and verify the fix.',
    )
    break
  }

  // A fix made in the final round could never be reviewed, and an unreviewed
  // commit reported as fixed is the silent wrong answer the claudecode-agents repo refuses.
  if (round >= maxRounds) {
    stopped = 'round cap'
    fixRequest = { range: reviewRange, plan: intentPath, findings: blocking, requiresApprovedPlan: true }
    log(tag + ' is the last round the cap allows, so no fix is commissioned: it could not be reviewed. This is not an approval.')
    break
  }

  // The plan gate. coder never runs without an approved plan - that is true
  // everywhere else in the fleet and this path is not an exception.
  phase(tag + ' fixes')
  if (!intentPath) {
    stopped = 'no approved plan'
    fixRequest = { range: reviewRange, plan: null, findings: blocking, requiresApprovedPlan: true, planEvidence: 'no issue or plan was supplied, so there is no plan to approve' }
    log(tag + ': blocking findings, but no plan was named, so nothing is commissioned.')
    break
  }

  const planGate = await agent(
    [
      'Report on one file and change nothing. Read-only.',
      'Read ' + intentPath + '. Report whether it exists, and whether a status line in its first fifteen lines says it is approved.',
      'Quote the line you read as evidence. Do not judge whether the plan is any good; only whether it says it is approved.',
    ].join(' '),
    { agentType: SCOUT, phase: tag + ' fixes', label: 'plan gate', schema: PLAN_GATE_SCHEMA },
  )

  if (!planGate || planGate.planExists !== true || planGate.planApproved !== true) {
    stopped = 'no approved plan'
    fixRequest = {
      range: reviewRange,
      plan: intentPath,
      findings: blocking,
      requiresApprovedPlan: true,
      planEvidence: (planGate && planGate.evidence) || 'the plan gate returned nothing',
    }
    log(tag + ': ' + intentPath + ' is not an approved plan, so nothing is commissioned.')
    break
  }

  const fixLabel = 'r' + round
  const handoffText = await commissionFixes({ tag, blocking, review, fixLabel })

  if (typeof handoffText !== 'string' || !handoffText.trim()) {
    stopped = 'the fix run returned nothing'
    fixRequest = { range: reviewRange, plan: intentPath, findings: blocking, requiresApprovedPlan: true }
    log(tag + ': the fix run returned nothing, so there is no commit to look for. Stopping.')
    break
  }

  const said = readHandoff(handoffText)

  // Verify BEFORE deciding what to do about a blocker. If coder committed and
  // then raised a blocker, the human is being told they are needed; they must
  // also be told where the work is.
  const verify = await gitLane(
    'verify fix',
    [
      'Report on a git repository and change nothing. Read-only git only.',
      'A fix run has just finished. Find the commit it made, or report that you cannot tell.',
      'The reviewed commit is ' + reviewedHead + '.',
      'These worktrees existed before the run:\n' + JSON.stringify(worktreesBefore, null, 2),
      'Run git worktree list --porcelain now. A candidate is a worktree that is new, or whose HEAD has moved since that list, whose isMain is false, whose HEAD is not ' +
        reviewedHead +
        ', and for which git merge-base --is-ancestor ' +
        reviewedHead +
        ' <its head> exits 0.',
      'If the ONLY worktree whose HEAD moved is the main one, report headCommit as the empty string, isMain true, and say so in couldNotRun. A commit on the main checkout is on a shared branch and is not a fix this run may adopt.',
      'If there are no candidates, or more than one, report headCommit as the empty string and list what you found in candidates. Guessing which worktree holds the fix is worse than reporting that you cannot tell.',
      'For the chosen commit report: headCommit, its worktreePath and branch, dirty from whether git -C <path> status --porcelain is non-empty, containsReviewedHead from the merge-base test, forkPoint from git merge-base ' +
        reviewedHead +
        ' <head>, filesChanged from git diff --name-only ' +
        reviewedHead +
        '..<head>, and commits from git log --format=%s ' +
        reviewedHead +
        '..<head> oldest first.',
      'Always report the full current worktree list in `worktrees`, with isMain true for the first entry the porcelain output names.',
      'Put every command you ran in commandsRun and everything you could not run in couldNotRun.',
      // Kept for the day this lane has to move to scout, whose allowlist has
      // neither merge-base nor rev-parse: ancestry is also two emptiness
      // checks - git log <head>..<sha> non-empty and git log <sha>..<head>
      // empty means <sha> is a descendant of <head>.
    ],
    FIX_VERIFY_SCHEMA,
  )

  const record = {
    round,
    requested: blocking,
    // git's answer only. Falling back to coder's claim here meant that when the
    // lane omitted the path, the location reported to the human was the very thing
    // this design refuses to trust - and claimMismatch stayed empty, because
    // there was nothing left to disagree with.
    worktreePath: (verify && verify.worktreePath) || '',
    baseCommit: reviewedHead,
    headCommit: (verify && verify.headCommit) || '',
    commits: (verify && verify.commits) || [],
    filesChanged: (verify && verify.filesChanged) || [],
    coderSaid: { done: said.done, notDone: said.notDone, unverified: said.unverified },
    testResults: {
      claimed: said.done.filter((d) => /\b(test|lint|build|suite)\b/i.test(d)),
      verified: false,
      verifiedBy: 'not yet - the next round re-runs lint, types and tests over the fix range',
    },
    unresolvedFindings: [],
    claimMismatch: [],
    proposals: said.proposals,
    accepted: false,
  }

  // coder's hints are a cross-check, never a source. Where git disagrees, git
  // wins and the disagreement is recorded rather than quietly dropped.
  for (const [key, claimed] of Object.entries(said.hints)) {
    if (!claimed) continue
    const actual = record[key]
    if (actual && String(actual) !== String(claimed) && !String(actual).startsWith(String(claimed))) {
      record.claimMismatch.push(key + ': coder said ' + claimed + ', git says ' + actual)
    }
  }
  if (record.claimMismatch.length) log(tag + ': coder\'s handoff disagrees with git - ' + record.claimMismatch.join('; ') + '. Git decides.')

  if (said.blockers.length) {
    // Recorded so the human is told where to look, but never as an accepted fix: the
    // gate has not run, and on this path it would often refuse. Marking it
    // accepted put a dirty non-descendant commit in the main checkout into the
    // history as `fixed: true`.
    record.accepted = false
    record.ungatedReason = gateFix(verify, blocking, reviewedHead) || 'the run stopped on a blocker before the fix was gated'
    stopped = 'coder raised a blocker'
    fixRequest = {
      range: reviewRange,
      plan: intentPath,
      findings: blocking,
      blockers: said.blockers,
      worktree: record.worktreePath,
      headCommit: record.headCommit,
    }
    fixes.push(record)
    log(tag + ': the fix run raised ' + said.blockers.length + ' blocker(s). The card is already on the human queue; this run records where the commits are.')
    break
  }

  const refusal = gateFix(verify, blocking, reviewedHead)
  if (refusal) {
    stopped = refusal === NOT_ISOLATED || refusal === NOT_CONFIRMED_ISOLATED ? 'fix not isolated' : 'unverified fix'
    fixRequest = {
      range: reviewRange,
      plan: intentPath,
      findings: blocking,
      unverifiedReason: refusal,
      coderSaid: record.coderSaid,
      worktree: record.worktreePath,
      headCommit: record.headCommit,
    }
    log(tag + ': ' + refusal + '. Not re-pointing the review at it.')
    break
  }

  record.unresolvedFindings = unresolvedFrom(verify, blocking, said)
  record.accepted = true
  fixes.push(record)

  // Accept: the review moves to the fix. fixRequest is not cleared here because
  // it cannot be set on this path - every branch that assigns it breaks out of
  // the loop immediately - and a line that clears an unreachable state reads
  // like it is guarding against something.
  reviewedHead = verify.headCommit
  reviewRange = reviewBase + '...' + reviewedHead
  checkoutPath = verify.worktreePath || checkoutPath
  worktreesBefore = verify.worktrees || worktreesBefore
  log(tag + ': fix verified at ' + reviewedHead + ' in ' + (checkoutPath || 'an unnamed checkout') + '. Round ' + (round + 1) + ' reviews that commit.')
  round += 1
}

// The fix prompt. Reachable now, and deliberately carries NO schema: a schema
// would delete coder's handoff, and with it the format gate, the card comment
// and the only working route to the human queue.
async function commissionFixes({ tag, blocking, review, fixLabel }) {
  return await agent(
    [
      'Fix the blocking findings from ' + tag + ' of the review of ' + reviewRange + '. Fix these and nothing else.',
      intentPath ? 'The plan this implements is at ' + intentPath + ', and it is approved.' : '',
      'FIRST, before any command that writes anything, run: git rev-parse --git-dir',
      'If its output does not contain "/worktrees/", you are in the main checkout rather than your own worktree. Run no writing git command at all - no switch, no branch, no commit - change nothing, and end with a "- Blocker: " line naming the directory and what that command printed. Committing to a shared working branch is out of scope for you, and this is the check that tells you which one you are in.',
      'Only once that check has passed: git switch -c fix/' + fixLabel + ' ' + reviewedHead,
      'That is not optional bookkeeping. A worktree is cut from the default branch unless it is told otherwise, so without it your commits are not built on the code that was reviewed, and the next round has nothing it can review.',
      'If that switch fails, or if git merge-base --is-ancestor ' + reviewedHead + ' HEAD does not exit 0, your worktree is not built on the reviewed commit. Change nothing, and end with a "- Blocker: " line naming your worktree path and what git merge-base reports. Do not rebase, merge or reset to fix it yourself.',
      'Blocking findings:\n' + JSON.stringify(blocking, null, 2),
      'Non-blocking findings, for context only - do not fix them, they are follow-up work:\n' +
        JSON.stringify((review.findings || []).filter((f) => !f.blocking), null, 2),
      'A failing test first where the finding is a defect, then the smallest change that passes it. Commit small.',
      'If a finding is wrong, say so and leave the code alone rather than changing it to satisfy the review. Record that as a "## Not done" bullet reading "rejected as wrong: <file> - <why>", so the next reviewer sees a decision rather than an omission. The other two spellings are "not attempted: <file> - <why>" and "attempted and failed: <file> - <why>".',
      'Run the tests, the lint and the build before you finish, and record every command you could not run.',
      'In your "## Done" section include three bullets exactly in this shape, so the verification can be cross-checked against what you believe you did: "- worktree: <absolute path>", "- base-commit: <sha you branched from>", "- head-commit: <sha of your last commit>", plus a fourth saying what the git rev-parse --git-dir check above printed.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { agentType: CODER, phase: tag + ' fixes', label: tag + ' fixes' },
  )
}

const last = rounds[rounds.length - 1] || {}
const lastVerdict = last.verdict || {}
const stillBlocking = (lastVerdict.findings || []).filter(isBlocking)
const lastFix = fixes[fixes.length - 1] || null

// Every stop reason gets its own next step. A run that falls through to a
// generic line is a run that tells the human nothing they did not already know.
const NEXT_STEP = {
  clean:
    'No blocking findings. Read the unverified checks and the non-blocking follow-ups above before deciding whether to merge: they are the reviewer\'s own words, not merge blockers, and it is the lead\'s job to decide which become items. Anything coder proposed is under proposals.' +
    (fixes.length
      ? ' ' +
        fixes.length +
        ' fix round(s) ran and nothing was merged: the work is at ' +
        (lastFix && lastFix.headCommit) +
        ' in ' +
        ((lastFix && lastFix.worktreePath) || 'the fix worktree') +
        '. Integrating it is yours.'
      : ''),
  'fix handoff required':
    'Confirm the approved plan, resolve the reviewed head to a commit, and run coder from that commit. Record the resulting worktree path and commit, check the commit actually contains the requested changes, then run this workflow again against that commit in that checkout. A coder saying it committed the fixes is not a review target, and merging just to make another review possible is not an option. Passing fix: true does all of that here, provided the plan says it is approved.',
  'round cap':
    'The cap of ' +
    maxRounds +
    ' rounds is reached and blocking findings remain. This is not an approval. Read the findings and decide whether the change needs a different approach rather than another round.',
  'no approved plan':
    'Blocking findings need a fix run, and coder does not run without an approved plan. Approve ' +
    (intentPath || 'a plan for this issue') +
    ' - a status line in its first fifteen lines has to say so - and run this again with fix: true.',
  'the fix run returned nothing':
    'The fix run produced no handoff, so nothing is known about what it did or where. Check whether a worktree was left behind before running it again; do not assume the work did not happen.',
  'coder raised a blocker':
    'The fix run stopped on a decision only you can make. The card is on the human queue with the blocker text; the commits, if any, are recorded above with their worktree. Answer the blocker, then run this again against that commit.',
  'unverified fix':
    'A fix run happened but git could not vouch for the result, so the review was not re-pointed at it. The reason is in fixRequest.unverifiedReason and what coder said is beside it. Look at the worktree yourself before running another round.',
  'fix not isolated':
    'The fix landed in the main checkout rather than an isolated worktree, which means it is on a shared working branch. Nothing was adopted and nothing was re-reviewed. Check what moved in your own checkout before doing anything else, and see hooks/README.md on worktree isolation.',
  'reviewer returned nothing':
    'The reviewer returned nothing, which is not an approval. Run the round again; if it keeps happening, the diff may be too large for one verdict.',
  'nothing to review': 'The scope pass found no changed files in ' + rawRange + '.',
  'the fix range is empty':
    'A fix was verified but the range from the reviewed commit to it is empty, which should not happen. Look at the worktree directly.',
  'scope pass returned nothing':
    'The scope pass returned nothing, so what changed is unknown and nothing was reviewed. This is not an empty diff and not an approval - run it again.',
  refuted:
    'The reviewer found nothing and the refuter did. Every surviving mutation above is a behaviour no test would notice changing, so the code may well be right and the tests are not evidence that it is. Fix the tests, then run this again.',
  'refutation returned nothing':
    'The refutation produced no handoff, so nothing is known about whether the change survives being attacked. This is not an approval. Run it again.',
}

return {
  range: rawRange,
  reviewedRange: reviewRange,
  pinned: { base: reviewBase, head: reviewedHead },
  issue,
  intent: intentPath,
  autoFix,
  sensitive,
  sensitiveFiles,
  roundsRun: rounds.length,
  stopped,
  // A run that ends with no blocking findings but a verdict nobody recognised -
  // coerced to "request changes" above - is not an approval, and reporting one
  // beside the other made the return contradict itself.
  approved: stopped === 'clean' && /^approve/i.test(lastVerdict.verdict || ''),
  verdict: lastVerdict.verdict || (stopped === 'nothing to review' ? 'nothing to review' : 'no verdict'),
  summary: lastVerdict.summary || '',
  blocking: stillBlocking,
  followUps: (lastVerdict.findings || []).filter((f) => !isBlocking(f)),
  unverified: (lastVerdict.unverified || []).concat(
    fixes
      .filter((f) => !f.testResults.verified)
      .map((f) =>
        'Round ' +
        f.round +
        ' fix: ' +
        (stopped === 'clean'
          ? f.testResults.verifiedBy
          : 'its test claims were never settled, because the run stopped at "' + stopped + '" and no later round re-ran them'),
      ),
  ),
  // coder's own Propose lines. Parsed and carried rather than dropped: it
  // cannot file them itself, and nothing downstream sees its handoff except
  // the card comment.
  proposals: fixes.flatMap((f) => f.proposals || []),
  // Non-null only when the loop declined to fix, or could not.
  fixRequest,
  fixes,
  refuted: stopped === 'refuted',
  refutation: (last.refutation || null),
  checkout: checkoutPath,
  history: rounds.map((r) => ({
    round: r.round,
    mechanical: (r.mechanical || []).reduce((n, m) => n + (m.findings || []).length, 0),
    verdict: (r.verdict || {}).verdict || 'none',
    blocking: ((r.verdict || {}).findings || []).filter(isBlocking).length,
    fixed: fixes.some((f) => f.round === r.round && f.accepted === true && SHA_RE.test(f.headCommit)),
  })),
  nextStep: NEXT_STEP[stopped] || 'The review is incomplete. Read the stop reason above and resolve it; this run is not an approval.',
}
