# The fleet: what it is and why

This is the canonical design document for the claudecode-agents fleet: the roles, the models they run on, the vocabulary they share, where their memory lives, how the board is written, what belongs in a skill versus a rule, and how every machine and cloud session gets the same thing. "Design section N" anywhere in the claudecode-agents repo means this file. The `fleet-steward`'s pull requests keep it current, and `docs/agent-contract.md` holds the field-level shape every agent body conforms to.

## 1. What this covers

The fleet is the set of role-shaped agents you delegate to from a Claude Code session - coding, spec writing, UI design, code review, refutation, technical writing, research - plus the plumbing that makes them one system: the models they run on, the words they share, where their memory lives, how they reach the board, what goes in a skill versus CLAUDE.md, which plugins earn a place, and how the whole lot stays identical across your machines and Claude Code on the web while still tracking new models.

It is deliberately a different layer from the home lab. Angus and Mabel are Agent SDK agents with their own identities, memory substrate and A2A story. The fleet is dev tooling: role-named, without persistent identity, and disposable. Agents here keep memory, on the server (section 6); what they do not keep is a personality. The two layers share skills - the Agent SDK loads the same `skills/` directories when `settingSources` points at them - and that is the one deliberate overlap. The fleet does not grow personas; that is what the Sprites are for.

## 2. Principles

Five rules that settle most arguments:

1. One source of truth, and it is a git repo. Nothing that matters lives only in `~/.claude`. Claude Code on the web has no persistent home directory, so anything that must reach a cloud session travels through the project repo or a plugin marketplace declared in project settings.
2. Agents are roles, skills are procedures, CLAUDE.md is facts. Never paste skill text into an agent body. Preload it with the `skills:` field instead.
3. Model by alias, never by ID. `opus`, `sonnet`, `haiku`, `fable`, `inherit` are re-pointed by Anthropic on release day; `claude-opus-5` is not. Pinned IDs are reserved for agents with evals that prove they need them.
4. Opus 5 is the workhorse. Fable 5.1 is an escalation, not a default; Sonnet 5 is the floor for volume work; Haiku is for grep-shaped jobs only, and nothing runs on it (section 5).
5. Every agent has a smoke eval, because prompt changes and model changes are both regressions waiting to happen.

## 3. Terminology

There is no industry standard, only four vocabularies that collide: Anthropic's (subagent, teammate, task, phase), spec-driven development's (spec, plan, tasks, implement), project tooling's (initiative, project, milestone, issue, sub-issue), and loop tooling's (iteration, round). The fleet takes project tooling's words for tracking, SDD's for artefacts, Anthropic's for execution. The `glossary` skill is the canonical copy, preloaded into every agent; this table mirrors it, and the project rule is generated from the skill (section 8).

| Term | Meaning | Maps to |
|---|---|---|
| Initiative | A goal spanning several projects (e.g. "agent platform v5") | none; a shared milestone or a document |
| Project | A bounded body of work in one repo or product area | the repository's board |
| Milestone | A checkpoint inside a project with a date or a deliverable | a milestone file |
| Issue | The unit of tracked work a human cares about. Has a spec or is trivial | a task file (`BD-12`) |
| Sub-issue | A child of an issue, still tracked on the board | a sub-task (`BD-12.1`) |
| Task | The unit of agent execution inside a session. Cheap, many, never on the board | Claude Code task list item (`TaskCreate`) |
| Spec | What and why, human-approved before planning. Written by `spec-writer` | `docs/specs/<issue>.md` |
| Plan | How, in phases, produced from a spec. Written by the lead, approved by you | `docs/plans/<issue>.md` |
| Phase | A sequential stage of a plan or workflow; phases do not overlap | Workflow `phase()` |
| Round | One pass of an iterative loop (review round, refutation round). Rounds are numbered | `--max-iterations` |
| Session | One Claude Code conversation, from the lead's first turn to its last | Claude Code session |
| Lead | The main session that plans and delegates. A named agent, not a subagent | `agent` in project settings |
| Subagent | A role agent spawned by the lead with fresh context | `Agent` tool |
| Teammate | A subagent running as a full session with a mailbox (Agent Teams) | Agent Teams teammate |
| Handoff | The structured result a subagent returns. Always four headings: Done, Not done, Unverified, Decisions needed. Lines under the last are typed: `Blocker:`, `Propose item:`, `Propose memory:` | Agent tool result, `handoff` skill |
| Gate | A point where a human must approve before the next phase | `TaskCompleted` hook or plan approval |
| Board | The tracked items as five columns: to do, doing, blocked, blocked by human, done | the task files grouped by status; `board export` or the web UI |
| Human queue | The "blocked by human" column. The one thing the human monitors | the `Blocked by human` status |
| Eval | A smoke test for one agent: three to five prompts, a rubric, a baseline score | `claude -p` via `evals/run.sh` |
| Sprite | A home lab AI personal assistant with a persistent identity (Angus, Mabel). Out of scope here; the fleet has no Sprites | Agent SDK agent |

