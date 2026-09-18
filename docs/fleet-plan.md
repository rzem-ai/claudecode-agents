# Claude Code Subagent Fleet - Plan v0.3.1

Author: Angus, for Alex. Date: 8 September 2026, corrected 9 September 2026. Status: draft for argument. This is the plan that section 10's tree names, kept current by the steward's PRs. It lived at the claudecode-agents repo root as `README.md` until 11 September 2026, when the root README became a front door for readers and the plan moved here; "plan section N" anywhere in the claudecode-agents repo means this file.

## Changelog since v0.3

Corrections only, made when the plan moved from an untracked `tmp/` file into the claudecode-agents repo. MCP servers reach the fleet as claude.ai connectors, so their tool identifiers carry a `claude_ai_` prefix; `docs/agent-contract.md` section 6 holds the confirmed spellings. Context7 is not installed and `coder` does not carry it until it is. The roster now shows `board` preloaded into the lead, `spec-writer` and `fleet-steward`, and `coder`'s tools as the explicit allowlist its body carries. The section 10 tree gains `docs/` - the agent contract and the run articles - and the project settings example uses the object form of `enabledPlugins` plus the `agent` key. Fourteen of the skills the roster preloads are not yet in the plugin; the contract's section 1.4 lists which. The Notion copy of the glossary is dropped (section 8), the quarterly pass over a project's rules and run articles is the lead's job on the human's ask rather than the steward's, and the steward's editing list now names everything its four jobs touch.

18 September 2026: the board is the plugin's own copy of Backlog.md, a directory of markdown files in the memory tree at `board/`, per `docs/2026-09-17-backlog-board.md`. Sections 3, 4, 7, 9, 10, 12 and 14 read accordingly. What section 7 decides is unchanged: the five columns mean what they meant, the hooks still own every column move and no agent writes one, and "blocked by human" is still the one queue the human monitors. What changed is underneath - task files carried by the memory sync agent instead of API calls against a hosted tracker, items numbered `BD-12`, no token and no network, and the plugin shipping both the binary the hooks call and the MCP server three bodies carry. The Milestone 4 decision was taken early, ahead of the milestones before it, because the hooks were carrying a dependency the fleet did not control.

18 September 2026, later the same day: the board is per repository, at `.boards/` in the main checkout, committed by the binary after every write, per `docs/2026-09-18-project-boards.md`. "One place to look" is reversed on purpose: other people will use this, and a board in one person's memory tree is not something a second contributor can clone. Section 7 reads accordingly. What it still decides is unchanged - the five columns, the hooks owning every move, blocked by human as the queue - except that the queue is now per repository, and a view across repositories is future work rather than a column.

## Changelog since v0.2

Notion becomes the backlog and the visible board. Two databases: Projects and Tasks, with Tasks carrying a five-column board view (to do, doing, blocked, blocked by human, done). "Blocked by human" is the queue you monitor, fed by the Decisions needed heading every handoff already produces, surfaced by a twice-daily digest with escalation after four hours. Status writes are a hook, not an instruction - `SubagentStart`, `SubagentStop` and `TaskCompleted`, verified against the hooks reference. Decisions needed lines are typed so the queue hook only fires on real blockers. One workspace, everything in it, full detail. Chezmoi is gone: user-scope files ship from a `home/` directory in the claudecode-agents repo via an install script, secrets come from 1Password, and per-agent memory moves off disk onto the rzem-memory server with one credential per agent - so there is nothing left to sync.

## Changelog since v0.1

Fourteen internal inconsistencies resolved after review. The substantive changes: the `lead` is now a first-class roster entry that owns planning and all escalation policy; `explorer` is renamed `scout` and moved from `haiku` to `sonnet`; `research-handoff` becomes `handoff` and is preloaded into every agent; the glossary has one canonical copy with the others generated from it; security gets its own numbered section; the build order uses Milestones, matching the glossary's own definition. `career-strategist` is dropped entirely, taking the fleet to nine agents, all of which ship in the plugin. Naming is consistent on `claudecode-agents` and `claudecode-agents@rzem` throughout. rzem-memory goes to all nine agents, read everywhere and write for `researcher` and the lead only, with `using-memory` preloaded fleet-wide. Two arithmetic errors in section 5 corrected, competitor pricing removed as home lab scope, and Mythos 5 given its own benchmark column instead of borrowing Fable 5's.

## 1. What this covers

This is the plan for your personal Claude Code subagent fleet: the role-shaped agents you delegate to from a Claude Code session (coding, spec writing, UI design, code review, technical writing, research), the models they run on, and the vocabulary they share.

It also covers the plumbing. Where their memory lives, how they talk to the board, what belongs in a skill versus CLAUDE.md, which plugins earn a place, and how the whole lot stays identical across your machines and Claude Code on the web while still tracking new models.

It is deliberately a different layer from the home lab. Angus and Mabel are Agent SDK agents with their own identities, memory substrate and A2A story. The fleet below is dev tooling: role-named, without persistent identity, and disposable. Agents here do keep memory, on the server (section 6) - what they don't keep is a personality. The two layers share skills (the Agent SDK loads the same `skills/` directories when you point `settingSources` at them), which is the one deliberate overlap. Don't let the fleet grow personas; that's what the Sprites are for.

## 2. Principles

Five rules that settle most later arguments:

