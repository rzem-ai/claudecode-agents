# Working on the claudecode-agents repo

This file is for any coding agent changing the claudecode-agents repo itself, whatever harness it runs in. It says what the repo is, what to run before claiming a change works, how a release happens and which writing rules hold. It is short because the long answers live in `docs/`; when this file and a document under `docs/` disagree, `docs/fleet-design.md` wins and this file is the one that is wrong.

## What this is

A Claude Code plugin marketplace named `rzem` with one plugin in it, `claudecode-agents`. The plugin is a fleet of eleven role-shaped subagents, the skills they preload, the hooks that move a board as agents start and stop, the board binary, three workflows that chain the roles, and the commands a human runs. `README.md` is the front door and covers installing; `docs/fleet-design.md` is the design and the reason behind every choice, and "design section N" anywhere in the repo means that file.

```
.claude-plugin/marketplace.json   the marketplace; carries the plugin version a second time
claudecode-agents/.claude-plugin/plugin.json   the plugin manifest; the version that clients cache on
claudecode-agents/agents/         one body per agent, frontmatter plus prose, checked against docs/agent-contract.md
claudecode-agents/skills/         shared skills; glossary is the fleet vocabulary and generates a rule file
claudecode-agents/hooks/          board-subagent-start, board-subagent-stop, board-task-completed, enforce-agent-scope
claudecode-agents/workflows/      spec-to-plan, review-round, deep-research
claudecode-agents/commands/       init, kickoff, work, board, prune-worktrees
claudecode-agents/board/          the board binary, a pinned fork of Backlog.md with its own LICENSE and NOTICE.md
claudecode-agents/templates/      what init copies into a project
evals/                            one smoke eval per agent and, under lib/, every deterministic check
docs/                             fleet-design.md, agent-contract.md, limits.md, plans/, runs/
home/ and scripts/                the user-scope files and the install script for a machine that runs the fleet
```

## Before saying anything works

Run the deterministic suite once and read its output:

```bash
bash evals/lib/check-all.sh
```

It covers the hook contracts, the roster (every agent named in the README table, the SubagentStop matcher, the evals and the design must agree), the glossary rule being current, the handoff-check parity with the production hook, and the workflow logic tests. It needs `jq`, `python3` and `node`, no model, no network and no board. Run it once per command: a doubled run blows the two-minute shell timeout, so capture the output and grep that rather than running it again. The smoke evals under `evals/` call `claude -p` and cost money; `evals/run.sh --list` shows them, `evals/run.sh <agent>` runs one, and they are not part of CI on purpose.

A change to an agent body or a skill's frontmatter also runs the `migration-checklist` skill over it before a PR opens. Most of its failures are silent in production: an agent loses a tool or a skill and never says so.

## Where a change goes

- **An agent's behaviour** changes in its body under `claudecode-agents/agents/`. The frontmatter carries model, effort, tools and preloaded skills; `docs/agent-contract.md` is the shape it must keep. Every agent ends with the same four-heading handoff, defined by the `handoff` skill and enforced by the SubagentStop hook, so a change to the handoff format touches the skill, the hook, `evals/lib/handoff-check.sh` and the parity test together.
- **The board** moves only through hooks; no agent body and no command writes a status. The per-agent tool boundaries that session permissions cannot express live in `enforce-agent-scope.sh`. Both have contract tests under `evals/lib/`, and a new rule goes in with its failing test first.
- **Vocabulary** changes in the `glossary` skill, then `scripts/gen-glossary-rule.sh` regenerates `claudecode-agents/templates/rules/glossary.md`. Never edit the generated rule by hand; the suite fails if it is stale.
- **A deliberate gap** is recorded in `docs/limits.md` with its reason. Anything there that becomes a rule, a hook or a test leaves the file the same day.
- **The board binary** is a fork at a pin, not a dependency. Trim it by deletion, port upstream changes by hand if wanted, and keep `LICENSE` and `NOTICE.md` under `claudecode-agents/board/` intact.

## Releasing

A release is a version bump in `claudecode-agents/.claude-plugin/plugin.json`, mirrored in `.claude-plugin/marketplace.json`, on a commit whose subject starts with the version (`v0.23.2: close the lead half of issue 14`). Clients keep the cached copy until the number changes, so a change without a bump is invisible to every install. There is no changelog and none should be added: git history is the record. Work happens on a branch and lands through a pull request; CI runs the deterministic suite on every push and pull request.

## Writing conventions

Australian English: organise, behaviour, colour, recognise, analyse.

Standard hyphens for asides - like this. Never an em dash, never an en dash.

No emojis anywhere: code, comments, commits or prose.

Never hard-wrap prose. One line per paragraph; code fences, tables and ASCII trees are structure and stay as they are.

Prose says "the human", never a name. Author and metadata fields are the exception. The repo refers to itself as "the claudecode-agents repo".

Say the thing once. Prefer the shorter sentence.