Dropped on purpose: "subtask" (say sub-issue or task, whichever you actually mean), "epic" (a project or a milestone covers it), "sprint" (you are one person; a dated milestone covers time boxes), "story".

## 4. The roster

Ten agents, all shared through the plugin: the six that do the work, plus a `lead` that plans and routes, a `scout` that does the cheap reading so the expensive agents do not, a `fleet-steward` that keeps the definitions current (section 11), and a `refuter` that tries to break what the others just built. All names are kebab-case role names, not personas.

The table carries static frontmatter values only. Anything conditional - deeper review for auth diffs, an Opus pass on external-audience writing, escalating the lead to Fable - lives in the lead's delegation policy, because that is where the decision is actually made. "Memory" here means the claude.ai Memory connector; every agent carries its read tools, and only `researcher` and the lead carry `memory_capture` (section 6).

| Agent | Job | Model | Effort | Tools | Isolation | Preloaded skills |
|---|---|---|---|---|---|---|
| `lead` | Plan, route, gate. Writes `docs/plans/<issue>.md` via the built-in Plan agent, picks who gets what, merges handoffs, holds the escalation policy. Not a subagent: set via `agent` in project settings | `opus` | n/a | the full session, which carries the board server and memory (read and write) | n/a | glossary, handoff, board |
| `scout` | Answer "where is X, how does Y work" across a codebase; return locations and excerpts, never opinions | `sonnet` | low | Read, Grep, Glob, Bash (read-only by invariant and hook), memory (read) | - | glossary, handoff |
| `spec-writer` | Turn a brain dump or board item into a spec: problem, non-goals, acceptance criteria, open questions. Interviews you before writing | `opus` | xhigh | Read, Grep, Glob, Write (`docs/specs/` only), WebSearch, board (read), memory (read) | - | glossary, handoff, board, brainstorming |
| `coder` | Implement a plan phase: tests first, small commits, handoff with what changed and what is unverified | `opus` | high | Read, Grep, Glob, Edit, Write, NotebookEdit, Bash, WebSearch, WebFetch, memory (read) | worktree | glossary, handoff, looping, run-article |
| `reviewer` | Review a diff for correctness, design, security. Reports; never edits | `opus` | high | Read, Grep, Glob, Bash (read-only git, no test runners), memory (read) | - | glossary, handoff, run-article |
| `refuter` | Try to break a change and report what broke it: surviving mutations, tests that pass for the wrong reason, claims the evidence does not support. Never fixes | `opus` | high | Read, Grep, Glob, Bash, Write, Edit (outside the project only), memory (read) | - | glossary, handoff, looping, run-article |
| `ui-designer` | Produce screens, flows and HTML prototypes from a spec; argue for one direction, show two alternatives | `opus` | high | Read, Write (`prototypes/` and `docs/runs/`), Bash (build, serve, screenshot; no installs), WebSearch, memory (read) | - | glossary, handoff, run-article |
| `tech-writer` | READMEs, ADRs, runbooks, blog drafts, internal docs | `sonnet` | medium | Read, Grep, Glob, Write (`docs/` and a root markdown file), WebFetch, memory (read) | - | glossary, handoff, humanize |
| `researcher` | Fan-out reading and synthesis with citations; the bulk token consumer | `sonnet` | medium | WebSearch, WebFetch, Read, Hugging Face connector, memory (read and write, tagged) | - | glossary, handoff, run-article |
| `fleet-steward` | The model and tooling sweep: diff the models list, read release notes and the Claude Code changelog, run the migration checklist over every agent, file board items and a pull request | `sonnet` | medium | Bash, WebFetch, Read, Edit (the `claudecode-agents` working copy only), board (read, create, comment), memory (read) | - | glossary, handoff, board, migration-checklist |

Notes that matter:

The `lead` is the most consequential definition in the fleet and the cheapest to get wrong. Its body is the delegation policy and nothing else: what goes to whom, the escalation rules (deeper review effort when a diff touches auth or secrets, `refuter` when a review's gates sit under Unverified, an opus pass on anything `tech-writer` produces with an external audience, `/model fable` for architecture sessions and nasty debugging), the four-heading handoff format, and the rule that planning happens with the built-in Plan agent and stops for your approval. That is cheaper and more testable than teaching the same policy in CLAUDE.md.

The `reviewer` gets no write tools. The single most common failure in review agents is that they fix the thing and the diff you approve is not the diff you read. Review is two-stage: a mechanical pass first (lint, tests, obvious smells, via the `pr-review-toolkit` plugin), then the Opus verdict.

The `refuter` exists because a green review is a claim, not evidence. It records the suite's baseline, mutates a copy of the change, runs the suite again, and reports what survived, under the `looping` skill's budget and convergence rules. It writes nothing inside the project and never fixes what it breaks.

The `coder` runs in a worktree (`isolation: worktree`) so parallel coders do not trample each other and a bad run is a `git worktree remove` away. The scope hook refuses a writing git command from `coder` in anything but a linked worktree, so if isolation does not hold, `coder` stops rather than leaking commits. Agent Teams do not isolate, and a spawn given a `name` runs as a teammate whose events carry the name rather than the type, so every type-keyed control - the scope hook, the handoff gate, the worktree - stands down; fleet spawns are type and prompt only. Worktree hygiene matters: Agent view auto-moves background sessions into `.claude/worktrees/`, and deleting a session there deletes uncommitted work with it, so the lead removes an adopted coder's worktree with `/claudecode-agents:prune-worktrees`.

Everything ships in the plugin, and the local escape hatch stays in view: plugin agents cannot carry `hooks`, `mcpServers` or `permissionMode`, so an agent needing one of those exists as a local copy in `~/.claude/agents/`. No fleet agent needs one today. The same rule applies to any agent that touches personal material: it stays out of the shared repo.

Fable 5.1 is not in the table on purpose. It is the model you switch the lead to, not a subagent model, for the reasons in section 5.

Every agent returns a handoff with the same four headings: Done, Not done, Unverified, Decisions needed. Lines under Decisions needed are typed - `Blocker:` for anything that stops the work until you answer, `Propose item:` for new board work, `Propose memory:` for something worth filing on the memory server - because three consumers read that section and only the first should land in your queue. The lead can then merge a stack of handoffs without re-reading a stack of transcripts. The format lives in one `handoff` skill preloaded everywhere and is enforced by the `SubagentStop` hook.

## 5. Model selection: the evidence

Prices from platform.claude.com/docs/en/about-claude/pricing as read on 6 September 2026, USD per million tokens. Batch is half price on every model. The full 1M context is standard-priced on 4.6 and later; there is no long-context surcharge.

| Model | Input | Output | Cache read | 5m cache write | Context / max out | Retire not before |
|---|---|---|---|---|---|---|
| Fable 5.1 (`claude-fable-5-1`) | $10 | $50 | $0.25 | $12.50 | 1M / 128K | 1 Sep 2027 |
| Opus 5 (`claude-opus-5`) | $5 | $25 | $0.50 | $6.25 | 1M / 128K | 24 Jul 2027 |
| Sonnet 5 (`claude-sonnet-5`) | $2 | $10 | $0.20 | $2.50 | 1M / 128K | 30 Jun 2027 |
| Haiku 4.5 (`claude-haiku-4-5`) | $1 | $5 | $0.10 | $1.25 | 200K / 64K | 15 Oct 2026 |

Benchmarks Anthropic actually publishes (SWE-bench Verified, GPQA Diamond and tau2-bench are not reported from Opus 4.8 onward, so anything quoting those for 5-family models is third-party):

| Benchmark | Fable 5.1 | Opus 5 | Sonnet 5 | Mythos 5 | Fable 5 | Opus 4.8 |
|---|---|---|---|---|---|---|
| Terminal-Bench 4.0 | 55.8% | 52.3% | not published | not published | 42.0% | not published |
| Terminal-Bench-Science | 52.6% | 29.0% | not published | not published | not published | not published |
| SWE-bench Pro | not published | not published | 63.2% | not published | 80.3% | 69.2% |
| HLE (with tools) | 65.0 | 63.6 | 57.4 | 64.5 | not published | 57.9 |
| ARC-AGI-2 (ARC Prize verified) | 90.0% | 90.4% | not found | not published | 89.2% | not published |

Anthropic publishes no Fable 5 HLE figure; the announcement says only that Fable 5 "performs closer to Opus 4.8" on that row because of safeguard fallbacks. Mythos 5 has its own column so nothing borrows a number from a model it is not. OSWorld is left out because Anthropic switched from OSWorld-Verified to OSWorld 2.0 mid-year and the numbers are not comparable; for the record Sonnet 5 posted 81.2% on OSWorld-Verified, which is why it is the computer-use pick.

What the table says: Opus 5 sits within four points of Fable 5.1 on Terminal-Bench 4.0, within two on HLE, and actually ahead on ARC-AGI-2, at half the price. That is the whole argument for Opus as the default. The gap is real and large on the hardest agentic work (Terminal-Bench-Science: 52.6% against 29.0%), which is why Fable is the lead's escalation rather than absent. Sonnet 5 is a different tier (63.2% SWE-bench Pro against Opus 4.8's 69.2% and Fable 5's 80.3%) but it is excellent at writing, reading and computer use, which is exactly the shape of the `tech-writer`, `researcher` and `scout` jobs, and it costs 40% of Opus.

Haiku 4.5 is the one model in the table nothing runs on. It has a 200K window, a February 2025 cutoff and the earliest retirement date in the table. Sonnet 5 at `low` effort does the `scout` job with a 1M window and a later floor, at twice the token price and none of the migration risk. The steward flags the day a Haiku 5 appears, and `scout` is the first agent to re-test when it does.

One number worth knowing on API: Fable 5.1's cache read is $0.25 against a $10 base, or 2.5%. Opus 5's is $0.50 against a $5 base, or 10%. Fable's cache-read ratio is a quarter of Opus's, so a long session that is mostly cache hits narrows the Fable/Opus cost gap considerably. This matters for the home lab, not for Max.

Max specifics: Pro does not include Fable at all; Max 5x and 20x include Fable 5 and 5.1 up to 50% of weekly usage. Limits are one shared weekly cap across all models plus 5-hour windows, and there is no documented Opus-only weekly cap. Fable also draws roughly twice what an Opus session does (secondary source, not Anthropic), which is why it is a lead escalation rather than a subagent model: put it in an agent that fires twenty times an hour and you hit the wall on Wednesday. If a Fable session with the 1M context beta header suddenly says "usage credits", that is the billing defect tracked in Claude Code issues #79337 and #79412.

Effort is the other dial. It is per-agent frontmatter (`low` to `max`) and it moves token spend as much as model choice does. The Opus 5 migration guide says explicitly that effort is calibrated differently from 4.x, so the `migration-checklist` reruns the sweep rather than assuming old settings carry over.

## 6. Memory: three layers, no sync

The rule: memory that is Claude-written and machine-local is not a source of truth. Anything you would be upset to lose gets promoted into git or into the memory server. Nothing gets synced between machines, because nothing that matters lives on one machine.

Layer one, project facts (committed to the repo): `CLAUDE.md` for facts and conventions under 200 lines, and `.claude/rules/*.md` with `paths:` globs for conventions that only apply to some files. This is what cloud sessions see. `/doctor` tells you when CLAUDE.md is bloated.

Layer two, per-agent memory, on the memory server. This replaces Claude Code's file-based `memory: user` and `memory: project` scopes and the `~/.claude/agent-memory/<agent>/` directories they write to: every agent in the roster omits the `memory` field. The server dedupes near-duplicates and supersedes stale entries, which is the consolidation `/dream` does for the file version. The server reaches every agent as the claude.ai Memory connector, `mcp__claude_ai_Memory__*`, and a connector is one login shared by every agent, so the namespaces are not separated per agent today; the design intent is one credential per agent, which is what `scripts/install-home.sh` renders from 1Password into `~/.config/claudecode-agents/` (section 12), and the memory server binds the namespace to the credential once agents reach it that way.

Claude Code's auto memory (`~/.claude/projects/<repo>/memory/MEMORY.md`) still exists and still loads its first 200 lines. Treat it as per-machine scratch: useful in the session, never promoted, never synced. Set `CLAUDE_CODE_PROJECT_DIR_NAME` so worktrees of the same repo share it, which is what parallel coders want.

Layer three, the shared corpus on the same server: the `thoughts` store and the synced `documents` vault, with corpus and taint labels on everything that comes back. Practitioner writeups mostly advise against rolling your own here, and the stated failure mode ("a wrong memory is worse than no memory") is right, but you have already built it, you already label corpus and taint, and it is your selling point. Every agent reads it. An agent that cannot ask "what did we decide about this last time" re-derives it badly or asks you, and both are more expensive than the query. Writes to the shared corpus are the part to ration: a `coder` filing "we decided to use X" from a half-finished worktree run is exactly how a corpus rots. So shared writes belong to `researcher` (tagged) and the lead only; every other body denies `memory_capture` explicitly. Everyone else writes a `Propose memory:` line under the handoff's Decisions needed heading and one of those two files it, the same pattern as `Propose item:` for board work in section 7. The labelling convention rides in the two bodies that write. mem0, Zep, Letta and claude-mem are all skippable: mem0 duplicates what you have, Letta is a competing harness, and claude-mem's value (semantic search over months of transcripts) is only worth a daemon if you find yourself wanting it.

The thing people forget about subagent memory: the main session's auto memory is not passed to subagents (only forks inherit it). With layer two on the server, that stops mattering - a fresh subagent's own namespace is the first thing it can reach, from any machine.

## 7. Task tracking: the board plus native tasks, nothing in between

Two layers only. The board - one markdown file per item under `.boards/` in the repository, written only through the plugin's own `board` binary, which commits every write - is the human-facing backlog and the visible view; Claude Code's native task list (`TaskCreate`, `blockedBy`, persistent via `CLAUDE_CODE_TASK_LIST_ID`, shared with Agent Teams) is the execution layer inside a session. Nothing sits between them. The mapping rule lives in the glossary: an item may spawn many tasks; a task never creates a board item on its own.

The structure is one config and one file per item. `.boards/config.yml` carries the `statuses` list that the columns are; a project is the repository. `.boards/tasks/` carries one file per issue, with a milestone where there is a real date and sub-issues as sub-tasks, `BD-12.1` under `BD-12`. A goal spanning projects is a shared milestone or a document. One repository, one board: the queue you look at is this project's, and there is no view across repositories. "One place to look" is traded away on purpose, because a board in one person's memory tree is not something a second contributor can clone, and a board in the repository is.

The board is the task files grouped by status, five columns:

| Column | Meaning | Who moves it |
|---|---|---|
| To do | Filed, not started | You, or an agent proposing work |
| Doing | An agent has picked it up | `SubagentStart` hook |
| Blocked | Waiting on something that is not you - a build, an API, another task, or a failing suite | `TaskCompleted` when tests fail. `SubagentStop` also reads the harness's `status` field, which carries no failure today, so that route is dormant |
| Blocked by human | Waiting on your decision. **The human queue** | `SubagentStop`, on a `Blocker:` line in the handoff |
| Done | The agent finished and tests passed | `TaskCompleted` hook |

There is no "success" column. Whether a done item was actually any good is an outcome label on the item (`outcome/shipped`, `outcome/abandoned`, `outcome/superseded`), not a second terminal column for things to get stranded in.

In the fleet, status writes are a hook, never an instruction. Three hooks cover the board. `SubagentStart` writes Doing when the lead spawns an agent. `SubagentStop` reads `last_assistant_message`, writes Blocked by human on a `Blocker:` line, and puts a comment lifted from the handoff on the card whatever the outcome. `TaskCompleted` writes Done when tests pass and Blocked when they do not - the exit-2 gate and the board write are one hook with two outcomes, and the write happens on both paths. Each calls the `board` binary against the repository's `.boards/`, and the binary commits the write. This is the deliberate answer to the objection that agents do not file work spontaneously and that CLAUDE.md nagging fades - both true, which is exactly why the board is written by machinery rather than by asking nicely. Fleet agents never have to remember to update anything. `claudecode-agents/hooks/README.md` is the reference for the hooks themselves.

**The human queue is the whole point.** Every handoff ends with a Decisions needed heading (section 4). Without the hook that content sits inside transcripts, and finding it means reading ten of them. The `SubagentStop` hook parses `last_assistant_message` for `Blocker:` lines under Decisions needed and moves the corresponding item into "blocked by human" with the blocker text as a comment. `Propose item:` and `Propose memory:` lines never touch the column; the lead handles those. Your one monitoring responsibility is that column, and `/claudecode-agents:board` opens a per-session web UI on a loopback port to read it.

Which item a spawn belongs to is the checkout's focus: the lead sets it with the board server's `task_focus` tool before the first spawn of a phase, and you set it by hand with `/claudecode-agents:work BD-12`. Either writes one line to `.boards/.focus`, which is kept out of git, and `SubagentStart` reads it ahead of everything else. Only a task whose subject carries `[board:<id>]` closes an issue, and that marker goes on the single task that completes it.

The plugin ships the board's MCP server in its own `.mcp.json`; it is scoped to `spec-writer`, `fleet-steward` and the lead - the three that create and read items. Not to `coder`. This is the general rule and it is worth stating once: every MCP server's tool list is paid for on every turn of every agent that carries it, so use `disallowedTools` with `mcp__*` patterns on the agents that do not need one. Context budget is a real budget. The memory server is the deliberate exception - it goes to all ten (section 6) because cross-session recall is worth the tool list, and because it is your server and you control how wide that surface gets. Keep it narrow. Everything else, including the board, stays scoped.

Hooks cannot call MCP tools - they run as shell on the host - so the status writes go through the `board` binary, reached by the shim at `${CLAUDE_PLUGIN_ROOT}/board/board.sh`, which finds the repository's `.boards/` from the hook's working directory through git. No token and no network: the board is files, and section 12 has one sentence to say about it.

Backlog.md is what the board is: its MIT code is carried into the plugin at a pinned commit rather than depended on as a binary, so the git-native tracker some people add as a third layer is the first layer here, readable without a tool from any clone. beads on Dolt, task-master and BMAD are all too heavy for one person.

## 8. Skills versus CLAUDE.md versus rules

Slash commands and skills are the same mechanism, so there are three places to put an instruction and one rule each:

CLAUDE.md is for things that must be true on every turn and fit in a sentence: stack, conventions, the glossary pointer, where specs live, "Australian English, hyphens not em dashes". Under 200 lines, no procedures. `@import` up to four hops if you want to compose it. Cowork skips a symlinked `~/.claude/CLAUDE.md`, so the install script copies that file rather than linking it.

`.claude/rules/*.md` is CLAUDE.md that only loads when matching files are open: the Drizzle conventions load when a file under `src/db/**` is touched, not always. Rules without `paths:` load unconditionally. `~/.claude/rules/` gives you the same at user scope.

Skills are procedures: multi-step, invoked when needed, with their own `allowed-tools`, `model`, `effort`, `context: fork` and `paths:` if they should only trigger in some places. The `skills:` field on an agent preloads the full body at startup, so the agent does not have to discover it. That is the mechanism for "copy the skill into the agent": do not. One skill file, preloaded into as many agents as need it, changed in one place. The one exception is a three-line invariant (never force-push, never edit `.env`) which is cheaper as a sentence in the agent body than as a preloaded skill.

The glossary is the test case for that rule, because it needs to be in two places at once: preloaded into every agent, and loaded unconditionally at project scope for the lead session. So `skills/glossary` is canonical and `scripts/gen-glossary-rule.sh` generates `claudecode-agents/templates/rules/glossary.md` from it. Two copies exist; only one is edited. There is no third copy anywhere, because a copy an agent has to republish is one more thing to drift.

The plugin ships eight skills: `glossary` (section 3); `handoff` (the four-heading format with typed Decisions needed lines, preloaded into every agent and enforced by the `SubagentStop` hook); `board` (the column semantics, the Decisions needed to human-queue mapping, the focus convention and the item conventions - section 7); `migration-checklist` (section 11); `compound` (write learnings back into rules, skills and memory at the end of a unit of work, and the quarterly pass over a project's rules and run articles that the lead runs when you ask); `run-article` (the readable account of one run that a handoff cannot carry); `looping` (budget and convergence rules for an iterative loop, preloaded into `coder` and `refuter`); and `humanize` (the writing pass `tech-writer` carries). `brainstorming`, which `spec-writer` preloads, resolves from the superpowers plugin. Test-first lives inline in `coder`'s procedure and the review checklist inline in `reviewer`'s, because each is a few lines, and a body never names a skill that does not resolve: `skills:` is a silent no-op on an unknown name, and a body that names one tells the agent a procedure is loaded when it is not. The grilling interview lives inline in `spec-writer` for the same reason. `skill-creator` stays local because it is a workbench, not a dependency.

## 9. Plugins

The fleet leans on two plugins outside itself. `pr-review-toolkit` from `claude-plugins-official` is the mechanical first stage of review that `reviewer` assumes has already run (section 4). superpowers, from `obra/superpowers`, is where `brainstorming` resolves from for `spec-writer`. The board's MCP server ships inside this plugin, scoped per section 7. Anthropic says plainly it does not audit bundled MCP servers, so read `.mcp.json` before trusting a plugin from anyone else, and the `fleet-steward`'s audit step catches a plugin whose content changes without its version changing.

Borrowed rather than installed: compound-engineering's "write learnings back" step is the best idea in the space and is what the `compound` skill does; superpowers' full ceremony on small changes is not worth adopting wholesale, so only the one skill is used. wshobson/agents and VoltAgent are prompt libraries to mine for frontmatter patterns, not marketplaces to enable; 200 agents in the delegation menu makes the lead worse at picking. spec-kit's vocabulary is already in the glossary.

Skipped: claude-mem, task-master, BMAD, davila7/claude-code-templates, GSD, Kiro.

## 10. Distribution and sync

The repo is `claudecode-agents` (`https://github.com/rzem-ai/claudecode-agents.git`). It is a plugin marketplace with one plugin, versioned with semver, and it is the only thing every environment needs to know about.

```
claudecode-agents/
  .claude-plugin/marketplace.json     # name: rzem, plugins: [claudecode-agents]
  claudecode-agents/
    .claude-plugin/plugin.json        # version bumped on every change; the cache ignores unbumped versions
    .mcp.json                         # the board's MCP server, run through board/board.sh
    agents/                           # lead, scout, spec-writer, coder, reviewer, refuter, ui-designer, tech-writer, researcher, fleet-steward
    skills/                           # glossary, handoff, board, migration-checklist, compound, run-article, looping, humanize
    hooks/                            # SubagentStart -> Doing; SubagentStop handoff check -> Blocked by human; TaskCompleted gate -> Done / Blocked; PreToolUse scope
    workflows/                        # spec-to-plan, review-round, deep-research
    commands/                         # init, kickoff, board, work, prune-worktrees
    board/                            # the board: Backlog.md's MIT code at a pinned commit, the CLI, the MCP server and the web UI
    templates/
      project-settings.json           # extraKnownMarketplaces + enabledPlugins + agent, merged into each repo's .claude/settings.json
      CLAUDE.md                       # skeleton with the glossary pointer
      board.config.yml                # the five statuses, copied to .boards/config.yml by /init
      board.gitignore                 # keeps .boards/.focus out of git
      rules/glossary.md               # generated, do not edit
    CHANGELOG.md
  evals/                              # one smoke eval per agent, run by claude -p
  evals/lib/check-all.sh              # every deterministic check; no model, no network, no board
  docs/fleet-design.md                # this document
  docs/agent-contract.md              # what every agent body conforms to; the migration checklist checks against it
  docs/limits.md                      # what the fleet deliberately does not enforce or cover
  docs/runs/                          # the run-article convention; articles live in the repo the work happened in
  home/settings.json                  # user-scope permissions.deny and sandbox settings the install script places
  scripts/gen-glossary-rule.sh        # skills/glossary -> claudecode-agents/templates/rules/glossary.md
  scripts/install-home.sh             # copies home/ into ~/.claude, renders secrets from 1Password, builds the board binary
  scripts/merge-settings.py           # the settings merge install-home.sh uses instead of a plain cp
  scripts/migrate-memory-board.sh     # moves board items out of a memory-tree board into a repository's .boards/
  README.md                           # the front door: what the claudecode-agents repo is and how to use it
```

How each environment gets it:

Every machine runs `scripts/install-home.sh`, which copies `home/` into `~/.claude` - today that is `settings.json`, merged rather than overwritten - renders the ten per-agent memory credentials with `op read` from 1Password (placeholders until the fleet vault exists), and builds the board binary into `~/.local/bin/board`. The board itself is created per repository by `/claudecode-agents:init`. `~/.claude/projects/`, sessions, history, debug and `plugins/cache` are never touched. The plugin is installed at user scope from the marketplace, so `claude plugin marketplace update rzem` plus the install script is the whole sync story, and there is no dotfiles manager.

Every project repo carries `.claude/settings.json` with `extraKnownMarketplaces` pointing at `claudecode-agents`, `enabledPlugins` set to `{"claudecode-agents@rzem": true}`, `autoUpdate` off so a project moves to a new fleet version when you say so, and `agent` set to `claudecode-agents:lead`, so the session runs as the lead. On folder trust, the plugin auto-installs. That is what makes Claude Code on the web work: the cloud session trusts the repo, reads settings, pulls the plugin. The repo is public, so the clone, the marketplace add and background refreshes need no credentials.

The home lab's Agent SDK agents point `settingSources` at the same plugin's skills directory. Angus and Mabel keep their own personas and memory; they just do not carry second copies of the shared writing skills.

Versioning rule: if `plugin.json` has a `version`, clients keep the cached copy until the number changes. Bump it or nothing updates. Pin exact versions for anything with hooks.

## 11. Keeping it current

This is the bit almost nobody builds. The `fleet-steward` runs its sweep unattended - weekly, started by whatever schedules it on the machine that runs it - and does four things, with nobody watching, which is exactly why everything it produces is a proposal.

It diffs `GET https://api.anthropic.com/v1/models` against last week's list and reads the platform release-notes feed (`platform.claude.com/docs/en/release-notes/feed.xml`), the Claude Code `CHANGELOG.md` and the deprecations page. Any new model, new alias target, retirement date or new frontmatter field becomes a board item under the "Claude Agents" project with the source quoted. It files these itself: it is the one named exception to "agents propose, the lead files", because there is no lead in the loop on a scheduled run.

When a model ships, it runs the `migration-checklist` skill over `docs/agent-contract.md` and every agent body. The checklist is lifted from Anthropic's own Opus 5 migration guide: strip "double-check your work" scaffolding (over-verification and over-delegation on 5-family models), add explicit length constraints, rerun the effort sweep, remove any `temperature`/`top_p` in SDK code, expect 1 to 1.35x tokeniser inflation, check that skills with `model:` overrides still name valid aliases, and check that every preloaded skill name and every MCP identifier resolves. Output is a pull request against `claudecode-agents`, not a merge.

It runs the evals on that branch: one smoke eval per agent (three to five prompts, a rubric, a baseline score) via `evals/run.sh`, and records every score against its baseline as a comment on the request. The evals are manual because they call `claude -p`; CI runs only the deterministic suite in `evals/lib/check-all.sh`.

It runs `cc-plugin-audit` (a SHA-256 manifest of installed plugins, diffed for silent updates) and reports any third-party plugin whose content changed without a version bump. Renovate has no Claude plugin manager, so this is the substitute.

It also diffs every `mcp__<server>__<tool>` identifier granted in the agent bodies against what `claude mcp list` shows, and files a board item for any name that resolves to nothing, because a wrong server name grants nothing, raises no error, and is the fleet's most expensive silent failure. The board's own plugin-shipped server is the exception, confirmed by a live tool listing rather than that command.

The steward never merges. It files, proposes, and stops. The definitions change when you approve the pull request, and the plugin version bump in that request is what propagates the change everywhere.

## 12. Security

Your day job, and the fleet is an attack surface. Two CVEs set the threat model: a repo's `.claude/settings.json` SessionStart hook executing before the trust prompt (CVE-2025-59536, 8.7) and `ANTHROPIC_BASE_URL` exfiltrating auth headers (CVE-2026-21852).

The mitigations, and where each lives:

- `--setting-sources user` or `disableAllHooks` when opening untrusted repos.
- `permissions.deny` in `home/settings.json` on `~/.ssh`, `~/.aws`, `.env`, Vault tokens, `~/.config/claudecode-agents`, `op`, `curl`, `wget`, `sudo` and every destructive git verb.
- `/sandbox` for bash, enabled in the same file, with the `sandbox.credentials` deny list populated - an empty list protects nothing - and network egress limited to an allowlist of domains.
- `@anthropic-ai/sandbox-runtime` before any unattended `--dangerously-skip-permissions` run.
- Read `.mcp.json` in any third-party plugin before enabling it (section 9); the steward's `cc-plugin-audit` run catches silent changes after that.
- Secrets on the host: the ten per-agent memory credentials, and nothing for the board, which is files in the repository with no token and no network. The credentials live in a dedicated 1Password vault holding fleet secrets only. `scripts/install-home.sh` renders them with `op read` into `~/.config/claudecode-agents/` at mode 600, and that directory is in the `permissions.deny` list and the sandbox's deny lists alongside `.env`. Hooks run outside the agent's permission model, so a hook may read that directory where the agent cannot. No hook calls `op read` at runtime - it adds latency to every subagent start and stop, and if `op` is locked the hook silently stops doing its job.
- The lab boxes have no one to touch a fingerprint reader, so `op` there authenticates with a 1Password Service Account. That token is the one secret provisioned by hand per lab machine; scope it to the fleet vault so it cannot read your personal items.

Hooks and MCP servers run on the host under `/sandbox` alone, so sandboxing bash is not sandboxing the session. And the per-agent scope hook is a boundary on what an agent is told it may do, not a containment boundary: a program run through Bash writes wherever the process can, and no shell-level check sees inside it. `docs/limits.md` records what that leaves open.

One consequence of section 7. The board travels with the repository, so client material on a board is exactly as exposed as the repository it is in - no more, no less - and an item you would have to redact before showing a client belongs in a repository that client can see, or not on a board at all.

Permission profiles do not exist as a feature (issue #35527 closed, not planned). Emulate them: alternate settings files plus shell aliases (`claude-safe`, `claude-yolo`), and per-agent `permissionMode` on a local copy.

And the identity angle you will enjoy: each subagent is a non-human identity with a tool scope, an owner and a lifecycle; the home lab's API keys are NHIs in Vault; the fleet is a small worked example of the governance you sell.

## Sources

Anthropic docs: sub-agents, skills, memory, plugins, plugins-reference, discover-plugins, plugin-marketplaces, agent-teams, workflows, settings, settings-reference, hooks (code.claude.com/docs/en/...); models overview, pricing, model-deprecations, release-notes, models/opus-5/migration-guide, api/models/list (platform.claude.com/docs/en/...). Announcements: anthropic.com/claude-fable-and-mythos-5-1, /news/claude-opus-5, /news/claude-sonnet-5, /news/claude-fable-5-mythos-5, /news/claude-opus-4-8. ARC Prize verified results: arcprize.org/results/anthropic-claude-fable-5-1 and -opus-5. Support: support.claude.com articles 15424964 (Fable on your plan), 11049741 (Max), 11145838 (Claude Code on Pro/Max). Claude Code issues #79337, #79412, #35527. 1Password: developer.1password.com (CLI `op read`, service accounts). Ecosystem: github.com/obra/superpowers, EveryInc/compound-engineering-plugin, MrLesk/Backlog.md, STRML/cc-plugin-audit, anthropics/claude-plugins-official. Security: research.checkpoint.com CVE-2025-59536 writeup; bartlomiejkrupa.dev sandboxing ladder.
