# Hooks

The machinery that writes the board and enforces per-agent tool scoping. Four hooks, one shared library, no agent ever asked to remember anything.

| File | Event | What it does |
|---|---|---|
| `board-subagent-start.sh` | `SubagentStart` | Binds the subagent to a board item and moves it to **Doing** |
| `board-subagent-stop.sh` | `SubagentStop` | **Blocked by human** on a `Blocker:` line, a comment lifted from the handoff on every outcome, and the handoff-format check. Matched to the fleet agents only |
| `board-task-completed.sh` | `TaskCompleted` | Tests pass, **Done**. Tests fail, **Blocked** with the failure as a comment, and exit 2 |
| `enforce-agent-scope.sh` | `PreToolUse` | Denies tool calls that violate an agent's own Invariants |
| `lib/board.sh` | - | The calls to the `board` binary, state files, item-ref parsing |
| `hooks.json` | - | Registers the four above with Claude Code |

Board writes are design section 7. `permissions.deny` is session-scoped, so `enforce-agent-scope.sh` is the per-agent half that settings cannot express.

## Which board item

The design leaves it to this layer to know which item a spawn belongs to. The convention is below, and two files outside this layer carry it: `agents/lead.md` step 6 and the `board` skill, which both agents preload.

### The convention

**A checkout is focused on one item**, and the hooks read that focus. The lead sets it when it starts a phase, with the board server's `task_focus` tool; the human sets it by hand with `/work BD-12`. Either writes one line to `.boards/.focus` in the main checkout, which the shipped `.boards/.gitignore` keeps out of git. `SubagentStart` reads it ahead of the session's own state and the launch-time variable, so a focus set mid-session takes over from whatever the previous spawn was on.

Per checkout, not per session: two sessions in one checkout working two items need `[board:<id>]` on their completion tasks. `CLAUDECODE_AGENTS_BOARD_PAGE_ID` is read last; it is for a scripted launch, and nothing in the fleet asks anyone to set it.

A focused checkout moves its card on every subagent start, scouts and question-answering spawns included - most spawns are not board items, but the hook has no way to tell one from the other, only whether a focus is set. Clear the focus (`task_focus` with `clear: true`, or `/work clear`) when the work in front of you is not the item's.

Per-agent binding would need a supported correlation between the Agent tool's invocation and the subagent identity in the event, and none exists. A shared "latest prompt" file is not a substitute: two agents spawned together would race for the same line.

**Completion is separate from binding.** A session binding says which item is in flight; it never says that a given task finished it. Only a task whose `task_subject` carries `[board:<page-id>]` moves an item to Done, and that marker belongs on the one task representing completion of the whole tracked issue - never on an ordinary execution task, however much it contributed.

### What this layer depends on

1. **The focus convention lives in two files this layer does not own.** `agents/lead.md` step 6 carries the rule and `skills/board/SKILL.md`, "Telling the hooks which item", carries the full convention. If either is rewritten without that content, every board write becomes a no-op and the log fills with "no board item" lines.
2. **The binary is built by the installer.** `scripts/install-home.sh` builds it into `~/.local/bin/board`; the board is a directory of files in the repository, so there is no endpoint, no token and nothing for the installer to render. See "What breaks them".
3. **The `statuses` list in `.boards/config.yml` covers `To Do`, `Doing`, `Blocked`, `Blocked by human` and `Done`.** The `BOARD_COL_*` defaults below are that list character for character, so a tree `/init` wrote needs no configuration; a tree spelling one differently is a config edit, or an override in `board.env` (below) where the config cannot be changed.

### The fallbacks, in order

`SubagentStart`:

1. `Board-Item:` in the spawn prompt. **Unreachable** - the event carries no spawn prompt. Kept so that a runtime which starts sending one works without another change here.
2. `.boards/.focus` in the main checkout, via `board focus --show`.
3. The item this session most recently picked up (`sessions/<session_id>/last-item`).
4. `CLAUDECODE_AGENTS_BOARD_PAGE_ID` in the environment.
5. Nothing. No column moves, and the log says to call `task_focus`.

`SubagentStop`: the state file for this `agent_id`, then the environment variable, then nothing.

`TaskCompleted` has no `agent_id`, and it answers a different question - not "which item is in flight?" but "does this task finish that issue?":

1. A `[board:<page-id>]` marker anywhere in `task_subject`.
2. Nothing. The test gate still runs; no column moves.

There is deliberately no fallback. The session's last item and the environment variable both answer the in-flight question, and an issue with twenty execution tasks would reach Done on the first one. Moving nothing is the better failure: a card that silently reads Done is taken as finished work; a card that has not moved is visibly not finished. Mark the one task that represents completing the whole issue, and only that one.

### State files

```
${XDG_STATE_HOME:-~/.local/state}/claudecode-agents/
  sessions/<session_id>/agents/<agent_id>   page_id, agent_type, bound_at
  sessions/<session_id>/last-item           the most recent page id
  archives/<session_id>/<stamp>-<agent>.md  the whole text of a comment that had
                                            to be cut, written only when one is
  log/hooks.log                             every line the hooks log
  disabled                                  if this file exists, no board writes
```

Directories are 0700 and files 0600. Nothing here is secret, but nothing here is anyone else's business either. Nothing prunes old sessions; they are a few hundred bytes each. An archive is tens of kilobytes and rare - see Comment length below for when one is written and why it is here rather than in the agent's working directory.

## Configuration

Everything has a default. `~/.config/claudecode-agents/board.env` overrides them and is sourced if it exists - a 0700 directory already out of reach of every agent via `permissions.deny`.

