#!/usr/bin/env node
//
// workflow-logic.mjs - run the real workflow scripts with stubbed agents.
//
// The three workflow bugs the September 2026 review found were all in
// branching and aggregation, not in prompts: a claim promoted to verified by
// two agents failing to answer, a typo'd stage walking past the approval gate,
// and a fix round whose commits went somewhere the next round never looked.
// None of them needs a model to reproduce, and none of them would be caught by
// the handoff formatting suite.
//
// So the scripts are executed for real, with `agent`, `parallel`, `pipeline`,
// `phase` and `log` supplied as deterministic stubs. What this proves is the
// control flow. What it cannot prove is the native loader's behaviour -
// agentType resolution, skill loading, worktree base, the shape of a structured
// result - which stays a live integration check.
//
// Usage:  node evals/lib/workflow-logic.mjs [-v]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const VERBOSE = process.argv.includes('-v')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOWS = join(ROOT, 'claudecode-agents', 'workflows')

let passed = 0
let failed = 0

function check(name, requirement, ok, detail) {
  if (ok) {
    passed += 1
    if (VERBOSE) console.log(`  ok    ${name.padEnd(34)} ${requirement}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name.padEnd(34)} ${requirement}`)
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail)}`)
  }
}

// Run a workflow script with stubbed primitives. `respond` receives the prompt
// and the options and returns whatever that agent call should resolve to;
// returning null models a stopped or failed call, which is a documented result.
async function runWorkflow(file, args, respond) {
  const calls = []
  // new Function on file contents is the point of this harness, not an
  // oversight: the thing under test is the workflow script itself, and it uses
  // top-level `return`, so it only parses inside a function body the way the
  // real loader wraps it. The only string interpolated is a file read from this
  // repository's own claudecode-agents/workflows directory. Never point this at a
  // path that comes from anywhere else.
  const src = readFileSync(join(WORKFLOWS, file), 'utf8').replace(/^export const meta/m, 'const meta')
  const body = new Function(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    `return (async () => {${src}})()`,
  )
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return respond(prompt, opts, calls)
  }
  const parallel = async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f)))
  // pipeline(items, stage, then) - `then` receives the first stage's result and
  // the original item, so an angle can carry its own name into stage two.
  const pipeline = async (items, stage, then) =>
    Promise.all(
      (items || []).map(async (item) => {
        const first = await stage(item)
        return then ? then(first, item) : first
      }),
    )
  const result = await body(agent, parallel, pipeline, () => {}, () => {}, args)
  return { result, calls }
}

console.log('\ndeep-research: a check that did not happen is not a vote in favour')

// Run the real cross-check with a fixed vote per lens. `null` models a stopped
// or failed agent call, which is a documented workflow result.
async function crossCheck(votes) {
  let i = 0
  let synthesis = ''
  const { result } = await runWorkflow('deep-research.js', { question: 'q', maxRounds: 1 }, (prompt, opts) => {
    const label = opts.label || ''
    if (label === 'frame') {
      return {
        restated: 'q',
        answerShape: 'shape',
        angles: [{ name: 'a', mode: 'web', looksFor: 'x' }],
        codebaseQuestions: [],
      }
    }
    if (/^(source quality|recency|contradiction):/.test(label)) {
      const v = votes[i]
      i += 1
      return v === null ? null : { verdict: v, why: 'reason-' + v }
    }
    if (/completeness critic/.test(prompt)) return { angles: [] }
    if (label === 'synthesis') {
      synthesis = prompt
      return 'report'
    }
    return { claims: [{ claim: 'c1', source: 's', why: 'w' }], deadEnds: [] }
  })
  return { counts: result.counts, unverified: result.unverified || [], synthesis }
}

// The review's table. Anything short of two clean positives is unverified, and
// a single refutation is never outvoted by silence.
for (const [votes, want, why] of [
  [['refuted', null, null], 'unverifiable', 'one refutation plus two missing checks'],
  [['stands', null, null], 'unverifiable', 'one positive is not enough on its own'],
  [['stands', 'stands', 'refuted'], 'unverifiable', 'a contradiction is not outvoted'],
  [['stands', 'stands', 'unverifiable'], 'stands', 'two clean positives and nothing against'],
  [['stands', 'stands', 'stands'], 'stands', 'all three lenses agree'],
  [['refuted', 'refuted', 'refuted'], 'refuted', 'all three lenses refute'],
]) {
  const { counts } = await crossCheck(votes)
  check(
    'votes-' + votes.map((v) => v || 'null').join('-'),
    why + ' -> ' + want,
    counts[want] === 1 && Object.values(counts).reduce((a, b) => a + b, 0) === 1,
    counts,
  )
}

// The reasons have to survive into the synthesis, or a contradiction that was
// found simply disappears from the record.
{
  const { synthesis } = await crossCheck(['refuted', null, null])
  check(
    'missing-lenses-recorded',
    'the synthesis is told how many lenses returned nothing',
    /returned no result/.test(synthesis),
    synthesis.slice(0, 160),
  )
  check(
    'refutation-reason-kept',
    "and the refuting lens's reason is carried forward",
    /reason-refuted/.test(synthesis),
    synthesis.slice(0, 160),
  )
}

console.log('\nspec-to-plan: an unknown stage never reaches the planner')

// R10. `plna` matched neither guard and fell through into plan generation,
// reporting itself afterwards as stage: 'plan'.
{
  let threw = null
  let spawned = 0
  try {
    await runWorkflow('spec-to-plan.js', { issue: 'example', stage: 'plna' }, () => {
      spawned += 1
      return { specExists: false, specApproved: false, planExists: false, evidence: 'none', related: [] }
    })
  } catch (e) {
    threw = e
  }
  check('invalid-stage-throws', 'an unknown stage is rejected', threw !== null, threw && threw.message)
  check('invalid-stage-spawns-nothing', 'and it is rejected before anything spawns', spawned === 0, spawned)
}

// The valid stages must still work, or the guard has just broken the workflow.
{
  const { result } = await runWorkflow('spec-to-plan.js', { issue: 'example', stage: 'plan' }, () => ({
    specExists: true,
    specApproved: false,
    planExists: false,
    evidence: 'status line reads draft',
    related: [],
  }))
  check('unapproved-plan-blocks', 'an explicit plan stage on an unapproved spec blocks', result.stage === 'blocked', result.stage)
}

console.log('\nreview-round: blocking findings come back as a handoff, not a silent re-review')

// The range is pinned to commits before any round runs, so every stub below
// answers the pin lane first. Nothing else about these cases changed: they
// still drive the default invocation, which still reviews and hands back.
const PIN = {
  resolved: [{ role: 'base', ref: 'main', sha: 'ba5e0000' }, { role: 'head', ref: 'HEAD', sha: 'facef00d' }],
  worktrees: [{ path: '/repo', head: 'facef00d', dirty: false, isMain: true }],
  commandsRun: ['git rev-parse'],
  couldNotRun: [],
}

// R04. coder fixed in its own worktree and the next round re-read the original
// range. The run must now stop and say what the lead has to do.
{
  const { result, calls } = await runWorkflow(
    'review-round.js',
    { range: 'main...feature/refresh', maxRounds: 3 },
    (prompt, opts) => {
      if (opts.label === 'pin refs') return PIN
      if (/git diff --stat/.test(prompt)) return { files: ['src/a.ts'], added: 10, removed: 2, commits: ['c'] }
      if (opts.agentType === 'claudecode-agents:reviewer')
        return { verdict: 'changes requested', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'bug' }] }
      return { findings: [] }
    },
  )
  check('fix-stops-the-run', 'a blocking verdict stops for a fix handoff', result.stopped === 'fix handoff required', result.stopped)
  const spawnedCoder = calls.some((c) => c.opts.agentType === 'claudecode-agents:coder')
  check('no-coder-spawned', 'and never commissions coder from inside the review', spawnedCoder === false, spawnedCoder)
  check(
    'fix-request-recorded',
    'the fix request names the range and the plan requirement',
    Boolean(result.history) && /new reviewed commit|fix commit|record the resulting/i.test(result.nextStep),
    result.nextStep,
  )
  check('range-reviewed-once', 'the same range is not reviewed twice in one run', result.roundsRun === 1, result.roundsRun)
}

// A clean verdict must still pass, or the workflow only knows how to stop.
{
  const { result } = await runWorkflow('review-round.js', { range: 'main...clean' }, (prompt, opts) => {
    if (opts.label === 'pin refs') return PIN
    if (/git diff --stat/.test(prompt)) return { files: ['src/a.ts'], added: 1, removed: 0, commits: ['c'] }
    if (opts.agentType === 'claudecode-agents:reviewer') return { verdict: 'approve', summary: 'fine', findings: [] }
    return { findings: [] }
  })
  check('clean-run-passes', 'a clean verdict still reports clean', result.stopped === 'clean', result.stopped)
}

console.log('\nreview-round: a fix is a commit git can find, or the run stops')

// The loop is back, and everything it branches on comes from git rather than
// from coder saying so. These cases drive the real script with stubbed agents,
// so what they pin is the decision procedure: which worktree counts as the fix,
// what disqualifies it, and what the next round is pointed at.
//
// A handoff, as coder actually returns it when spawned without a schema - a
// plain string, per the probe of 10 September 2026.
function handoff({ done = [], notDone = ['None'], unverified = ['None'], decisions = ['None'] } = {}) {
  const sec = (h, items) => '## ' + h + '\n' + items.map((i) => '- ' + i).join('\n')
  return [
    sec('Done', done.length ? done : ['None']),
    sec('Not done', notDone),
    sec('Unverified', unverified),
    sec('Decisions needed', decisions),
  ].join('\n\n')
}

const HINTS = ['worktree: /w/fix', 'base-commit: aaa1111', 'head-commit: bbb2222']

// A responder with sane defaults that each case overrides. `over` is consulted
// first, so a case says only what makes it different.
function responder(over = {}) {
  const state = { round: 0, prompts: [] }
  const fn = (prompt, opts = {}) => {
    const label = opts.label || ''
    const type = opts.agentType
    state.prompts.push({ prompt, label, type, opts })
    for (const [k, v] of Object.entries(over)) {
      if (k === 'match') continue
      if (label === k || (k === 'coder' && type === 'claudecode-agents:coder') || (k === 'reviewer' && type === 'claudecode-agents:reviewer')) {
        return typeof v === 'function' ? v(prompt, opts, state) : v
      }
    }
    if (label === 'pin refs') {
      return {
        resolved: [{ role: 'base', ref: 'main', sha: 'ba5e0000' }, { role: 'head', ref: 'HEAD', sha: 'facef00d' }],
        worktrees: [{ path: '/repo', head: 'facef00d', dirty: false, isMain: true }],
        commandsRun: ['git rev-parse'],
        couldNotRun: [],
      }
    }
    if (/git diff --stat/.test(prompt)) return { files: ['src/a.ts'], added: 10, removed: 2, commits: ['c'] }
    if (label === 'plan gate') return { planExists: true, planApproved: true, evidence: 'Status: approved' }
    if (type === 'claudecode-agents:reviewer') {
      state.round += 1
      return state.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'bug', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    }
    if (type === 'claudecode-agents:coder') return handoff({ done: HINTS.concat('fixed src/a.ts') })
    // Under fix: true the refutation stage is mandatory, so every FIX-based
    // case in this suite that says nothing about it still needs an answer -
    // one where nothing survived, since these cases are about the fix loop,
    // not about refutation.
    if (type === 'claudecode-agents:refuter') return handoff({ done: ['ran 12 mutations, all killed'] })
    if (label === 'verify fix') {
      return {
        headCommit: 'bbb2222',
        containsReviewedHead: true,
        dirty: false,
        filesChanged: ['src/a.ts'],
        commits: ['fix the bug'],
        worktreePath: '/w/fix',
        isMain: false,
        candidates: ['bbb2222'],
        worktrees: [
          { path: '/repo', head: 'facef00d', dirty: false, isMain: true },
          { path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false },
        ],
      }
    }
    return { lane: /lint/.test(prompt) ? 'lint and format' : /type/.test(prompt) ? 'types and build' : /test/.test(prompt) ? 'tests' : 'obvious smells', ran: ['x'], findings: [] }
  }
  fn.state = state
  return fn
}

const FIX = { range: 'main...feature/refresh', issue: 'x', fix: true, maxRounds: 3 }

// --- the default path is untouched ------------------------------------------

{
  const r = responder()
  const { result, calls } = await runWorkflow('review-round.js', { range: 'main...feature/refresh', issue: 'x' }, r)
  check('fix-is-opt-in', 'without fix:true a blocking verdict still just hands off', result.stopped === 'fix handoff required', result.stopped)
  check('opt-in-spawns-no-coder', 'and commissions nobody', calls.every((c) => c.opts.agentType !== 'claudecode-agents:coder'), calls.map((c) => c.opts.agentType))
}

// --- the transport, which is the whole reason this design exists -------------

{
  const r = responder()
  const { calls } = await runWorkflow('review-round.js', FIX, r)
  const coder = calls.find((c) => c.opts.agentType === 'claudecode-agents:coder')
  check('coder-spawned', 'with fix:true the fix run happens', Boolean(coder), false)
  // A schema on a fleet agent deletes last_assistant_message, and with it the
  // handoff gate, the "## Done" card comment, and the only working route to the
  // human queue. coder is the agent most likely to raise a real blocker.
  check('coder-carries-no-schema', 'and carries no schema, so its handoff still reaches the hook', coder && coder.opts.schema === undefined, coder && coder.opts.schema)
  // Identified by phase, not by "has a schema and no agentType" - the four
  // mechanical lanes match that too, so the loose version passed even with an
  // agentType put back on both git lanes.
  const gitLanes = calls.filter((c) => c.opts.phase === 'git state')
  check('git-lanes-have-no-agent-type', 'while the git bookkeeping runs on lanes the matcher skips', gitLanes.length >= 2 && gitLanes.every((c) => !c.opts.agentType), gitLanes.map((c) => c.opts.agentType))
}

// --- pinning ----------------------------------------------------------------

{
  const r = responder()
  const { calls } = await runWorkflow('review-round.js', FIX, r)
  const verdict = calls.find((c) => c.opts.agentType === 'claudecode-agents:reviewer')
  check('range-pinned-not-symbolic', 'the reviewed range is pinned to SHAs, so a moving branch cannot change it', verdict && /ba5e0000/.test(verdict.prompt) && /facef00d/.test(verdict.prompt), verdict && verdict.prompt.slice(0, 120))
}

{
  const r = responder({ 'pin refs': { resolved: [{ role: 'base', ref: 'main', sha: 'ba5e0000' }, { role: 'head', ref: 'HEAD', sha: '', error: 'unknown revision' }], worktrees: [], commandsRun: [], couldNotRun: [] } })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('pin-failure-stops-early', 'an unresolvable head stops before anything is reviewed', /does not resolve/.test(result.stopped || ''), result.stopped)
  check('pin-failure-spawns-nothing', 'and spawns no reviewer', calls.every((c) => c.opts.agentType !== 'claudecode-agents:reviewer'), calls.length)
}

// --- a failed scope pass is not an empty diff -------------------------------

{
  const r = responder({ match: 1 })
  const { result } = await runWorkflow('review-round.js', FIX, (p, o, s) => (/git diff --stat/.test(p) ? null : r(p, o, s)))
  check('scope-failure-is-not-nothing-to-review', 'a scope pass that returned nothing is its own stop, not a clean review', result.stopped === 'scope pass returned nothing' && result.verdict !== 'nothing to review', [result.stopped, result.verdict])
}

// --- the main checkout is never the fix -------------------------------------

// The probe of 10 September 2026 found both agents running in the MAIN checkout,
// because the repo had no remote and worktree.baseRef defaults to branching from
// origin/<default-branch>. If coder is not isolated the main worktree's HEAD
// moves, it becomes the only candidate, ancestry passes, and the run would
// accept a commit made on the human's real working branch - inverting coder's own
// invariant that anything on a shared branch is out of scope.
{
  const r = responder({
    'verify fix': {
      headCommit: '', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'], commits: [],
      isMain: true, candidates: [], worktrees: [{ path: '/repo', head: 'ccc3333', dirty: false, isMain: true }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('main-worktree-is-not-a-candidate', 'a fix found only in the main checkout stops the run', result.stopped === 'fix not isolated', result.stopped)
  check('main-worktree-reason-names-it', 'and says the run was not isolated', /main checkout|not isolated/i.test(JSON.stringify(result.fixRequest || {})), result.fixRequest)
}

// Fixing "absent" is not fixing "lying". The flat isMain guarded the very
// cross-check that exists to check it, so a payload contradicting itself in one
// object - flat field says not-main, its own worktree list says that exact path
// IS main - was believed on the flat claim.
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', worktreePath: '/w/fix', isMain: false, containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'],
      worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: true }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('worktree-list-beats-the-flat-claim', 'a flat isMain:false does not override a worktree list that says otherwise', result.stopped === 'fix not isolated', result.stopped)
}
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', worktreePath: '/w/fix', isMain: 'false', containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'],
      worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: 'true' }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('string-flags-read-the-same-way', 'and the strings "true"/"false" read the same as the booleans everywhere', result.stopped === 'fix not isolated', result.stopped)
}

// The fail-OPEN direction on the two flags that had no case for it. `dirty` was
// pinned by string-dirty-stops; these were not.
for (const [name, patch] of [
  ['string-false-not-descendant-stops', { containsReviewedHead: 'false' }],
  ['string-true-is-main-stops', { isMain: 'true' }],
]) {
  const r = responder({
    'verify fix': Object.assign({
      headCommit: 'bbb2222', worktreePath: '/w/fix', isMain: false, containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'],
      worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }],
    }, patch),
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check(name, 'a flag arriving as a string is read for what it says, not for being a string', /unverified fix|not isolated/.test(result.stopped || ''), result.stopped)
}

// The flat field is the fallback for when the list has no entry for that path,
// and that path has to stay open - a lane may report a commit in a worktree the
// list call did not cover. It is a fallback, not the primary evidence.
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', worktreePath: '/w/fix', isMain: false, containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'], worktrees: [],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('flat-flag-is-the-fallback', 'with no list entry for the path, an explicit isMain:false is accepted', result.stopped === 'clean', result.stopped)
}
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', worktreePath: '/w/fix', containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'], worktrees: [],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('no-evidence-either-way-stops', 'and with neither a list entry nor a flat answer, the run stops', result.stopped === 'fix not isolated', result.stopped)
}

// git's own path is what the list reports, and macOS resolves /tmp to /private/tmp.
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', worktreePath: '/w/fix/', containsReviewedHead: true,
      dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['bbb2222'],
      worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('trailing-slash-still-matches-the-list', 'a trailing slash does not stop the worktree list being found', result.stopped === 'clean', result.stopped)
}

// The dangerous shape, and the one a first pass at this test missed: the lane
// reports a REAL commit and says isMain. Mutation testing found that deleting
// the isMain guard in gateFix broke nothing, because the only case exercising
// it also had an empty headCommit, which the no-commit branch caught first.
{
  const r = responder({
    'verify fix': {
      headCommit: 'ccc3333', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'],
      commits: ['fix'], isMain: true, worktreePath: '/repo', candidates: ['ccc3333'],
      worktrees: [{ path: '/repo', head: 'ccc3333', dirty: false, isMain: true }],
    },
  })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('main-worktree-with-a-real-commit-stops', 'a real commit in the main checkout is still refused', result.stopped === 'fix not isolated', result.stopped)
  check('main-worktree-not-re-reviewed', 'and no second round reviews a commit on the shared branch', calls.filter((c) => c.opts.agentType === 'claudecode-agents:reviewer').length === 1, calls.filter((c) => c.opts.agentType === 'claudecode-agents:reviewer').length)
}

// isMain is optional in the verify schema, so a lane that simply omits it must
// not thereby prove isolation. The check is not "did anyone say main" but "can
// this run confirm the commit is NOT in the main checkout".
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'],
      commits: ['c'], worktreePath: '/w/fix', candidates: ['bbb2222'], worktrees: [],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('unconfirmed-isolation-stops', 'a lane that never says whether the worktree is the main one does not get the benefit of the doubt', result.stopped === 'fix not isolated', result.stopped)
}

// The reviewed head abbreviated is still the reviewed head. Adopting it would
// re-point round two at the code round one already reviewed - the original bug
// this whole loop was removed for.
{
  const r = responder({
    'verify fix': {
      headCommit: 'facef00', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'],
      commits: [], isMain: false, worktreePath: '/w/fix', candidates: ['facef00'], worktrees: [],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('abbreviated-reviewed-head-is-not-a-fix', 'an abbreviation of the reviewed commit is not a new commit', result.stopped === 'unverified fix', result.stopped)
}

// A reviewer's `blocking` is not guaranteed to be a boolean. Both naive
// readings are wrong, and one of them approves a merge.
{
  const r = responder({ reviewer: { verdict: 'request changes', summary: 's', findings: [{ blocking: 'true', file: 'src/a.ts', what: 'b', why: 'w' }] } })
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, r)
  check('string-true-is-blocking', 'the string "true" is a blocking finding, not an approval', result.stopped === 'fix handoff required', result.stopped)
}
{
  const r = responder({ reviewer: { verdict: 'approve', summary: 's', findings: [{ blocking: 'false', file: 'src/a.ts', what: 'b', why: 'w' }] } })
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, r)
  check('string-false-is-not-blocking', 'and the string "false" is not', result.stopped === 'clean', result.stopped)
}

// --- everything else that disqualifies a fix --------------------------------

const REJECTS = [
  ['no-commit-stops', { headCommit: '', candidates: [], containsReviewedHead: true, dirty: false, filesChanged: [], commits: [], worktrees: [] }, /no commit/i],
  ['ambiguous-candidates-stop', { headCommit: '', candidates: ['aaa1111', 'bbb2222'], containsReviewedHead: true, dirty: false, filesChanged: [], commits: [], worktrees: [] }, /more than one/i],
  ['not-descendant-stops', { headCommit: 'bbb2222', containsReviewedHead: false, forkPoint: 'origin1', dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, worktreePath: '/w/fix', worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }] }, /reviewed commit|forks at/i],
  ['dirty-worktree-stops', { headCommit: 'bbb2222', containsReviewedHead: true, dirty: true, filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, worktreePath: '/w/fix', worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }] }, /uncommitted|whole fix/i],
  ['untouched-files-stop', { headCommit: 'bbb2222', containsReviewedHead: true, dirty: false, filesChanged: ['docs/x.md'], commits: ['c'], isMain: false, worktreePath: '/w/fix', worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }] }, /touches none/i],
]
for (const [name, verify, reason] of REJECTS) {
  const r = responder({ 'verify fix': verify })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  const said = JSON.stringify(result.fixRequest || {}) + (result.stopped || '')
  check(name, 'a fix git cannot vouch for stops the run', /unverified fix|not isolated/.test(result.stopped || '') && reason.test(said), [result.stopped, said.slice(0, 160)])
}

// --- path forms the reviewer might report ------------------------------------

// A reviewer's `file` is model text. If "./src/a.ts" or "src/a.ts:88" fails to
// match "src/a.ts" from git, the untouched-files rule fires on every legitimate
// fix and the loop never closes.
for (const reported of ['./src/a.ts', 'src/a.ts:88']) {
  const r = responder({
    reviewer: (p, o, s) => {
      s.round += 1
      return s.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: reported, what: 'bug', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('path-forms-still-match', 'a reviewer path form still matches what git reports: ' + reported, result.stopped === 'clean', [reported, result.stopped])
}

// Escalation is the lead's policy, written down here rather than in the
// reviewer's body, so the return has to say honestly whether it fired.
{
  const r = responder({ match: 1 })
  const { result, calls } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, (p, o, s) =>
    /git diff --stat/.test(p) ? { files: ['src/session-token.ts'], added: 3, removed: 1, commits: ['c'] } : r(p, o, s),
  )
  const verdict = calls.find((c) => c.opts.agentType === 'claudecode-agents:reviewer')
  check('sensitive-paths-escalate', 'a sensitive path raises the verdict effort', verdict && verdict.opts.effort === 'max', verdict && verdict.opts.effort)
  check('sensitive-reported-honestly', 'and the run reports that it did, naming the file', result.sensitive === true && (result.sensitiveFiles || []).includes('src/session-token.ts'), [result.sensitive, result.sensitiveFiles])
}

// A suffix match is how an absolute path from a reviewer meets a repo-relative
// one from git. It must not become a licence to match on a bare basename: the
// gate's job is to check the fix touched the files the findings NAME, and
// "index.ts" matching every index.ts in the tree defeats exactly that.
{
  const r = responder({
    reviewer: (p, o, s) => {
      s.round += 1
      return s.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'index.ts', what: 'bug', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
    'verify fix': {
      headCommit: 'bbb2222', containsReviewedHead: true, dirty: false,
      filesChanged: ['packages/totally/unrelated/index.ts'], commits: ['c'], isMain: false,
      worktreePath: '/w/fix', candidates: ['bbb2222'], worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('bare-basename-does-not-match-anywhere', 'a finding named only by basename does not match an unrelated file of that name', result.stopped === 'unverified fix', result.stopped)
}

// ...while the form it exists for still works.
{
  const r = responder({
    'verify fix': {
      headCommit: 'bbb2222', containsReviewedHead: true, dirty: false,
      filesChanged: ['/Users/human/repo/src/a.ts'], commits: ['c'], isMain: false,
      worktreePath: '/w/fix', candidates: ['bbb2222'], worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }],
    },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('absolute-path-still-matches', 'an absolute path from one side still matches a repo-relative one from the other', result.stopped === 'clean', result.stopped)
}

// --- the loop actually closes ------------------------------------------------

{
  const r = responder()
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('clean-after-fix', 'a verified fix is re-reviewed and the run ends clean', result.stopped === 'clean' && result.roundsRun === 2, [result.stopped, result.roundsRun])
  check('fix-request-cleared', 'and the stale fix request is cleared once a fix is accepted', !result.fixRequest, result.fixRequest)
  check('fix-recorded', 'the accepted fix records the worktree and commit git found', result.fixes && result.fixes[0] && result.fixes[0].headCommit === 'bbb2222' && result.fixes[0].worktreePath === '/w/fix', result.fixes)
  // Round two must read the fixed code, not the original range.
  const round2 = calls.filter((c) => c.opts.agentType === 'claudecode-agents:reviewer')[1]
  check('range-repointed', 'round two reviews the fix commit and not the original range', round2 && /bbb2222/.test(round2.prompt) && !/feature\/refresh/.test(round2.prompt), round2 && round2.prompt.slice(0, 160))
  const round2Mech = calls.filter((c) => !c.opts.agentType && c.opts.schema && /Round 2/.test(c.prompt))
  check('mech-lanes-follow-the-fix', 'and the mechanical lanes run in the fix worktree, not the original checkout', round2Mech.length > 0 && round2Mech.every((c) => /\/w\/fix/.test(c.prompt)), round2Mech.length)
}

// --- git hints are hints -----------------------------------------------------

{
  const r = responder({ coder: handoff({ done: ['fixed it'] }) })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('hints-optional', 'a handoff with no hint bullets still verifies from git alone', result.stopped === 'clean', result.stopped)
}

{
  const r = responder({ coder: handoff({ done: ['worktree: /w/fix', 'head-commit: deadbee', 'fixed it'] }) })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  // The claimed sha appears in coderSaid verbatim whatever happens, so assert
  // on claimMismatch itself or this passes with the disagreement discarded.
  const mismatch = (result.fixes[0] || {}).claimMismatch || []
  check('hint-mismatch-git-wins', 'when coder claims a different commit, git decides', result.fixes[0] && result.fixes[0].headCommit === 'bbb2222', result.fixes[0])
  check('hint-mismatch-recorded', 'and the disagreement is recorded rather than discarded', mismatch.some((m) => /headCommit/.test(m) && /deadbee/.test(m)), mismatch)
}

// --- the tests lane is found by name, never by position ----------------------

{
  // Returned out of input order on purpose: parallel() ordering in the real
  // loader is unproven, and indexing into the array would settle the previous
  // fix's test claims from whatever lane happened to land third.
  const r = responder({})
  // Deliberately mislabelled by position: the lane whose PROMPT is the tests
  // lane reports lane 'obvious smells', and the lane sitting at input index 2
  // reports something else entirely. Only a lookup by the `lane` field gets
  // this right; indexing into the array settles the previous fix's test claims
  // from whatever landed third.
  const seen = {}
  const inner = (p, o, s) => {
    if (!o.agentType && o.schema && /Mechanical review pass/.test(p)) {
      const rnd = (/Round (\d+)/.exec(p) || [])[1] || '?'
      seen[rnd] = (seen[rnd] || 0) + 1
      if (seen[rnd] === 1) return { lane: 'tests', ran: ['pnpm test'], findings: [] }
      if (seen[rnd] === 3) return { lane: 'obvious smells', ran: ['x'], findings: [{ file: 'src/a.ts', what: 'smell' }] }
      return { lane: 'lint and format', ran: ['x'], findings: [] }
    }
    return r(p, o, s)
  }
  const { result } = await runWorkflow('review-round.js', FIX, inner)
  check('test-claims-settled-by-lane-name', 'the previous fix’s test claims are settled by the lane that says it is tests', result.fixes && result.fixes[0] && result.fixes[0].testResults && result.fixes[0].testResults.verified === true, result.fixes && result.fixes[0] && result.fixes[0].testResults)
}

// --- the plan gate -----------------------------------------------------------

{
  const r = responder({ 'plan gate': { planExists: true, planApproved: false, evidence: 'status line reads draft' } })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('no-plan-no-coder', 'an unapproved plan commissions nobody', calls.every((c) => c.opts.agentType !== 'claudecode-agents:coder'), calls.map((c) => c.opts.agentType))
  check('no-plan-stop-named', 'and stops for the plan, saying so', result.stopped === 'no approved plan' && /draft/.test(JSON.stringify(result.fixRequest || {})), [result.stopped, result.fixRequest])
}

{
  // The eval harness has never once applied a schema, so no boolean the
  // workflow branches on can be trusted to be a boolean.
  const r = responder({ 'plan gate': { planExists: true, planApproved: 'false', evidence: 'e' } })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('string-false-does-not-approve', 'the string "false" is not an approval', calls.every((c) => c.opts.agentType !== 'claudecode-agents:coder') && result.stopped === 'no approved plan', result.stopped)
}

{
  const r = responder({ reviewer: { verdict: 'lgtm', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] } })
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, r)
  // This case's blocking finding is what stops it; the coercion is pinned by
  // unrecognised-verdict-is-not-approved, which has no blocking finding at all.
  check('unknown-verdict-with-blockers-stops', 'an unrecognised verdict with blocking findings is not an approval', result.stopped !== 'clean' && result.approved === false, [result.stopped, result.approved])
}

// --- coder failures ----------------------------------------------------------

{
  const r = responder({ coder: null })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('coder-null-stops', 'a fix run that returned nothing stops rather than re-reviewing', /returned nothing/.test(result.stopped || ''), result.stopped)
  check('coder-null-skips-verify', 'and does not verify a run that did not happen', calls.every((c) => c.opts.label !== 'verify fix'), calls.map((c) => c.opts.label))
}

{
  const r = responder({ coder: handoff({ done: HINTS, decisions: ['Blocker: Refresh TTL unspecified'] }) })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  check('coder-blocker-stops', 'a blocker from the fix run stops the loop', result.stopped === 'coder raised a blocker', result.stopped)
  check('coder-blocker-recorded', 'and the blocker text is carried back', /Refresh TTL/.test(JSON.stringify(result.fixRequest || {})), result.fixRequest)
  // The human is being told they are needed. They must also be told where to look.
  check('coder-blocker-still-locates-the-work', 'and the run still says where the commits are', calls.some((c) => c.opts.label === 'verify fix'), calls.map((c) => c.opts.label))
}

// --- the cap is not an approval ----------------------------------------------

{
  const r = responder({ reviewer: { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] } })
  const { result, calls } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x', fix: true, maxRounds: 2 }, r)
  check('cap-not-approval', 'a run that hits the cap is not an approval', result.stopped === 'round cap' && !/approve/.test(result.verdict || ''), [result.stopped, result.verdict])
  const coders = calls.filter((c) => c.opts.agentType === 'claudecode-agents:coder').length
  check('cap-commissions-no-final-fix', 'and never commissions a fix it could not review', coders === 1, coders)
}

{
  const r = responder()
  const { result, calls } = await runWorkflow('review-round.js', { range: 'main...x', round: 4, maxRounds: 3, fix: true }, r)
  check('explicit-round-past-cap', 'a round past the cap spawns nothing at all', result.stopped === 'round cap' && calls.length === 0, [result.stopped, calls.length])
}

// --- every stop reason has somewhere to send the human -----------------------

{
  const seen = new Set()
  for (const [args, over] of [
    [{ range: 'main...x', issue: 'x' }, {}],
    [{ range: 'main...x', issue: 'x', fix: true }, {}],
    [{ range: 'main...x', issue: 'x', fix: true }, { coder: null }],
    [{ range: 'main...x', issue: 'x', fix: true }, { 'plan gate': { planExists: false, planApproved: false, evidence: 'no file' } }],
    [{ range: 'main...x', issue: 'x', fix: true, maxRounds: 2 }, { reviewer: { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] } }],
    [{ range: 'main...x', issue: 'x', fix: true }, { reviewer: null }],
  ]) {
    const { result } = await runWorkflow('review-round.js', args, responder(over))
    seen.add(result.stopped + '|' + (result.nextStep || ''))
  }
  const generic = [...seen].filter((s) => /The review is incomplete/.test(s))
  check('nextStep-covers-every-stop', 'no stop reason falls through to the generic next step', generic.length === 0, generic)
}

console.log('\nreview-round: what the caller reads, and what bounds the spend')

// `approved` is the field a caller gates a merge on, and until now nothing
// asserted it: hard-coding it true left all 65 checks green. Every stop reason
// gets pinned, not just the clean one.
{
  const cases = [
    [{ range: 'main...x', issue: 'x' }, {}, false, 'a blocking handoff'],
    [{ range: 'main...x', issue: 'x', fix: true }, { coder: null }, false, 'a fix run that returned nothing'],
    [{ range: 'main...x', issue: 'x', fix: true, maxRounds: 2 }, { reviewer: { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] } }, false, 'the round cap'],
    [{ range: 'main...x', issue: 'x', fix: true }, { reviewer: null }, false, 'a silent reviewer'],
  ]
  for (const [args, over, want, why] of cases) {
    const { result } = await runWorkflow('review-round.js', args, responder(over))
    check('approved-false-on-' + result.stopped.replace(/\s+/g, '-'), 'approved is false after ' + why, result.approved === want, [result.stopped, result.approved])
  }
  const { result: clean } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, responder({ reviewer: { verdict: 'approve', summary: 'fine', findings: [] } }))
  check('approved-true-only-when-approved', 'and true only when a reviewer actually approved', clean.approved === true, [clean.stopped, clean.approved])
}

// A verdict nobody recognises is coerced to the strict end, so the run must not
// then report itself approved. The output object contradicting itself is worse
// than either answer.
{
  const r = responder({ reviewer: { verdict: 'looks fine to me', summary: 's', findings: [] } })
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, r)
  check('unrecognised-verdict-is-not-approved', 'an unrecognised verdict does not come back as an approval', result.approved === false, [result.verdict, result.approved])
}

// The cap is the only thing bounding what this workflow spends. `|| 3` accepts
// any truthy value, so a string made every comparison NaN-false and the loop
// commissioned coder for ever.
{
  // A fresh commit every round, so nothing but the cap can end this loop.
  let n = 0
  const r = responder({
    reviewer: { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] },
    'verify fix': () => {
      n += 1
      return { headCommit: 'abc' + String(n).padStart(4, '0'), containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, worktreePath: '/w/' + n, candidates: ['x'], worktrees: [] }
    },
  })
  const { result, calls } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x', fix: true, maxRounds: 'three' }, r)
  check('non-numeric-cap-refused', 'a cap that is not a number stops the run rather than removing the bound', /cap/i.test(result.stopped || '') || result.roundsRun <= 3, [result.stopped, result.roundsRun])
  check('non-numeric-cap-is-bounded', 'and nothing runs away', calls.length < 40, calls.length)
}
{
  const r = responder()
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x', round: '2' }, r)
  check('string-round-is-a-number', 'a round number arriving as a string is still a number', typeof result.roundsRun === 'number' && (result.history[0] || {}).round === 2, result.history && result.history[0])
}

console.log('\nreview-round: the gate believes git, or it stops')

// Each of these is a well-formed verify result that the gate accepted.
const GATE_HOLES = [
  ['no-worktree-path-stops', { headCommit: 'bbb2222', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, candidates: ['bbb2222'], worktrees: [] },
    'a fix with no known location cannot be re-reviewed in the checkout that holds it'],
  ['ambiguous-with-a-sha-stops', { headCommit: 'bbb2222', containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, worktreePath: '/w/fix', candidates: ['bbb2222', 'ccc3333'], worktrees: [] },
    'a lane that names three candidates and then picks one is still guessing'],
  ['string-dirty-stops', { headCommit: 'bbb2222', containsReviewedHead: true, dirty: 'true', filesChanged: ['src/a.ts'], commits: ['c'], isMain: false, worktreePath: '/w/fix', candidates: ['bbb2222'], worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }] },
    'a boolean that arrived as a string is not a licence to read it as false'],
]
for (const [name, verify, why] of GATE_HOLES) {
  const { result } = await runWorkflow('review-round.js', FIX, responder({ 'verify fix': verify }))
  check(name, why, /unverified fix|not isolated/.test(result.stopped || ''), result.stopped)
}

// A blocking finding that names no file removed the file-touch rule entirely,
// so an empty commit satisfied it. "Each of those stops the run on its own" has
// to be true of this one too.
{
  const r = responder({
    reviewer: (p, o, s) => {
      s.round += 1
      return s.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, what: 'something is wrong', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
    'verify fix': { headCommit: 'bbb2222', containsReviewedHead: true, dirty: false, filesChanged: [], commits: [], isMain: false, worktreePath: '/w/fix', candidates: ['bbb2222'], worktrees: [{ path: '/w/fix', head: 'bbb2222', dirty: false, isMain: false }] },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('nameless-finding-stops', 'a fix cannot be checked against findings that name no file, so it is not adopted', result.stopped === 'unverified fix', result.stopped)
}

// The blocker path recorded the commit before the gate ran, so a dirty,
// non-descendant commit in the main checkout was reported as a fix and the human was
// pointed at it.
{
  const r = responder({
    coder: handoff({ done: HINTS, decisions: ['Blocker: which TTL?'] }),
    'verify fix': { headCommit: 'ccc3333', containsReviewedHead: false, dirty: true, filesChanged: ['docs/unrelated.md'], commits: ['c'], isMain: true, worktreePath: '/repo', candidates: ['ccc3333'], worktrees: [] },
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('blocker-does-not-bless-a-commit', 'a blocker run does not report an ungated commit as a fix', (result.history[0] || {}).fixed !== true, result.history)
}

// The design's central claim: everything the loop decides on comes from lanes
// the SubagentStop matcher skips. Asserting "some call has a schema and no
// agentType" was satisfied by the four mechanical lanes alone.
{
  const { calls } = await runWorkflow('review-round.js', FIX, responder())
  const gitLanes = calls.filter((c) => c.opts.phase === 'git state')
  check('git-lanes-are-the-ones-deciding', 'the pin and verify lanes both exist', gitLanes.length >= 2, gitLanes.length)
  check('git-lanes-carry-no-agent-type', 'and neither carries an agentType, so the handoff gate never fires on them', gitLanes.every((c) => !c.opts.agentType), gitLanes.map((c) => c.opts.agentType))
}

// coder writes paths the way a model writes paths.
{
  const r = responder({
    reviewer: (p, o, s) => {
      s.round += 1
      return s.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'a', why: 'w' }, { blocking: true, file: 'src/b.ts', what: 'b', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
    coder: handoff({ done: HINTS, notDone: ['rejected as wrong: `src/b.ts` - the finding misreads the guard'] }),
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  const b = (result.fixes[0] || {}).unresolvedFindings || []
  check('backticked-path-is-still-a-path', 'a disposition naming a backticked path is read as the refusal it is', b.length === 1 && b[0].disposition === 'rejected as wrong', b)
}
{
  const r = responder({
    reviewer: (p, o, s) => {
      s.round += 1
      return s.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'a', why: 'w' }, { blocking: true, file: 'src/b.ts', what: 'b', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
    coder: handoff({ done: HINTS, notDone: ['rejected as wrong: src/a.ts - it is fine, unlike src/b.ts which I did fix'] }),
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  const b = (result.fixes[0] || {}).unresolvedFindings || []
  check('disposition-does-not-bleed', 'a file mentioned in passing does not inherit another finding’s disposition', b.every((f) => f.file !== 'src/b.ts' || f.disposition === 'not attempted'), b)
}

console.log('\nreview-round: claims that were right, and now watched')

// The bug class this harness was built for - "a claim promoted to verified by
// agents failing to answer". The happy case was pinned; the contradicted one
// was not.
{
  const seen = {}
  const r = responder()
  const inner = (p, o, sState) => {
    if (!o.agentType && o.schema && /Mechanical review pass/.test(p)) {
      const rnd = (/Round (\d+)/.exec(p) || [])[1] || '?'
      seen[rnd] = (seen[rnd] || 0) + 1
      if (seen[rnd] === 1) return { lane: 'tests', ran: ['pnpm test'], findings: rnd === '2' ? [{ file: 'src/a.ts', what: 'a test fails over the fix' }] : [] }
      return { lane: 'lint and format', ran: ['x'], findings: [] }
    }
    return r(p, o, sState)
  }
  const { result } = await runWorkflow('review-round.js', FIX, inner)
  const t = (result.fixes[0] || {}).testResults || {}
  check('contradicted-test-claims-stay-unverified', 'a tests lane that reports findings does not confirm the fix', t.verified === false && /contradicted/.test(t.verifiedBy || ''), t)
}

// A reviewer that said nothing is not a clean round.
{
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, responder({ reviewer: null }))
  check('silent-reviewer-is-not-clean', 'silence from the reviewer is its own stop reason, not "clean"', result.stopped === 'reviewer returned nothing' && result.approved === false, [result.stopped, result.approved])
}

// A reviewer contradicting itself - approving while marking a finding blocking
// - is exactly why the flags are read the strict way.
{
  const r = responder({ reviewer: { verdict: 'approve', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'b', why: 'w' }] } })
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, r)
  check('approve-with-a-blocker-is-not-approved', 'an approve verdict beside a blocking finding is not an approval', result.approved === false && result.stopped === 'fix handoff required', [result.stopped, result.approved])
}

// Only the three named dispositions are dispositions. Anything else is a Not
// done bullet, and reporting it as coder's decision would put a word coder
// never chose in front of the next reviewer.
{
  const r = responder({
    reviewer: (p, o, sState) => {
      sState.round += 1
      return sState.round === 1
        ? { verdict: 'request changes', summary: 's', findings: [{ blocking: true, file: 'src/a.ts', what: 'a', why: 'w' }, { blocking: true, file: 'src/b.ts', what: 'b', why: 'w' }] }
        : { verdict: 'approve', summary: 'fixed', findings: [] }
    },
    coder: handoff({ done: HINTS, notDone: ['note: src/b.ts is fine as it stands'] }),
  })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  const u = (result.fixes[0] || {}).unresolvedFindings || []
  check('unknown-disposition-is-not-a-disposition', 'a Not done bullet that is not one of the three reads as not attempted', u.length === 1 && u[0].disposition === 'not attempted', u)
}

// The headline invariant, for the field that decides where every later lane
// runs: git says where the fix is, and coder's claim is recorded, not followed.
{
  const r = responder({ coder: handoff({ done: ['worktree: /w/coder-lied', 'head-commit: bbb2222', 'fixed it'] }) })
  const { result, calls } = await runWorkflow('review-round.js', FIX, r)
  const round2 = calls.filter((c) => /Round 2/.test(c.prompt))
  check('git-decides-where-the-fix-is', 'a coder claiming a different worktree does not redirect the next round', round2.length > 0 && round2.every((c) => !/coder-lied/.test(c.prompt)), round2.length)
  check('the-lie-is-recorded', 'and the disagreement is written down rather than dropped', ((result.fixes[0] || {}).claimMismatch || []).some((m) => /worktreePath/.test(m) && /coder-lied/.test(m)), (result.fixes[0] || {}).claimMismatch)
}

// A commit has to look like a commit.
{
  const r = responder({ 'verify fix': { headCommit: 'the-fix-branch', worktreePath: '/w/fix', isMain: false, containsReviewedHead: true, dirty: false, filesChanged: ['src/a.ts'], commits: ['c'], candidates: ['x'], worktrees: [] } })
  const { result } = await runWorkflow('review-round.js', FIX, r)
  check('headCommit-must-look-like-a-commit', 'a branch name is not a commit', result.stopped === 'unverified fix', result.stopped)
}

// The honesty fixes, which were themselves untested.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({ coder: handoff({ done: HINTS, decisions: ['Blocker: which TTL?'] }) }))
  check('no-next-round-is-promised', 'a run that stopped does not promise a next round that will not come', (result.unverified || []).every((u) => !/the next round re-runs/.test(u)), result.unverified)
}
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({ coder: handoff({ done: HINTS, decisions: ['Propose item: rename the helper', 'Propose memory: the TTL is 15 minutes'] }) }))
  check('coder-proposals-are-carried', 'coder cannot file its own proposals, so the run carries them back', (result.proposals || []).length === 2, result.proposals)
}

// An unrecognised verdict is reported as what it was read as, not as what
// arrived, or the field says one thing and the decision was another.
{
  const { result } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, responder({ reviewer: { verdict: 'lgtm', summary: 's', findings: [] } }))
  check('coerced-verdict-is-reported-coerced', 'the verdict field reports the reading the run acted on', result.verdict === 'request changes', result.verdict)
}

// The fix prompt used to tell coder to branch and commit FIRST and report the
// isolation check afterwards, which guaranteed that a non-isolated coder wrote
// to the main checkout before anything could notice. The gate can only ever
// detect that; the ordering is what makes a compliant coder never do it.
{
  const { calls } = await runWorkflow('review-round.js', FIX, responder())
  const fix = calls.find((c) => c.opts.agentType === 'claudecode-agents:coder')
  const p = fix ? fix.prompt : ''
  check('isolation-checked-before-anything-is-written', 'the fix prompt checks which checkout it is in before it writes', p.indexOf('rev-parse --git-dir') > -1 && p.indexOf('rev-parse --git-dir') < p.indexOf('git switch -c'), [p.indexOf('rev-parse --git-dir'), p.indexOf('git switch -c')])
  check('main-checkout-is-refused-not-reported', 'and says to write nothing at all if it is the main checkout', /Run no writing git command at all/.test(p), false)
}

console.log('\nreview-round: a round is clean when nobody could break it')

// Off by default. Nothing that runs today gets slower or more expensive
// without being asked for it.
{
  const { calls } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x' }, responder({ reviewer: { verdict: 'approve', summary: 'fine', findings: [] } }))
  check('refuter-is-opt-in', 'an ordinary review does not spawn a refuter', calls.every((c) => c.opts.agentType !== 'claudecode-agents:refuter'), calls.map((c) => c.opts.agentType))
}

// Reachable outside a loop, which is how the role earns its place before
// anything depends on it.
{
  const { calls } = await runWorkflow('review-round.js', { range: 'main...x', issue: 'x', refute: true }, responder({ reviewer: { verdict: 'approve', summary: 'fine', findings: [] } }))
  const r = calls.find((c) => c.opts.agentType === 'claudecode-agents:refuter')
  check('refute-flag-spawns-one', 'refute: true spawns a refuter on an ordinary review', Boolean(r), false)
  check('refuter-carries-no-schema', 'and it carries no schema, so its handoff still reaches the gate', r && r.opts.schema === undefined, r && r.opts.schema)
}

// A clean verdict is not the end of a loop round.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({
    reviewer: { verdict: 'approve', summary: 'fine', findings: [] },
    'Round 1 refutation': handoff({ done: ['ran 12 mutations, all killed'] }),
  }))
  check('clean-plus-unbroken-is-done', 'a clean verdict and a failed refutation together are done', result.stopped === 'clean' && result.approved === true, [result.stopped, result.approved])
}

// A surviving mutation is a blocking finding, whatever the reviewer said.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({
    reviewer: { verdict: 'approve', summary: 'fine', findings: [] },
    'Round 1 refutation': handoff({ done: ['ran 12 mutations'], decisions: ['Blocker: deleting the isMain guard kills no test'] }),
  }))
  check('a-survivor-is-not-clean', 'a surviving mutation stops the round even on an approving verdict', result.stopped !== 'clean' && result.approved === false, [result.stopped, result.approved])
  check('the-survivor-is-carried', 'and what survived is carried back', /isMain guard/.test(JSON.stringify(result)), result.refutation)
}

// Fails closed, like every other branch in this file.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({
    reviewer: { verdict: 'approve', summary: 'fine', findings: [] },
    'Round 1 refutation': null,
  }))
  check('silent-refuter-is-not-clean', 'a refuter that returned nothing is its own stop reason', result.stopped === 'refutation returned nothing' && result.approved === false, [result.stopped, result.approved])
}

// The other half of the same guard: a string that is empty, or all whitespace,
// is not evidence of anything either. Silence read as unbreakable is the exact
// failure this stage exists to prevent, whatever shape the silence takes.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({
    reviewer: { verdict: 'approve', summary: 'fine', findings: [] },
    'Round 1 refutation': '',
  }))
  check('empty-refuter-is-not-clean', 'a refuter that returned an empty string is its own stop reason too', result.stopped === 'refutation returned nothing' && result.approved === false, [result.stopped, result.approved])
}

// The whitespace half, which is the half that carries the guard. `''` is falsy
// with or without the .trim(), so it cannot tell the real check from a mutant
// that drops the trim - both `refutation === ''` and `!refutation` survive it,
// confirmed by running them. A string of blanks is the only input where the
// three differ, so it is the only input that pins the line.
{
  const { result } = await runWorkflow('review-round.js', FIX, responder({
    reviewer: { verdict: 'approve', summary: 'fine', findings: [] },
    'Round 1 refutation': '   \n\t  ',
  }))
  check('blank-refuter-is-not-clean', 'a refuter that returned only whitespace is its own stop reason too', result.stopped === 'refutation returned nothing' && result.approved === false, [result.stopped, result.approved])
}

console.log('\nevery workflow: fleet agents are spawned by their plugin name')
{
  // Issue 10. Installed as a plugin, the fleet's agents are registered as
  // `claudecode-agents:<name>`, and `agent({agentType: 'scout'})` fails on
  // launch with "agent type 'scout' not found". The built-in Plan and
  // general-purpose lanes carry no prefix, and a lane with no agentType is
  // deliberate (see review-round's header). This reads the scripts' own
  // constants rather than the recorded calls, so a workflow the harness never
  // drives is held to it too.
  const FLEET = ['lead', 'scout', 'spec-writer', 'coder', 'scripter', 'reviewer', 'ui-designer', 'tech-writer', 'researcher', 'fleet-steward', 'refuter']
  for (const file of ['spec-to-plan.js', 'review-round.js', 'deep-research.js']) {
    const src = readFileSync(join(WORKFLOWS, file), 'utf8')
    const bare = []
    for (const m of src.matchAll(/^const\s+[A-Z_]+\s*=\s*'([^']+)'/gm)) {
      if (FLEET.includes(m[1])) bare.push(m[1])
    }
    check('prefixed-agent-types:' + file, 'names every fleet agent by its plugin name', bare.length === 0, bare)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  console.log('A workflow branch approves the wrong thing, or has stopped doing its job.')
  process.exit(1)
}
console.log('The workflow branches decide on evidence, and still do the work they exist for.')