1. One source of truth, and it's a git repo. Nothing that matters lives only in `~/.claude`. Claude Code on the web has no persistent home directory, so anything that must reach a cloud session travels through the project repo or a plugin marketplace declared in project settings.
2. Agents are personas, skills are procedures, CLAUDE.md is facts. Never paste skill text into an agent body. Preload it with the `skills:` field instead.
3. Model by alias, never by ID. `opus`, `sonnet`, `haiku`, `fable`, `inherit` are re-pointed by Anthropic on release day; `claude-opus-5` is not. Pinned IDs are reserved for agents with evals that prove they need them.
4. Opus 5 is the workhorse. Fable 5.1 is an escalation, not a default; Sonnet 5 is the floor for volume work; Haiku is for grep-shaped jobs only, and right now nothing runs on it (section 5).
5. Every agent has a smoke eval, because prompt changes and model changes are both regressions waiting to happen.

## 3. Terminology

There's no industry standard, only four vocabularies that collide: Anthropic's (subagent, teammate, task, phase), spec-driven development's (spec, plan, tasks, implement), project tooling's (initiative, project, milestone, issue, sub-issue), and loop tooling's (iteration, round). The pick below takes project tooling's words for tracking, SDD's for artefacts, Anthropic's for execution. The `glossary` skill is the canonical copy, preloaded into every agent; this table mirrors it, and the project rule is generated from the skill (section 8).

| Term | Meaning | Maps to |
|---|---|---|
| Initiative | A goal spanning several projects (e.g. "agent platform v5") | none; a shared milestone or a document |
| Project | A bounded body of work in one repo or product area | an entry in the board config's `projects` list |
| Milestone | A checkpoint inside a project with a date or a deliverable | a milestone file |
| Issue | The unit of tracked work a human cares about. Has a spec or is trivial | a task file (`BD-12`) |
| Sub-issue | A child of an issue, still tracked on the board | a sub-task (`BD-12.1`) |
| Task | The unit of agent execution inside a session. Cheap, many, never on the board | Claude Code task list item (`TaskCreate`) |
| Spec | What and why, human-approved before planning. Written by `spec-writer` | `docs/specs/<issue>.md` |
| Plan | How, in phases, produced from a spec. Written by the lead, approved by you | `docs/plans/<issue>.md` |
| Phase | A sequential stage of a plan or workflow; phases don't overlap | Workflow `phase()` |
| Round | One pass of an iterative loop (review round, ralph iteration). Rounds are numbered | `--max-iterations` |
| Session | One Claude Code conversation, from the lead's first turn to its last | Claude Code session |
| Lead | The main session that plans and delegates. A named agent, not a subagent | `agent` in project settings |
| Subagent | A role agent spawned by the lead with fresh context | `Agent` tool |
| Teammate | A subagent running as a full session with a mailbox (Agent Teams) | Agent Teams teammate |
| Handoff | The structured result a subagent returns. Always four headings: Done, Not done, Unverified, Decisions needed. Lines under the last are typed: `Blocker:`, `Propose item:`, `Propose memory:` | Agent tool result, `handoff` skill |
| Gate | A point where a human must approve before the next phase | `TaskCompleted` hook or plan approval |
| Board | The tracked items as five columns: to do, doing, blocked, blocked by human, done | the task files grouped by status; `board export` or the web UI |
| Human queue | The "blocked by human" column. The one thing the human monitors | the `Blocked by human` status |
| Eval | A smoke test for one agent: three to five prompts, a rubric, a baseline score. Run in CI on every definition change | `claude -p` in `claudecode-agents` CI |
| Sprite | A home lab AI personal assistant with a persistent identity (Angus, Mabel). Out of scope here; the fleet has no Sprites | Agent SDK agent |