```sh
# ~/.config/claudecode-agents/board.env
BOARD_COL_TODO="To Do"
BOARD_COL_DOING=Doing
BOARD_COL_BLOCKED=Blocked
BOARD_COL_BLOCKED_HUMAN="Blocked by human"
BOARD_COL_DONE=Done

BOARD_COMMENT_MAX_CHARS=8000        # how much of a card comment survives; see below

CLAUDECODE_AGENTS_TEST_COMMAND=""       # empty means fall through to the marker file
CLAUDECODE_AGENTS_TEST_GATE=lenient     # or "strict"
CLAUDECODE_AGENTS_TEST_TIMEOUT=300
CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE=3600
CLAUDECODE_AGENTS_REPO=""               # the claudecode-agents working copy, for fleet-steward
```

A column is a status in `.boards/config.yml`, and a move is one `board task edit <id> -s <status>` against the repository, preceded by a `board task view <id> --json` that resolves the identifier and confirms the item exists. The binary finds the board itself - the main checkout's `.boards/` of the repository containing the hook's cwd, through `git rev-parse --git-common-dir`, never a linked worktree's committed copy - so the library's only job is to run it in the hook's cwd (`BOARD_CWD`, exported from the event's `cwd`). `CLAUDECODE_AGENTS_BOARD_ROOT` is honoured when it is inherited, which is how the contract suite aims the hooks at a throwaway tree, but nothing in the fleet sets it. There is no default root: outside a repository the binary says `no board here`. The binary is reached through one shim, `board/board.sh` in the plugin, which tries `~/.local/bin/board`, then `bin/board` beside itself, then `bun src/cli.ts`. A failure arrives as an exit code with its own stderr, so there is no body to second-guess: a non-zero exit is logged as `board <cmd> failed (exit N): ...` and swallowed.

Two escape hatches:

- `CLAUDECODE_AGENTS_BOARD=off`, or `touch ~/.local/state/claudecode-agents/disabled`, turns every board write into a log line. The test gate and the handoff check still run.
- `BOARD_DRY_RUN=1` logs what would have been written without calling the binary, and prints the comment it would have posted to stderr in full rather than first line only, so a cut comment can be read as well as counted. This is how the tests below work. A dry run still writes an archive when a comment is cut, so the note never names a file that does not exist.

## What the card says

A column on its own is a status light. Every transition also puts a comment on the row, so a card answers what happened without anyone opening a transcript.

The text is lifted from things that already exist and are already mandatory: the four handoff sections, the `status` field the harness sends, and, for the test gate, the command it ran and the output it got. **Nothing is added to the handoff format for this and nothing should be.** The format is strict and four implementations agree over a 28-case fixture; an optional fifth heading or a fourth typed prefix would decay the first time an agent forgot it, which is the whole reason the board is machinery rather than manners.

| Transition | Hook | The comment |
|---|---|---|
| Done | `SubagentStop`, clean success | `Done. <agent> finished with no blockers. From "## Done" in its handoff:` then the `## Done` items |
| Blocked, run failed or cancelled | `SubagentStop` | `Blocked. <agent> finished with status <status>. From "## Not done" in its handoff:` then the `## Not done` items |
| Blocked, no readable handoff | `SubagentStop` | `Blocked. <agent> finished with status <status>. Its handoff carried no readable "## Not done" detail, so the status is all this card can say.` |
| Blocked by human | `SubagentStop` | `Blocked by human. <agent> raised N blocker(s). From "## Decisions needed" in its handoff:` then the blocker lines |
| Blocked, tests failed | `TaskCompleted` | `Blocked. The test gate failed on "<task title>", so the task could not be marked complete.` then the command, its exit code and the tail of its output |

The two Blocked rows for `SubagentStop` are written for a `status` field the runtime does not send (item 15 below), so they are unreachable today and kept for forward compatibility.

One shape throughout: a headline naming the transition and where the detail came from, a blank line, then the lines themselves.

Three things worth knowing:

- **The Done comment is posted by `SubagentStop`, which moves no column.** `TaskCompleted` owns the move to Done, and it never sees a handoff. The only moment the agent's own account of the work exists is when the subagent stops, so that is where it is read and put on the card. Stashing the section for `TaskCompleted` to read later would land a stale summary on whichever row that hook resolved.
- **A section of nothing but `- None` earns no comment.** The extractor drops `- None`, and a caller with an empty body posts nothing at all. The failure path is the exception - it always comments, because the status itself is the news even when the handoff says nothing.
- **The failure path reads a handoff nobody validated.** The format check runs on success only. `extract_section` is deliberately tolerant: it returns the `- ` lines it can find and nothing if it finds none, which is what puts the agent-type-and-status fallback on the card.

### Comment length

A comment is one markdown body in the task file and the board would happily store the lot, so the cap here is for the reader rather than the backend: a card comment is a summary, and the whole text of a long run belongs in the archive, not on the card.

`board_cap_comment` cuts to `BOARD_COMMENT_MAX_CHARS` (default 8000), with `BOARD_COMMENT_HARD_MAX` clamping an over-generous `board.env` value. The cut happens inside `jq`, which counts Unicode codepoints, so a multi-byte character is never split in half. No comment is ever posted empty.

### Where the overflow goes

Nothing writes a run transcript, and `SubagentStop` holds the whole handoff in a shell variable, so the part of a comment that does not fit would be lost. A comment that has to be cut is therefore archived whole first, and the note names the file it was archived in:

```
[Cut to fit a board comment. The other 11750 characters, and this text in full,
are in ~/.local/state/claudecode-agents/archives/sess-91/20260908T140020Z-coder.md]
```

```
${XDG_STATE_HOME:-~/.local/state}/claudecode-agents/archives/<session_id>/<UTC stamp>-<agent>.md
```

Session first, because the session id is what a person has in hand when they come back to a run. Agent and timestamp in the name, because that is what tells two cut comments in one session apart without opening either; a hook with no agent to name, which means `TaskCompleted`, uses its own name instead. The file carries a header - when, which hook, which agent, what status, which session, which board item - and then the whole comment under `## Full comment text`. Directory 0700 and file 0600, the same umask discipline as the session state files.