Dropped on purpose: "subtask" (say sub-issue or task, whichever you actually mean), "epic" (a project or a milestone covers it), "sprint" (you're one person; a dated milestone covers time boxes), "story".

## 4. The roster

Ten agents, all shared through the plugin. Your original six, plus three the fleet needs to function - a `lead` that plans and routes, a `scout` that does the cheap reading so the expensive agents don't, and a `fleet-steward` that keeps the definitions current (section 11) - and a tenth, `refuter`, that tries to break what the others just built. All names are kebab-case role names, not personas.

The table carries static frontmatter values only. Anything conditional - deeper review for auth diffs, escalating to Opus for external-audience writing, escalating the lead to Fable - lives in the lead's delegation policy, because that's where the decision is actually made.

| Agent | Job | Model | Effort | Tools | Memory | Isolation | Preloaded skills |
|---|---|---|---|---|---|---|---|
| `lead` | Plan, route, gate. Writes `docs/plans/<issue>.md` via the built-in Plan agent, picks who gets what, merges handoffs, holds the escalation policy. Not a subagent: set via `agent` in project settings | `opus` | n/a | full session, plus the board MCP and rzem-memory MCP (read and write) | none | n/a | glossary, handoff, board |
| `scout` | Answer "where is X, how does Y work" across a codebase; return locations and excerpts, never opinions | `sonnet` | low | Read, Grep, Glob, Bash (read-only), rzem-memory MCP (read) | none | none | glossary, handoff |
| `spec-writer` | Turn a brain dump or board item into a spec: problem, non-goals, acceptance criteria, open questions. Interviews you before writing | `opus` | xhigh | Read, Grep, Glob, Write (docs/specs only), WebSearch, board MCP (read), rzem-memory MCP (read) | none | none | glossary, handoff, board, brainstorming |
| `coder` | Implement a plan phase: tests first, small commits, handoff with what changed and what's unverified | `opus` | high | Read, Grep, Glob, Edit, Write, NotebookEdit, Bash, WebSearch, WebFetch, rzem-memory MCP (read); context7 MCP once it is installed | none | worktree | glossary, handoff |
| `reviewer` | Review a diff for correctness, design, security. Reports; never edits | `opus` | high | Read, Grep, Glob, Bash (git only), rzem-memory MCP (read) | none | none | glossary, handoff |
| `refuter` | Try to break a change and report what broke it: surviving mutations, tests that pass for the wrong reason, claims the evidence does not support. Never fixes | `opus` | high | Read, Grep, Glob, Bash, Write, Edit (outside the project only), rzem-memory MCP (read) | none | none | glossary, handoff, looping, run-article |
| `ui-designer` | Produce screens, flows and HTML prototypes from a spec; argue for one direction, show two alternatives | `opus` | high | Read, Write, Bash, WebSearch, Figma MCP if you use it, rzem-memory MCP (read) | none | none | glossary, handoff |
| `tech-writer` | READMEs, ADRs, runbooks, blog drafts, internal docs | `sonnet` | medium | Read, Grep, Glob, Write, WebFetch, rzem-memory MCP (read) | none | none | glossary, handoff, humanize |
| `researcher` | Fan-out reading and synthesis with citations; the bulk token consumer | `sonnet` | medium | WebSearch, WebFetch, Read, rzem-memory MCP (read and write, tagged), Hugging Face MCP | none | none | glossary, handoff |
| `fleet-steward` | Weekly: diff the models list, read release notes and the Claude Code changelog, run the migration checklist over every agent, open a board item with proposed diffs | `sonnet` | medium | Bash, WebFetch, Read, Edit (`claudecode-agents` only), board MCP (read, file, comment), rzem-memory MCP (read) | none | none | glossary, handoff, board, migration-checklist |

Notes that matter:

The `lead` is the most consequential definition in the fleet and the cheapest to get wrong. Its body is the delegation policy and nothing else: what goes to whom, the escalation rules (deeper review effort when a diff touches auth or secrets, `opus` for anything `tech-writer` produces with an external audience, `/model fable` for architecture sessions and nasty debugging), the four-heading handoff format, and the rule that planning happens with the built-in Plan agent and stops for your approval. That's cheaper and more testable than teaching the same policy in CLAUDE.md.

The `reviewer` gets no write tools. The single most common failure in review agents is that they fix the thing and the diff you approve isn't the diff you read. Two-stage review is worth it: a Sonnet mechanical pass (lint, tests, obvious smells, via the official `pr-review-toolkit` plugin) and then the Opus verdict.

The `coder` runs in a worktree (`isolation: worktree`) so parallel coders don't trample each other and a bad run is a `git worktree remove` away. Agent Teams do not isolate; if you use teammates for implementation, partition by directory in the plan. Worktree hygiene matters here: Agent view auto-moves background sessions into `.claude/worktrees/`, and deleting a session there deletes uncommitted work with it.

Everything ships in the plugin, but keep the local escape hatch in view: plugin agents can't carry `hooks`, `mcpServers` or `permissionMode`, so any agent needing one of those has to exist as a local copy in `~/.claude/agents/`. That's why `context7`, once installed, is scoped to the `coder` locally (section 9) and why per-agent `permissionMode` is a local-copy trick (section 12). Same rule applies if you ever add an agent that touches personal material: it stays out of the shared repo.

Fable 5.1 is not in the table on purpose. It's the model you switch the lead to, not a subagent model, for the reasons in section 5.

Every agent returns a handoff with the same four headings: Done, Not done, Unverified, Decisions needed. Lines under Decisions needed are typed - `Blocker:` for anything that stops the work until you answer, `Propose item:` for new board work, `Propose memory:` for something worth filing in rzem-memory - because three consumers read that section and only the first should land in your queue. The lead can then merge a stack of handoffs without re-reading a stack of transcripts. The format lives in one `handoff` skill preloaded everywhere and is enforced by a `SubagentStop` hook.

## 5. Model selection: the evidence

Prices from platform.claude.com/docs/en/about-claude/pricing on 6 Sep 2026, USD per million tokens. Batch is half price on every model. The full 1M context is standard-priced on 4.6 and later; there is no long-context surcharge.

| Model | Input | Output | Cache read | 5m cache write | Context / max out | Retire not before |
|---|---|---|---|---|---|---|
| Fable 5.1 (`claude-fable-5-1`) | $10 | $50 | $0.25 | $12.50 | 1M / 128K | 1 Sep 2027 |
| Opus 5 (`claude-opus-5`) | $5 | $25 | $0.50 | $6.25 | 1M / 128K | 24 Jul 2027 |
| Sonnet 5 (`claude-sonnet-5`) | $2 | $10 | $0.20 | $2.50 | 1M / 128K | 30 Jun 2027 |
| Haiku 4.5 (`claude-haiku-4-5`) | $1 | $5 | $0.10 | $1.25 | 200K / 64K | 15 Oct 2026 |

Benchmarks Anthropic actually published (they stopped reporting SWE-bench Verified, GPQA Diamond and tau2-bench from Opus 4.8 onward, so anything quoting those for 5-family models is third-party):

| Benchmark | Fable 5.1 | Opus 5 | Sonnet 5 | Mythos 5 | Fable 5 | Opus 4.8 |
|---|---|---|---|---|---|---|
| Terminal-Bench 4.0 | 55.8% | 52.3% | not published | not published | 42.0% | not published |
| Terminal-Bench-Science | 52.6% | 29.0% | not published | not published | not published | not published |
| SWE-bench Pro | not published | not published | 63.2% | not published | 80.3% | 69.2% |
| HLE (with tools) | 65.0 | 63.6 | 57.4 | 64.5 | not published | 57.9 |
| ARC-AGI-2 (ARC Prize verified) | 90.0% | 90.4% | not found | not published | 89.2% | not published |

Anthropic didn't publish a Fable 5 HLE figure; the announcement says only that Fable 5 "performs closer to Opus 4.8" on that row because of safeguard fallbacks. Mythos 5 has its own column so nothing borrows a number from a model it isn't. OSWorld is left out because Anthropic switched from OSWorld-Verified to OSWorld 2.0 mid-year and the numbers aren't comparable; for the record Sonnet 5 posted 81.2% on OSWorld-Verified, which is why it's the computer-use pick.

What the table says: Opus 5 sits within four points of Fable 5.1 on Terminal-Bench 4.0, within two on HLE, and actually ahead on ARC-AGI-2, at half the price. That's the whole argument for Opus as the default. The gap is real and large on the hardest agentic work (Terminal-Bench-Science: 52.6% against 29.0%), which is why Fable is the lead's escalation rather than absent. Sonnet 5 is a different tier (63.2% SWE-bench Pro against Opus 4.8's 69.2% and Fable 5's 80.3%) but it's excellent at writing, reading and computer use, which is exactly the shape of the `tech-writer`, `researcher` and `scout` jobs, and it costs 40% of Opus.

Haiku 4.5 is the one model in the table nothing runs on. It's eleven months old, has a 200K window and a February 2025 cutoff, and its retire-not-before date of 15 October 2026 falls five weeks after this plan. Sonnet 5 at `low` effort does the `scout` job with a 1M window and a June 2027 floor, at twice the token price and none of the migration risk. The steward should flag the day a Haiku 5 appears, and `scout` is the first agent to re-test when it does.

One number worth knowing on API: Fable 5.1's cache read is $0.25 against a $10 base, or 2.5%. Opus 5's is $0.50 against a $5 base, or 10%. Fable's cache-read ratio is a quarter of Opus's, so a long session that's mostly cache hits narrows the Fable/Opus cost gap considerably. This matters for the home lab, not for Max.

Max specifics: Pro doesn't include Fable at all; Max 5x and 20x include Fable 5 and 5.1 up to 50% of weekly usage. Limits are one shared weekly cap across all models plus 5-hour windows; the 5-hour windows were doubled in May 2026. There is no documented Opus-only weekly cap today. Fable also draws roughly twice what an Opus session does (secondary source, not Anthropic), which is why it's a lead escalation rather than a subagent model: put it in an agent that fires twenty times an hour and you hit the wall on Wednesday. Two open Claude Code issues (#79337, #79412) report Fable with the 1M context beta header being wrongly billed as credits on Max (check which model string the issues actually name before quoting them), so if a Fable session suddenly says "usage credits", that's them.

Effort is the other dial. It's per-agent frontmatter (`low` to `max`) and it moves token spend as much as model choice does. The Opus 5 migration guide says explicitly that effort was recalibrated: rerun a sweep rather than assuming your 4.x settings carry over.

## 6. Memory: three layers, no sync

The rule: memory that's Claude-written and machine-local is not a source of truth. Anything you'd be upset to lose gets promoted into git or into the memory server. Nothing gets synced between machines, because nothing that matters lives on one machine.

Layer one, project facts (committed to the repo): `CLAUDE.md` for facts and conventions under 200 lines, and `.claude/rules/*.md` with `paths:` globs for conventions that only apply to some files. This is what cloud sessions see. `/doctor` will tell you when CLAUDE.md is bloated.

Layer two, per-agent memory, on the rzem-memory server. This replaces Claude Code's file-based `memory: user` and `memory: project` scopes and the `~/.claude/agent-memory/<agent>/` directories they write to - every agent in the roster has `memory: none`. Instead, each agent has its own credential to the server, and the credential fixes the namespace: `coder` writes into `coder`'s memory, `reviewer` into `reviewer`'s, and each can read its own across every machine and every cloud session without anything being copied anywhere. The server dedupes near-duplicates and supersedes stale entries, which is the consolidation `/dream` was doing for the file version. Ten credentials is ten non-human identities with a scope and a lifecycle, which is section 12's point made concrete. They live in 1Password and the install script places them.

Claude Code's auto memory (`~/.claude/projects/<repo>/memory/MEMORY.md`) still exists and still loads its first 200 lines. Treat it as per-machine scratch: useful in the session, never promoted, never synced. Set `CLAUDE_CODE_PROJECT_DIR_NAME` so worktrees of the same repo share it, which is what parallel coders want.

Layer three, the shared corpus on the same server: the `thoughts` store and the synced `documents` vault, with corpus and taint labels on everything that comes back. Practitioner writeups in 2026 mostly don't recommend rolling your own here, and the stated failure mode ("a wrong memory is worse than no memory") is right, but you've already built it, you already label corpus and taint, and it's your selling point. Every agent reads it. An agent that can't ask "what did we decide about this last time" re-derives it badly or asks you, and both are more expensive than the query. Writes to the shared corpus are the part to ration: a `coder` filing "we decided to use X" from a half-finished worktree run is exactly how a corpus rots. So shared writes belong to `researcher` (tagged) and the lead only. Everyone else writes a `Propose memory:` line under the handoff's Decisions needed heading and one of those two files it, the same pattern as `Propose item:` for board work in section 7. The labelling convention rides in the bodies that write (`researcher` and the lead) until a `using-memory` skill ships; the bodies preload no skill that does not resolve. mem0, Zep, Letta and claude-mem are all skippable for you: mem0 would duplicate what you have, Letta is a competing harness, claude-mem's value (semantic search over months of transcripts) is only worth a daemon if you find yourself wanting it.

The thing people forget about subagent memory: the main session's auto memory is not passed to subagents (only forks inherit it). With layer two on the server, that stops mattering - a fresh subagent's own namespace is the first thing it can reach, from any machine.

## 7. Task tracking: the board plus native tasks, nothing in between

Two layers only. The board - one markdown file per item under `.boards/` in the repository, written only through the plugin's own `board` binary, which commits every write - is the human-facing backlog and the visible view; Claude Code's native task list (`TaskCreate`, `blockedBy`, persistent via `CLAUDE_CODE_TASK_LIST_ID`, shared with Agent Teams) is the execution layer inside a session. Nothing sits between them. The mapping rule lives in the glossary: an item may spawn many tasks; a task never creates a board item on its own.

The structure is one config and one file per item. `.boards/config.yml` carries the `statuses` list that the columns are; a project is the repository. `.boards/tasks/` carries one file per issue, in a project, with a milestone where there is a real date and sub-issues as sub-tasks, `BD-12.1` under `BD-12`. A goal spanning projects is a shared milestone or a document. One repository, one board: the queue you look at is this project's, and a view across repositories is a later piece of work.

The board is the task files grouped by status, five columns:

| Column | Meaning | Who moves it |
|---|---|---|
| To do | Filed, not started | You, or an agent proposing work |
| Doing | An agent has picked it up | `SubagentStart` hook |
| Blocked | Waiting on something that isn't you - a build, an API, another task, or a subagent that failed or was cancelled | `SubagentStop` on `status: failure` or `cancelled`; `TaskCompleted` when tests fail |
| Blocked by human | Waiting on your decision. **The human queue** | `SubagentStop`, on a `Blocker:` line in the handoff |
| Done | The agent finished and tests passed | `TaskCompleted` hook |

There's no "success" column. Whether a done item was actually any good is an outcome label on the item (`outcome/shipped`, `outcome/abandoned`, `outcome/superseded`), not a second terminal column for things to get stranded in.

In the fleet, status writes are a hook, never an instruction. Three hooks cover the board. `SubagentStart` writes Doing when the lead spawns an agent. `SubagentStop` reads `status` and `last_assistant_message`, writes Blocked on failure or cancellation, and Blocked by human on a `Blocker:` line. `TaskCompleted` writes Done when tests pass and Blocked when they don't - the exit-2 gate and the board write are one hook with two outcomes, and the write happens on both paths. Each calls the `board` binary against the repository's `.boards/`, and the binary commits the write. This is the deliberate answer to the objection that agents don't file work spontaneously and that CLAUDE.md nagging fades - both true, which is exactly why the board is written by machinery rather than by asking nicely. Fleet agents never have to remember to update anything. The one place that isn't true is Angus: Cowork has no hooks, so the assistant layer writes the board by instruction, which is why `system.md` carries three board invariants rather than none.

**The human queue is the whole point.** Every handoff already ends with a Decisions needed heading (section 4). Until now that content sat inside transcripts, which meant finding it required reading ten of them. The `SubagentStop` hook parses `last_assistant_message` for `Blocker:` lines under Decisions needed and moves the corresponding item into "blocked by human" with the blocker text as a comment. `Propose item:` and `Propose memory:` lines never touch the column; the lead handles those. Your one monitoring responsibility is that column.

It reaches you two ways. A scheduled task at 8am and 4pm Sydney time reads the queue and messages you a short list: what's blocked, on what, and for how long. Separately, anything sitting in the queue for more than four hours between 8am and 6pm Sydney escalates immediately, because the failure this is meant to prevent is an agent parked for a day while you're heads-down elsewhere.

The plugin ships the board's MCP server; scope it to `spec-writer`, `fleet-steward` and the lead - the three that create and read items. Not to `coder`. This is the general rule and it's worth stating once: every MCP server's tool list is paid for on every turn of every agent that carries it, so use `disallowedTools` with `mcp__*` patterns on the agents that don't need one. Context budget is a real budget. rzem-memory is the deliberate exception - it goes to all ten (section 6) because cross-session recall is worth the tool list, and because it's your server and you control how wide that surface gets. Keep it narrow. Everything else, including the board, stays scoped.

Note that hooks can't call MCP tools - they run as shell on the host - so the status writes go through the `board` binary, reached by the shim at `${CLAUDE_PLUGIN_ROOT}/board/board.sh`, which finds the repository's `.boards/` from the hook's working directory through git. No token and no network: the board is files, and section 12 has one sentence to say about it.

Backlog.md is what the board is: its MIT code is carried into the plugin at a pinned commit rather than depended on as a binary, so the git-native tracker some people add as a third layer is the first layer here, readable without a tool from any clone. beads on Dolt, task-master and BMAD are all too heavy for one person.

## 8. Skills versus CLAUDE.md versus rules

Slash commands and skills are now the same mechanism, so there are three places to put an instruction and one rule each:

CLAUDE.md is for things that must be true on every turn and fit in a sentence: stack, conventions, the glossary pointer, where specs live, "Australian English, hyphens not em dashes". Under 200 lines, no procedures. `@import` up to four hops if you want to compose it. Cowork skips a symlinked `~/.claude/CLAUDE.md`, so the install script copies that file rather than linking it.

`.claude/rules/*.md` is CLAUDE.md that only loads when matching files are open: the Drizzle conventions load when a file under `src/db/**` is touched, not always. Rules without `paths:` load unconditionally. `~/.claude/rules/` gives you the same at user scope.

Skills are procedures: multi-step, invoked when needed, with their own `allowed-tools`, `model`, `effort`, `context: fork` and `paths:` if they should only trigger in some places. The `skills:` field on an agent preloads the full body at startup, so the agent doesn't have to discover it. That's the mechanism for "copy the skill into the agent": don't. One skill file, preloaded into as many agents as need it, changed in one place. The one exception is a three-line invariant (never force-push, never edit `.env`) which is cheaper as a sentence in the agent body than as a preloaded skill.

The glossary is the test case for that rule, because it needs to be in two places at once: preloaded into every agent, and loaded unconditionally at project scope for the lead session. So `skills/glossary` is canonical and a build step in the claudecode-agents repo generates `claudecode-agents/templates/rules/glossary.md` from it. Two copies exist; only one is edited. A Notion copy was planned in v0.3 and dropped: Cowork's Angus gets the board vocabulary from the `board` skill and its system prompt, and a third copy that an agent had to republish was one more thing to drift.

Migration of what you have: `brainstorming`, `docwright`, `angus-voice`, `humanize`, `cyber-identity-docs`, `design-studio`, the Electron/React stack suite and `using-memory` all move into the plugin as-is. The grilling interview went the other way, folded into `spec-writer`'s body rather than shipped as a skill. Five new ones: `glossary` (section 3), `handoff` (the four-heading format with typed Decisions needed lines, preloaded into every agent and enforced by the `SubagentStop` hook), `migration-checklist` (section 11), `compound` (section 9) and `board` (the column semantics, the Decisions needed to human-queue mapping, and the item conventions - section 7). Two more the roster assumes and this plan hasn't specified: `tdd` for the coder and `review-checklist` for the reviewer - see section 15. `skill-creator` stays local because it's a workbench, not a dependency.

## 9. Plugins

Adopt from `claude-plugins-official`: `context7` (not installed yet; when it is, scoped to `coder` only and named in the body only once `claude mcp list` shows it, per the contract's section 6), `pr-review-toolkit`, `commit-commands`, `security-guidance`, `typescript-lsp`, `plugin-dev` (for building your own), and `ralph-wiggum` from the claude-code repo for test-green loops, always with `--max-iterations`. The board's MCP server ships inside this plugin, scoped per section 7. Anthropic says plainly it doesn't audit bundled MCP servers, so read `.mcp.json` before trusting a plugin from anyone else.

Borrow, don't install: superpowers (281k stars, single maintainer, real ceremony on small changes) and compound-engineering (25k stars, the `/ce-compound` "write learnings back" step is the best idea in the space). You already have brainstorming, and the grilling interview is folded into `spec-writer`; what you don't have is a `compound` skill that captures learnings into rules and skills at the end of a unit of work. Write that one yourself. wshobson/agents and VoltAgent are prompt libraries to mine for frontmatter patterns, not marketplaces to enable; 200 agents in the delegation menu makes the lead worse at picking. spec-kit's vocabulary is already in the glossary.

Skip: claude-mem, task-master, BMAD, davila7/claude-code-templates (stale since Nov 2025), GSD (repo archived June 2026, fork in flux), Kiro.

## 10. Distribution and sync

The repo is `claudecode-agents` (`https://github.com/rzem-ai/claudecode-agents.git`, private GitHub). It's a plugin marketplace with one plugin, versioned with semver, and it's the only thing every environment needs to know about.

```
claudecode-agents/
  .claude-plugin/marketplace.json     # name: rzem, plugins: [claudecode-agents]
  claudecode-agents/
    .claude-plugin/plugin.json        # version bumped on every change; the cache ignores unbumped versions
    agents/                           # lead, scout, spec-writer, coder, reviewer, refuter, ui-designer, tech-writer, researcher, fleet-steward
    skills/                           # glossary, handoff, board, migration-checklist, compound, plus the migrated set
    hooks/hooks.json                  # SubagentStart -> Doing; SubagentStop handoff check -> Blocked / Blocked by human; TaskCompleted gate -> Done / Blocked
    workflows/                        # spec-to-plan, review-round, deep-research variants
    commands/init.md                  # /claudecode-agents:init - per-project setup in one pass
    commands/kickoff.md               # /claudecode-agents:kickoff - preflight the install, check or set up the board, then start the spec pipeline
    templates/
      project-settings.json           # extraKnownMarketplaces + enabledPlugins + agent, merged into each repo's .claude/settings.json
      CLAUDE.md                       # skeleton with the glossary pointer
      rules/glossary.md               # generated, do not edit
    CHANGELOG.md
  evals/                              # one smoke eval per agent, run by claude -p in CI
  evals/lib/check-all.sh              # every deterministic check; no model, no network, no board
  docs/fleet-plan.md                  # this document, kept current by the steward's PRs
  docs/agent-contract.md              # what every agent body conforms to; the migration checklist checks against it
  docs/runs/                          # run articles, one per substantial run, per the run-article skill
  home/                               # user-scope files: settings.json, CLAUDE.md, rules/, local agent copies
  scripts/gen-glossary-rule.sh        # skills/glossary -> claudecode-agents/templates/rules/glossary.md
  scripts/install-home.sh             # copies home/ into ~/.claude, renders secrets from 1Password
  README.md                           # the front door: what the claudecode-agents repo is and how to use it
```

How each environment gets it:

Every machine runs `scripts/install-home.sh`, which copies `home/` into `~/.claude` - `settings.json`, `CLAUDE.md`, `rules/`, and the local agent copies (section 4) - renders secrets with `op read` from 1Password - the ten per-agent memory credentials - and builds the board binary into `~/.local/bin/board`; the board itself is created per repository by `/init`. A `case` on hostname handles the one or two things that differ per box. `~/.claude/projects/`, sessions, history, debug and `plugins/cache` are never touched. The plugin itself is installed at user scope from the marketplace, so `claude plugin marketplace update rzem` plus the install script is the whole sync story, and there is no dotfiles manager.

Every project repo carries `.claude/settings.json` with `extraKnownMarketplaces` pointing at `claudecode-agents`, `enabledPlugins` set to `{"claudecode-agents@rzem": true}` and `agent` set to `claudecode-agents:lead`, so the session runs as the lead. On folder trust, the plugin auto-installs. That's what makes Claude Code on the web work: the cloud session trusts the repo, reads settings, pulls the plugin. Private repos need credentials for auto-update; pin a `ref` or `sha` in the marketplace entry for the stable channel and keep a `latest` marketplace on a branch for testing.

The home lab's Agent SDK agents point `settingSources` at the same plugin's skills directory. Angus and Mabel keep their own personas and memory; they just stop having second copies of the shared writing skills.

Versioning rule: if `plugin.json` has a `version`, clients keep the cached copy until the number changes. Bump it or nothing updates. Pin exact versions for anything with hooks.

## 11. Keeping it current

This is the bit you asked about and the bit almost nobody builds. The `fleet-steward` runs weekly as a scheduled task (Cowork scheduled task or a Claude Code routine; on the home lab, a cron) and does four things.

It diffs `GET https://api.anthropic.com/v1/models` against last week's list and reads the platform release-notes RSS (`platform.claude.com/docs/en/release-notes/feed.xml`), the Claude Code `CHANGELOG.md` and the deprecations page. Any new model, new alias target, retirement date or new frontmatter field becomes a Tasks item under an "Agent fleet" project with the source quoted.

When a model ships, it runs the `migration-checklist` skill over every agent body. The checklist is lifted from Anthropic's own Opus 5 migration guide and will grow: strip "double-check your work" scaffolding (over-verification and over-delegation on 5-family models), add explicit length constraints, rerun the effort sweep, remove any `temperature`/`top_p` in SDK code, expect 1 to 1.35x tokeniser inflation, check that skills with `model:` overrides still name valid aliases. Output is a PR against `claudecode-agents`, not a merge.

It runs the evals on that PR: one smoke eval per agent (three to five prompts, a rubric, a baseline score) via `claude -p` in the claudecode-agents repo's CI, and `skill-creator`'s eval runner for skills whose triggers changed. The team that caught the April 2026 Claude Code regression in 72 hours had evals; the ones that took six weeks didn't.

It runs `cc-plugin-audit` (SHA-256 manifest of installed plugins, diff on silent updates) and reports any third-party plugin whose content changed without a version bump. Renovate has no Claude plugin manager yet (discussion opened April 2026, no issue filed), so this is the substitute.

The steward never merges. It files, proposes, and stops. The definitions change when you approve the PR, and the plugin version bump in that PR is what propagates the change everywhere.

## 12. Security

Your day job, and the fleet is an attack surface. Two CVEs this year: a repo's `.claude/settings.json` SessionStart hook executing before the trust prompt (CVE-2025-59536, 8.7) and `ANTHROPIC_BASE_URL` exfiltrating auth headers (CVE-2026-21852).

Mitigations that belong in the plan:

- `--setting-sources user` or `disableAllHooks` when opening untrusted repos.
- `permissions.deny` on `~/.ssh`, `~/.aws`, `.env`, Vault tokens and `curl | bash`.
- `/sandbox` for bash, with the `sandbox.credentials` deny list actually populated - an empty list protects nothing.
- `@anthropic-ai/sandbox-runtime` before any unattended `--dangerously-skip-permissions` run.
- Read `.mcp.json` in any third-party plugin before enabling it (section 9); the steward's `cc-plugin-audit` run catches silent changes after that.
- Secrets on the host: the ten per-agent rzem-memory credentials, and nothing for the board, which is files in the repository with no token and no network. The credentials live in a dedicated 1Password vault holding fleet secrets only. `scripts/install-home.sh` renders them with `op read` into `~/.config/claudecode-agents/` at mode 600, and that directory goes in the `permissions.deny` list alongside `.env`. Hooks run outside the agent's permission model, so a hook may read that directory where the agent can't. Never have a hook call `op read` at runtime - it adds latency to every subagent start and stop, and if `op` is locked the hook silently stops doing its job.
- The lab boxes have no one to touch a fingerprint reader, so `op` there authenticates with a 1Password Service Account. That token is the one secret provisioned by hand per lab machine; scope it to the fleet vault so it can't read your personal items.

Note that hooks and MCP servers run on the host under `/sandbox` alone, so sandboxing bash is not sandboxing the session.

One consequence of section 7. The board travels with the repository, so client material on a board is exactly as exposed as the repository it is in - no more, no less - and an item you would have to redact before showing a client belongs in a repository that client can see, or not on a board at all.

Permission profiles don't exist as a feature (issue #35527 closed, not planned). Emulate them: alternate settings files plus shell aliases (`claude-safe`, `claude-yolo`), and per-agent `permissionMode` on the local copies.

And the identity angle you'll enjoy: each subagent is a non-human identity with a tool scope, an owner and a lifecycle; the home lab's API keys are NHIs in Vault; the fleet is a small worked example of the governance you sell.

## 13. Loose ends worth building

Evals. Without them "update the agents for the new model" is guesswork. Principle 5, specified in section 11, defined in section 3, and the single thing most likely to get skipped in Milestone 2.

Cost and usage visibility. `ccusage` reads the local JSONL for daily/weekly/session views and a statusline. For anything better, Claude Code's OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP or Prometheus, metrics for cost, tokens and sessions, plus per-interaction spans under the enhanced telemetry beta) should land in the home lab's Postgres or a Grafana next to it. Per-agent attribution is the point: you want to know that `researcher` ate 60% of the week.

Human gates. A `TaskCompleted` hook that exits 2 unless tests pass keeps a coder from marking itself done; plan approval before teammates edit is the same idea one level up. Specs stay human-written or human-edited: the cited eval had developer-written specs at +4% task success and LLM-written ones at -3% with 20% more cost.

Cross-session messaging and `claude agents` (agent view) now cover multi-machine coordination natively. Check them before extending A2A to the fleet; the fleet probably never needs A2A at all.

## 14. Build order

Milestone 1 (a weekend): the claudecode-agents repo, the marketplace, the `glossary` and `handoff` skills, the nine shared agents with bodies of under 60 lines each, the glossary generation script, the templates, and one project wired up. Run `/init` so the repository has its `.boards/config.yml`, install `pr-review-toolkit`, create the fleet vault in 1Password with nine agent credentials, and run the install script.

Milestone 2 (following week): the `board` skill, the board-write hooks, the human-queue digest as a scheduled task with four-hour escalation, `migration-checklist` skill, smoke evals in CI, `TaskCompleted` gate, `ccusage`, `permissions.deny` and sandbox settings.

Milestone 3: `fleet-steward` on a weekly schedule, OpenTelemetry into the lab, the `compound` skill, Agent SDK `settingSources` pointed at the plugin.

Milestone 4: measure for a month, then decide about Agent Teams for implementation, and whether Sonnet 5 can take over `coder` for routine issues. The Backlog.md decision that sat here was taken on 18 September 2026 (section 7).

## 15. Open decisions for you

Whether `ui-designer` is Opus or Sonnet: the design judgement argues Opus, the volume of HTML prototypes argues Sonnet. I've put Opus and would move it if the weekly cap bites.

Whether `tech-writer` should be `inherit` rather than `sonnet`, so it follows the lead up to Opus for the pieces that matter. The escalation now lives in the lead's policy, so `inherit` would be the mechanism rather than a second rule.

Whether `tdd` and `review-checklist` are new skills you write, or three-line invariants in the `coder` and `reviewer` bodies. Answered 12 September 2026, prompted by the opencode-agents port's findings: inline in the bodies for now - `coder` carries test-first as a procedure step and `reviewer` carries the checklist dimensions in its step 2 - and the frontmatter names were stripped, because a body naming a skill that does not resolve tells the agent a procedure is loaded when it is not. If either grows past a few lines, it becomes a real skill and returns to the frontmatter.

Whether to keep a `latest` marketplace channel at all, or just test on a branch checkout with `claude plugin install ./claudecode-agents`.

## Sources

Anthropic docs: sub-agents, skills, memory, plugins, plugins-reference, discover-plugins, plugin-marketplaces, agent-teams, workflows, settings, settings-reference, monitoring-usage (code.claude.com/docs/en/...); models overview, pricing, model-deprecations, release-notes, models/opus-5/migration-guide, api/models/list (platform.claude.com/docs/en/...). Announcements: anthropic.com/claude-fable-and-mythos-5-1, /news/claude-opus-5, /news/claude-sonnet-5, /news/claude-fable-5-mythos-5, /news/claude-opus-4-8, /news/higher-limits-spacex. ARC Prize verified results: arcprize.org/results/anthropic-claude-fable-5-1 and -opus-5. Support: support.claude.com articles 15424964 (Fable on your plan), 11049741 (Max), 11145838 (Claude Code on Pro/Max). Claude Code issues #79337, #79412, #35527, #36693. 1Password: developer.1password.com (CLI `op read`, service accounts). Ecosystem: github.com/obra/superpowers, EveryInc/compound-engineering-plugin, wshobson/agents, steveyegge/beads, MrLesk/Backlog.md, ryoppippi/ccusage, STRML/cc-plugin-audit, anthropics/claude-plugins-official, anthropics/claude-code (ralph-wiggum, CHANGELOG). Security: research.checkpoint.com CVE-2025-59536 writeup; bartlomiejkrupa.dev sandboxing ladder. Practitioner pieces: ranjankumar.in (testing your setup), developersdigest.tech (fleet management), ianbull.com (beads), paddo.dev (tasks vs beads), dev.to/izgorodin (memory map 2026).