Four things it does deliberately:

- **Only when a comment is actually cut.** A comment that fits writes no file. A file per run would be a landfill nobody reads.
- **Never in the hook's `cwd`.** `coder` runs with `isolation: worktree`, so its cwd is a git worktree under `.claude/worktrees/` that is deleted when the session is cleaned up, uncommitted work and all. An archive written there would vanish with the very thing it exists to outlive. The state directory is outside every worktree and outlives all of them.
- **Fails soft, like every other board write.** If the directory cannot be made or the file cannot be written, the reason is logged, the note says the overflow was dropped and could not be archived, the cut comment still goes on the card, and the hook still exits 0. Archiving is not a new way to break a session and it is not a third exit 2.
- **Writes nothing when the board is off.** `CLAUDECODE_AGENTS_BOARD=off` posts no comment, so there is no note for an archive to be the rest of.

`TaskCompleted` is covered by the same code, because the archiving lives in `board_cap_comment` and every comment goes through it. Its own comment cannot reach the default cap - the test detail is at most fifteen lines cut to 200 characters each, so about 3KB with the headline - and it will only ever cut if `board.env` lowers `BOARD_COMMENT_MAX_CHARS`. It labels its run anyway, so if that day comes the archive says which session and which verdict rather than nothing.

Nothing prunes the archives and nothing backs them up. A run worth keeping permanently gets promoted into the repo by a human; the `compound` skill says where.

## The handoff-format check

### Who it applies to

`SubagentStop` takes a matcher and the matcher is the agent type, so `hooks.json` registers this hook against the ten fleet agents and nothing else:

```
^(claudecode-agents:)?(lead|scout|spec-writer|coder|reviewer|ui-designer|tech-writer|researcher|fleet-steward|refuter)$
```

The optional prefix is there because a plugin agent arrives as `scout` or as `claudecode-agents:scout` depending on how it was named.

Without the matcher the gate would fire on every subagent, including the built-in `Plan` and `general-purpose` lanes the workflows spawn. Those lanes never preload the `handoff` skill and are asked for structured JSON, so every one of them would fail the check, hit exit 2 and be told to re-emit a handoff it was never asked for. Scoping the registration is the right fix rather than a special case inside the validator, because a lane that returns JSON is not a malformed handoff - it is not a handoff at all.

The cost is that a non-fleet subagent never moves a bound board item to Blocked when it fails. That only matters for a spawn bound to an item, and the lead only binds those to fleet agents.

A second cost, worth stating plainly because two things depend on it: an `agentType`-less lane is outside *both* hooks. The `SubagentStop` matcher skips it, and no branch of `enforce-agent-scope.sh` claims it either, since every branch there keys on an agent name. So when `review-round.js` tells its git and mechanical lanes "read-only git only", that sentence is an instruction to a model and not a boundary anything enforces. The four mechanical lanes and `review-round`'s two git lanes are all in that position. The trade is deliberate: those lanes need `git worktree list`, `merge-base` and `rev-parse`, and widening `scout`'s or `reviewer`'s allowlist to cover them would weaken a role boundary for every run rather than for the one workflow that needs it.

The rule that falls out of all this, worth keeping whenever a workflow is written: **give a fleet agent a schema only where its handoff is worth nothing.** A spawn's `schema` decides whether the gate, the `## Done` card comment and the `Blocker:` route to the human queue exist for that run at all.

### What it checks

`board-subagent-stop.sh` validates `last_assistant_message` against `skills/handoff/SKILL.md` and exits 2 if it does not parse, which stops the subagent stopping and hands it the list of problems. The anchors come from the skill, quoted rather than reinvented. Every line is right-trimmed before any anchor sees it - trailing whitespace is invisible in rendered markdown and models emit it habitually (two trailing spaces is the hard-line-break idiom), so it never changes what a line means; leading whitespace still does:

| Rule | Regex | Line in `skills/handoff/SKILL.md` |
|---|---|---|
| Section headings | `^## (Done\|Not done\|Unverified\|Decisions needed)$` | "Anchor: `^## (Done\|Not done\|Unverified\|Decisions needed)$`" |
| Any level-2 heading | `^## ` | "Use no other level-2 heading anywhere in the final message." |
| An item | `^- ` | "Every item is one markdown list item starting `- ` at column 0." |
| A typed line | `^- (Blocker\|Propose item\|Propose memory): ` | "Anchor: `^- (Blocker\|Propose item\|Propose memory): `" |
| An empty section | `^- None$` | "An empty section contains exactly one line: `- None`." |
| Where a typed line may appear | `^- (Blocker\|Propose item\|Propose memory): ` under `## Decisions needed` only | "A typed line belongs under `## Decisions needed` and nowhere else." |
| A blank line inside a section | a blank line with another item after it, before the next heading | "No blank line inside a section." |

What it rejects: a missing, duplicated or out-of-order heading; any other H2; an empty section; a line under a section that does not start with `- ` at column 0, which is also how "the handoff is the last thing in the message" is enforced; an untyped line under Decisions needed; a typed line under any heading other than Decisions needed; a blank line between two items in the same section; and `- None` mixed with real items.

What it tolerates on purpose:

- **Prose before `## Done`.** The skill says the handoff is the last thing in the message, not the only thing. Nothing above the first heading is parsed at all, which is why an agent may name a prefix in prose while explaining what it did with someone else's handoff.
- **A blank line before the next heading.** That one is ordinary markdown and is what the skill's own example does. A blank line with another item after it is not, and is rejected.
- **A failed or cancelled run.** The check only runs when `status` is `success`. Exit 2 on a cancellation would refuse to let a cancelled subagent stop, which is the opposite of what a cancellation means. A failed run is not asked to reformat itself.

Blockers are extracted from the Decisions needed section only, not from the whole message, and the validator rejects a typed line found under any other heading, so a stray one under Done is caught by the validator instead of quietly parking a false alarm in the human queue. Rescuing it silently would be worse than refusing it: a misplaced blocker means the agent has the format wrong, and the human only learns that if the run is sent back.

### One rule set, two implementations

`evals/lib/handoff-check.sh` is the CI gate and applies the same rules to the final assistant message of an eval run. The two are held identical by `evals/lib/handoff-parity.sh`, which runs both over every case in `evals/fixtures/handoff-cases/` and fails if a verdict ever differs:

```sh
evals/lib/handoff-parity.sh        # verdicts only
evals/lib/handoff-parity.sh -v     # and each side's reasons
```

Change one side and run it. They differ only in wording and in how many complaints each lists for the same message; the verdict is the contract.

## The test gate

`TaskCompleted` has to decide whether tests pass, and nothing in the hook input tells it. Resolved in this order:

1. **`CLAUDECODE_AGENTS_TEST_COMMAND`.** Run in `CLAUDE_PROJECT_DIR` (or the hook's `cwd`), wrapped in `timeout` if one is on the PATH. Exit 0 is a pass. The last 15 lines of output go on the Blocked item as a comment.
2. **A marker file**, `<project>/.claude/test-status`, overridable with `CLAUDECODE_AGENTS_TEST_STATUS_FILE`. First line `pass` or `fail`, the rest is detail that becomes the comment. Ignored if it is older than `CLAUDECODE_AGENTS_TEST_STATUS_MAX_AGE` (default one hour), so yesterday's green run cannot wave through today's work.
3. **Neither.** `CLAUDECODE_AGENTS_TEST_GATE=lenient`, the default, moves the item to Done and logs that the gate was not configured. `CLAUDECODE_AGENTS_TEST_GATE=strict` blocks completion instead.

Lenient is the default because a gate that refuses every task on a fresh install is a gate nobody keeps. Set it to strict on the repos where the gate is the point. Either way the board write happens before the exit, so blocking a completion never costs the board its update.

## Per-agent tool scoping

`enforce-agent-scope.sh` switches on `agent_type` and denies with `permissionDecision: "deny"`, quoting the invariant that was violated. Every agent without a rule here, and the main session, is untouched.

**`spec-writer`** - "Never write anywhere except under `docs/specs/`". Any `Write`, `Edit`, `MultiEdit` or `NotebookEdit` whose path does not resolve inside a `docs/specs/` directory is denied. Paths are made absolute against `cwd` and normalised lexically first, so `docs/specs/../../etc/passwd` does not slip through.

**`scout`** - "Never edit, write or create a file" and the Bash allowlist from its Invariants. Write tools are denied outright. A Bash command is denied unless every segment of it starts with `ls`, `cat`, `head`, `tail`, `sed`, `wc`, `file`, `rg`, `grep`, `find`, `git`, `cd`, `pwd`, `echo` or `true`, with:

- `sed` requiring `-n` and rejecting `-i`, because the invariant says `sed -n`
- `find` rejecting `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete` and the `-f*` actions, which run or write things
- `git` limited to `log`, `show`, `blame`, `diff` and `ls-files`
- redirection (`>`, `>>`), command substitution (`$(`, backticks) and process substitution denied anywhere in the command

`cd`, `pwd`, `echo` and `true` are on the allowlist and are **not** in scout's Invariants. They are there because none of them can change state and all of them turn up inside otherwise legal commands. That is the only addition; if you would rather it were exactly the invariant, delete them from `SCOUT_ALLOWED_CMDS`.

Two deliberate softenings so the hook is not merely annoying: quoted spans are stripped before the redirection scan, so `grep -rn '=>' src/` is allowed, and `2>/dev/null` is removed before that scan, because discarding output is not a state change.

**`fleet-steward`** - "Never touch anything outside the `claudecode-agents` working copy" and "never run a git command that rewrites shared history". Write tools are denied outside the claudecode-agents repo root, and `git merge`, `rebase`, `reset`, `filter-branch`, any force-push, `push --delete`, `push --mirror` and any push naming `main` or `master` are denied. Pushing a feature branch and opening a pull request are allowed, because that is the whole job.

The claudecode-agents repo root is `CLAUDECODE_AGENTS_REPO` if set. Otherwise it is derived from the plugin's own location: if the plugin sits at `<root>/claudecode-agents` and `<root>/.claude-plugin/marketplace.json` exists, `<root>` is it. If neither works, the check degrades to "the path contains a `claudecode-agents` directory" and the deny message says to set `CLAUDECODE_AGENTS_REPO`.

**`reviewer`** - "Never edit, write or create a file", "Never run a git command that writes ... Read-only git only" and "Never run tests, builds or installs". Write tools are denied outright, which is the one that matters: design section 4 singles the reviewer out because a review agent that edits makes the diff the human approves a different diff from the one they read. `git` is an allowlist - `log`, `show`, `blame`, `diff`, `ls-files`, `status`, `shortlog`, `describe`, `rev-parse`, `rev-list`, `cat-file`, `grep`, `whatchanged` - because "read-only git only" is wider than the seven verbs the invariant names and a denylist would miss the eighth. Test runners, build tools and package managers are a denylist, so the reviewer still reads the tree with `rg`, `cat` and `find`.

**`ui-designer`** - "Never run a git command that writes, and never install anything into the product repo". The same read-only `git` allowlist. Installs are matched on the verb rather than the command, because "use Bash only to build, serve or screenshot a prototype" is the job: `npx serve` and `npm run build` are allowed, `npm install`, `pnpm add`, `pip install`, `cargo add`, `go get` and `brew install` are not.

**`refuter`** and **`coder`** have their own branches: the refuter's write tools are confined to outside the project, and coder's writing git verbs are confined to a linked worktree (item 18 below).

Write destinations go through `lib/check-write-scope.py`, which runs before the role dispatch for the roles that hold `Write`. A glob on a lexically normalised path answers the wrong question three ways - `*/docs/specs/*` matches *any* project's specs directory, `..` collapsed without asking the filesystem lets a symlinked `docs/specs` resolve to itself, and `Write` replaces a source file as completely as `Edit` does - so the checker resolves symlinks on the deepest existing ancestor and anchors to this project:

| Role | May write |
|---|---|
| `spec-writer` | `<project>/docs/specs/**` |
| `tech-writer` | `<project>/docs/**` (`.md`, `.mdx`, `.txt`) and a Markdown file at the project root |
| `ui-designer` | `<project>/prototypes/**` and `<project>/docs/runs/**` |
| `fleet-steward` | anywhere inside `$CLAUDECODE_AGENTS_REPO` |

`docs/runs/**` is open to `ui-designer` on purpose: a commissioned run article is an authorised deliverable. Set `CLAUDECODE_AGENTS_OUTPUT_FILES` in the launching environment - never in agent-authored content - to narrow `tech-writer` or `ui-designer` to an exact list of commissioned files:

```json
{"tech-writer": ["README.md", "docs/adr/001-session-refresh.md"]}
```

It only narrows. Listing a path outside the role's default scope does not grant it, and two agents needing different lists need a binding keyed by agent identity rather than one shared, widened list.

This hook **fails open**. Bad input, a missing `jq`, an unexpected error: it logs and allows. Be clear about what that costs. For the per-agent half there is no second lock, because that is precisely the half `permissions.deny` cannot express: a deny rule strong enough to stop `scout` writing stops `coder` writing too. The session-wide half - credentials, `curl`, `sudo`, destructive git verbs - is denied in `home/settings.json` and by the sandbox whatever this hook does. A shell-command allowlist parsed with `sed` and `awk` is a speed bump for an agent that has misread its brief, not a sandbox for one that is trying to get out. `/sandbox` is the sandbox.

## Security

- **There is no secret here.** The board is files in the repository reached by a local binary, so no hook reads a token, the installer renders none, and no hook makes a network call. **No hook ever calls `op`.** Design section 12 is explicit about why: it adds latency to every subagent start and stop, and a locked `op` silently stops the board updating.
- `lib/board.sh` runs `set +x` on load. Nothing here is secret, but a traced hook floods the transcript with a hundred lines nobody asked for.
- The board is the main checkout's `.boards/` of the repository containing the hook's `cwd`, resolved by the binary through `git rev-parse --git-common-dir`, so a hook fired inside a coder's worktree writes to the main checkout and never to the worktree's committed copy. `CLAUDECODE_AGENTS_BOARD_ROOT` is honoured when set - the contract suite depends on that - and is as trusted as anything else the launching environment hands a hook. There is no default root: outside a repository the binary says `no board here` and the hook logs it and exits 0.
- `board.env` is sourced, which is code execution. It lives in a 0700 directory that `permissions.deny` and the sandbox `denyRead`/`denyWrite` lists already keep away from every agent. If something else can write that directory, the machine has larger problems than the board.

## Failure behaviour

Every board write fails soft: log to stderr, exit 0. The binary being unbuilt, the repository being absent, `jq` not being installed, the item ref being wrong - none of it stops a session.

A board write is also a commit, made by the binary in the main checkout, pathspec-limited to `.boards`, on whatever branch is checked out there, never pushed. The pathspec is a limit on which paths are recorded, not on staged versus unstaged: everything outside `.boards` is left alone, and anything inside it, staged or not, goes with the next board commit. A commit that cannot be made - a locked index after three retries, a checkout mid-rebase, an ignored `.boards`, `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` - leaves the file write standing and is logged by the binary to stderr, which `board_cli` captures into `hooks.log`. Look there for `commit skipped` when a card moved but `git log -- .boards` shows nothing.

Exactly two things exit 2, and each for its own reason:

1. `SubagentStop`, when a successful run's handoff does not parse.
2. `TaskCompleted`, when the tests fail (or when the gate is strict and no result is available).

Neither exits 2 because the board was unreachable. That separation is the point: a board that cannot be written is an inconvenience, a coder marking itself done on a red suite is not.

## Testing

The scripts read JSON on stdin and are ordinary shell, so drive them by hand. `BOARD_DRY_RUN=1` keeps the binary from being called at all, and pointing the config and state directories somewhere disposable keeps the rest off your real board. `CLAUDECODE_AGENTS_BOARD_ROOT` pointed at a throwaway tree is the belt to that braces if you want the calls to happen for real.

```sh
cd claudecode-agents/hooks
export CLAUDECODE_AGENTS_CONFIG_DIR=/tmp/ca/config
export CLAUDECODE_AGENTS_STATE_DIR=/tmp/ca/state
export BOARD_DRY_RUN=1
mkdir -p "$CLAUDECODE_AGENTS_CONFIG_DIR"

# 1. spawn: binds the agent and moves the item to Doing
jq -n '{session_id:"s1",agent_id:"a1",agent_type:"coder",
        instructions:"Board-Item: BD-12\nGo."}' \
  | ./board-subagent-start.sh

# 2. stop, with a blocker: Blocked by human, plus a comment
jq -n '{session_id:"s1",agent_id:"a1",agent_type:"coder",status:"success",
        last_assistant_message:"## Done\n- x\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- Blocker: 7 days or 30?\n"}' \
  | ./board-subagent-stop.sh; echo "exit $?"

# 2b. stop, clean success: no column moves, the "## Done" section is commented
jq -n '{session_id:"s1",agent_id:"a1",agent_type:"coder",status:"success",
        last_assistant_message:"## Done\n- Added rotation in src/api/auth.ts.\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- None\n"}' \
  | ./board-subagent-stop.sh; echo "exit $?"

# 3. stop, malformed handoff: exit 2 and the reasons on stderr
jq -n '{session_id:"s1",agent_id:"a1",agent_type:"coder",status:"success",
        last_assistant_message:"## Done\n- x\n\n## Decisions needed\n- maybe?\n"}' \
  | ./board-subagent-stop.sh; echo "exit $?"

# 3b. stop, a Blocker line in the wrong section: also exit 2, and the message
#     names the line and the section it turned up under
jq -n '{session_id:"s1",agent_id:"a1",agent_type:"coder",status:"success",
        last_assistant_message:"## Done\n- Blocker: 7 days or 30?\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- None\n"}' \
  | ./board-subagent-stop.sh; echo "exit $?"

# 4. the test gate, failing: Blocked, then exit 2
CLAUDECODE_AGENTS_TEST_COMMAND='exit 1' jq -n '{session_id:"s1",cwd:"/tmp",task_id:"t1",
        task_subject:"Wire it [board:BD-12]"}' > /tmp/ca/in.json
CLAUDECODE_AGENTS_TEST_COMMAND='exit 1' ./board-task-completed.sh < /tmp/ca/in.json; echo "exit $?"

# 5. scoping: a deny prints JSON, an allow prints nothing
jq -n '{agent_type:"scout",tool_name:"Bash",cwd:"/tmp",tool_input:{command:"npm install"}}' \
  | ./enforce-agent-scope.sh | jq -r '.hookSpecificOutput.permissionDecisionReason'
```

Step 1 uses the spawn-prompt route because it is the one a hand-driven test can reach without a repository; in a real session the binding comes from `.boards/.focus`.

Watch for the env-prefix trap in step 4: `VAR=x jq ... | ./hook.sh` sets the variable for `jq`, not for the hook. Export it, or write the JSON to a file first as above.

Expected exit codes: 0 everywhere except steps 3, 3b and 4, which are 2. Every run appends to `$CLAUDECODE_AGENTS_STATE_DIR/log/hooks.log`.

For the format check specifically, `evals/lib/handoff-parity.sh` drives this same script over a fixture set that covers valid handoffs, typed lines in each of the three wrong sections, blank lines, missing and out-of-order headings, a stray H2, untyped lines and trailing prose. It is faster than writing the JSON by hand and it checks the CI gate at the same time.

To watch the real thing, run Claude Code with `--debug` - hook stderr goes to the debug log - and `tail -f ~/.local/state/claudecode-agents/log/hooks.log`.

## What breaks them

- **`jq` missing.** It is checked and named in the log. The board stops updating; the session does not stop. macOS ships without it.
- **No focus set.** Everything runs, nothing moves, and `SubagentStart` logs that nothing is focused in this checkout and says to call `task_focus` or run `/work`. This is the most likely failure and the log line for it is explicit.
- **Column names that do not match.** The log carries the binary's own complaint that no such status exists. Fix `statuses` in `.boards/config.yml`, or point `BOARD_COL_*` in `board.env` at the name that tree uses; do not rename the fleet's columns to match the code.
- **No binary.** The library logs `board shim missing at <path>` when the shim itself is not there, and the shim exits 127 with `board: no binary at ~/.local/bin/board or .../bin/board and no bun on PATH` when it is but nothing it looks for is. Re-run `scripts/install-home.sh`; the binary is built on each machine and never committed.
- **No `.boards` in the checkout.** The binary expects `.boards/config.yml` in the main checkout of the repository containing the hook's cwd, and says `no board here` on stderr when it finds none, which reaches the log as a `board <cmd> failed (exit N): ...` line.
- **Renaming or moving a script** without updating `hooks.json`. The paths there are literal.
- **Dropping the execute bit.** `git update-index --chmod=+x` if it happens.
- **`set -x` anywhere in these scripts.** It buries the log in noise. `lib/board.sh` disables it on load; do not turn it back on.
- **Editing an agent's Invariants without editing `enforce-agent-scope.sh`.** The deny messages quote those invariants verbatim. If they drift apart, an agent gets told off for breaking a rule its body no longer states. The `migration-checklist` run is the place to catch that.

## Decisions this layer makes

The design specifies the board writes and the gates; the mechanics below are this layer's own decisions, recorded here so they are found rather than rediscovered.

1. **How a hook knows the item.** The `.boards/.focus` file per checkout, the `[board:<id>]` task-subject marker for completion, `CLAUDECODE_AGENTS_BOARD_PAGE_ID` for a scripted launch, and the state-file layout under `~/.local/state/claudecode-agents/`. The design says the hook knows the item from the spawn context; this is what that means.
2. **`board.env` and every default in it.** The status names and how the column labels are spelled in the board's config are this layer's choice, matched to the templates `/init` writes.
3. **How "tests pass" is decided.** The command, then the marker file with its staleness window, then the lenient default. The design asserts the gate and never says what it reads.
4. **A comment on the card at every transition**, and where each one's text comes from. The design specifies a comment only for the `Blocker:` path. A card that says nothing but which column it is in is a status light, not a board.
5. **Where the overflow of a cut comment goes.** One file per cut comment under the state directory, at `archives/<session_id>/<stamp>-<agent>.md`, and the state directory rather than the working directory because a worktree agent's cwd does not survive its own session. See "What the card says" above; the handoff format is untouched.
6. **The `## Done` comment is posted from `SubagentStop` rather than `TaskCompleted`.** The design gives Done to `TaskCompleted`, which never receives a handoff, so the text is read where it exists and the column move stays where the design put it.
7. **A successful run with no blockers changes no column.** The design gives Done to `TaskCompleted`, so `SubagentStop` leaves the item in Doing. It comments there; it does not move it.
8. **The handoff check runs on success only**, and tolerates preamble prose, which is unparsed. Everything else in the skill is enforced strictly, including the blank-line rule and where a typed line may appear. See above for why.
9. **`cd`, `pwd`, `echo` and `true`** on scout's Bash allowlist, and the quote-stripping and `2>/dev/null` softenings.
10. **`fleet-steward`'s repo-root resolution** by walking up from the plugin directory, and the git verb list, which is read off its Invariants prose.
11. **Which CLI calls a column move and a comment are made of**, and the ten-second timeout around each. The design names the board and not the commands; `board task view --json`, `board task edit -s` and `board task edit --comment --comment-author` are this layer's choice, as is using the hook's own name (`@SubagentStop` and so on) as the comment author.
12. **The `SubagentStop` matcher.** The design gives the hook to every subagent. Scoping it to the ten fleet agents is this layer's decision, because the workflows spawn `Plan` and `general-purpose` lanes that return JSON.
13. **`reviewer` and `ui-designer` scoping rules**, including the read-only git allowlist both share and the install-verb matching that keeps `ui-designer` able to build and serve a prototype.
14. **The comment length cap.** `BOARD_COMMENT_MAX_CHARS`, its default of 8000 and the `BOARD_COMMENT_HARD_MAX` clamp. A task file imposes no limit a card comment would meet, so where to cut is this layer's choice, made for the reader; see "Comment length" above.
15. **The event field names come from the shipped CLI, not the docs.** The docs pages truncate before the event sections, so the hooks read the fields the zod schemas in the binary define:

    | Event | Fields |
    |---|---|
    | `TaskCompleted` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
    | `SubagentStart` | the common fields, `agent_id`, `agent_type` |
    | `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message?`, `background_tasks?` |

    `task_title`, `task_name` and `completion_reason` appear nowhere in the binary. Three consequences:

    - `board-task-completed.sh` reads `task_subject` for the `[board:<id>]` marker, and nothing else.
    - `board-subagent-start.sh` has no spawn prompt to read, so the `Board-Item:` route never fires; the focus file is the binding.
    - `board-subagent-stop.sh` has no `status` to key on, so its Blocked-on-failure path is unreachable. The read is kept for forward compatibility, but **do not describe failure or cancellation transitions as working** - the route to Blocked that does work is a `Blocker:` line in the handoff.

    To re-derive this after a CLI upgrade:

    ```sh
    strings -a "$(readlink -f "$(command -v claude)")" \
      | grep -o 'hook_event_name:"TaskCompleted".\{0,200\}'
    ```

    `evals/lib/board-hook-contract.sh` pins all of it.

16. **Structured output carries no handoff, and the hook tells that apart from an empty one.** A subagent spawned from a workflow with `agent(prompt, {agentType, schema})` is forced through StructuredOutput, and its `SubagentStop` payload **omits `last_assistant_message` entirely**. Not the JSON in that field, not an empty string: the key is absent.

    | Spawn | `last_assistant_message` |
    |---|---|
    | with `schema` | key absent |
    | without `schema` | the Markdown handoff |

    Reading `.last_assistant_message // ""` would erase the difference between *absent* and *empty* and fail `validate_handoff` on every schema spawn. Since the `SubagentStop` matcher covers all ten fleet names, and every workflow spawns fleet agents with schemas - `scout` and `reviewer` in `review-round.js`, `researcher` at five sites in `deep-research.js`, `scout` and `spec-writer` in `spec-to-plan.js` - the gate would refuse to let those runs stop. Item 12 scopes the matcher away from the built-in lanes; it cannot reach a schema-carrying agent which is itself a fleet agent, so the hook separates the two cases once, at the read:

    ```sh
    has_message="$(printf '%s' "$input" \
      | jq -r 'if has("last_assistant_message") and .last_assistant_message != null
               then "yes" else "no" end')"
    ```

    Absent, or JSON `null`, means there is no handoff to check, so the gate does not fire and the column is left alone - `TaskCompleted` owns Done, and a card that invents a comment out of structured output nobody parsed is worse than a card that says nothing. Present-but-empty still fails, because that is an agent which was asked and said nothing, and it is the thing the gate exists to catch. `evals/lib/board-hook-contract.sh` pins all three cases - `stop-structured-run-passes`, `stop-empty-message-blocks`, `stop-prose-blocks` - so a softening of the gate has to walk past two tests that say no.

    Fields item 15's table does not list, all present on a real event:

    | Event | Additional fields observed |
    |---|---|
    | `SubagentStart` | `cwd`, `prompt_id`, `session_id`, `transcript_path` |
    | `SubagentStop` | `cwd`, `effort`, `permission_mode`, `prompt_id`, `session_crons`, `transcript_path` |

    `agent_type` arrives bare (`probe-worker`), unprefixed. `cwd` is a supported route to the directory a subagent actually worked in.

    **Absent does not prove why, so the hook asks the transcript.** The runtime builds the field as

    ```js
    let p = findLast(m => m.type === "assistant"),
        f = p ? textOf(p.message.content).trim() || void 0 : void 0
    ```

    `.trim() || void 0` turns an empty *or whitespace-only* final message into `undefined`, and undefined properties drop out of the payload. So `last_assistant_message: ""` is **unreachable** - a fleet agent that was asked for a handoff and produced nothing sends a byte-identical payload to a schema spawn. Passing every absent field would retire the gate for exactly the case it exists to catch, so `agent_transcript_path` is read to tell them apart:

    | Last assistant content block | Means | Hook does |
    |---|---|---|
    | `tool_use` named `StructuredOutput` | a schema run, never asked for a handoff | passes, column untouched |
    | `text` | the runtime dropped a message the transcript still holds | recovers it and validates it like any other |
    | unreadable, oversized, absent, or no assistant content | cannot tell | passes, and says so |

    Read `agent_transcript_path`, never `transcript_path`: the event sends both and only the first is scoped to the subagent. The third row is the residual gap and it is deliberate - a transcript this hook cannot read is not a reason to refuse to let a subagent stop, because deadlocking a run is worse than a rare silent pass. `CLAUDECODE_AGENTS_TRANSCRIPT_MAX_BYTES` caps the read at 20 MB.

    To re-derive after a CLI upgrade, spawn one agent twice from a workflow - once with a `schema`, once without - behind a `SubagentStop` hook that dumps its stdin, and diff the two payloads. The control spawn is the point: an empty dump alone cannot distinguish "StructuredOutput ate the message" from "the hook never fired".

17. **The git verb is found past the global options.** Reading the subcommand as the second whitespace-separated token would resolve `git -C /path log` to a verb of `-C`, and the parser and the shell would disagree about where the verb is. That breaks in both directions at once depending on how each role's check is written:

    | Role | Check shape | Unrecognised verb | Result |
    |---|---|---|---|
    | `scout`, `reviewer`, `ui-designer` | allowlist | denies | **false deny** - `git -C <worktree> diff` refused |
    | `fleet-steward` | denylist | allows | **false allow** - `git -C /path push --force` passes |

    `git_verb()` finds the real verb. Every git global option is dashed and a verb never is, so it skips dashed tokens and skips the value of the eight that take a separate argument (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`, `--super-prefix`, `--config-env`). A segment with no undashed token yields the empty string, which matches no allowlist and no denylist entry, so `git -C /path` on its own is not a read.

    It also collapses backslash-escaped pairs before splitting. Quoted paths never arrive unsplit - the quote stripper runs first - but escapes do, and `git -C /tmp/a\ b reset --hard` would otherwise resolve its verb to `b`. Nothing downstream reads the path, only the verb, so replacing each escaped pair with one ordinary character keeps the path a single token without pretending to know what it says.

    `evals/lib/scope-hook-contract.sh` pins both directions: the reads that must work, and every forbidden verb that must stay forbidden when a `-C`, a `-c`, a `--no-pager` or an escaped space is put in front of it.

    This does not make the scope hook a containment boundary. A program run through Bash writes wherever the process can, and no shell-level check sees inside it.

18. **coder writes in its own worktree, or it does not write.** The one preventive check in the fleet, and the only answer to a limit `review-round` cannot fix from inside a workflow.

    `coder` carries `isolation: worktree`, and everything downstream assumes it holds. `review-round` can only *detect* a fix that landed in the main checkout - by the time its verification runs, coder has already branched and committed - and the fix prompt asking coder to check first is an instruction, not a boundary. But `coder` has an `agentType`, so this hook governs its Bash calls, and git answers the question directly: a linked worktree's git dir sits under `.git/worktrees/`, a main checkout's does not.

    ```
    $ git -C <linked worktree> rev-parse --absolute-git-dir
    /repo/.git/worktrees/fix-r1
    $ git -C <main checkout> rev-parse --absolute-git-dir
    /repo/.git
    ```

    So a git command that **writes** - the verbs in `CODER_WRITING_GIT` - is refused unless its target directory can be shown to be a linked worktree. The target is the command's own `-C` where it has one, otherwise the directory the segment runs in: the tool call's `cwd`, or wherever a `cd` or `pushd` earlier in the same command moved to, with `cd -` followed back, so `cd <repo> && git commit` is judged against `<repo>` exactly as the `-C` form is. The one writing verb allowed from a main checkout is `git worktree add`, because it creates the isolation this check requires rather than breaking it, and it is how a coder gets a worktree in a repository the harness did not cut one in; `worktree remove`, `prune` and `move` stay governed. Reads are untouched, and so is everything that is not git: `git log`, `git diff`, `npm test` and `pytest` all run in a main checkout. This enforces `coder.md`'s own second step, which says to confirm the worktree before touching anything.

    **Not being able to tell is not permission.** A directory that is not a repository at all is refused too, on the grounds that a git write there would fail anyway and that the case this exists for - isolation silently not happening - is precisely the case where nothing announces itself.

    **Know what this costs.** Worktree isolation for a workflow-spawned `coder` is unobserved against a live Claude (see `docs/limits.md`). If it turns out not to hold, `coder` is **blocked from every writing git command** rather than quietly committing to the checkout it happens to be in. That is the intended failure and the right one, but it is a stop rather than a slow leak: if coder starts raising blockers about worktrees, this hook is why, and the answer is to fix isolation rather than to remove the check. `worktree.baseRef` defaults to `fresh`, which branches from `origin/<default-branch>`, so a repository with no remote cannot cut one at all.

19. **A stop with no `agent_type` owes no handoff.** The handoff is a fleet convention, preloaded into the eleven role bodies. A spawn that stops without a type - a named teammate, a harness-driven synthetic, a runtime that dropped the field - never had the skill and never agreed to the contract, so `board-subagent-stop.sh` logs it as `an untyped subagent` and exits 0 before the handoff check, the same way a StructuredOutput run is let go (item 16). The matcher in `hooks.json` was meant to keep these out and did not: 2562 untyped stops reached the gate between 2026-09-09 and 2026-09-18 (issue 8), each logged as `handoff from agent is malformed` - a sentence grammatical enough to read as a role called "agent" - and each exit 2 asked for four headings the spawn had never been given. The placeholder is now `an untyped subagent` everywhere the type is interpolated, so the case names itself in the log. Contract cases `stop-untyped-stands-down`, `stop-untyped-is-named` and `stop-empty-type-stands-down`.
