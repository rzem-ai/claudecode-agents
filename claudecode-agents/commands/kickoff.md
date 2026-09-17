---
description: Preflight the fleet in this project - plugin, agents, settings, skeleton - check or set up the board and state its conventions, then take the first idea and start the spec pipeline on it
argument-hint: [the idea, in a sentence or a brain dump]
---

Kick off fleet work in this project. Run the preflight first, and start work only if it comes back green. This command is what `/claudecode-agents:init` points at after its restart, so assume nothing - the point of the preflight is to catch a half-finished setup.

## Preflight

Check each of these, collecting results rather than stopping at the first failure:

1. **Plugin.** The claudecode-agents agents are available (`scout`, `spec-writer`, `coder`, `reviewer`, `refuter`, `ui-designer`, `tech-writer`, `researcher`, `fleet-steward` and `lead` appear as `claudecode-agents:` agent types). If they are missing, the plugin is not installed or the marketplace cache is stale.
2. **Lead.** `.claude/settings.json` exists and sets `agent` to `claudecode-agents:lead`. Note, without failing, if the current session is visibly not running as the lead - that means the settings changed since the session started and a restart is needed.
3. **Skeleton.** `CLAUDE.md` exists at the project root and contains no `<FILL: ...>` markers. A marker left in place is a line the session reads literally on every turn, so surviving markers are a failure, not a note.
4. **Glossary rule.** `.claude/rules/glossary.md` exists.
5. **Work directories.** `docs/specs/` and `docs/plans/` exist.
6. **Board.** The full check-and-setup is its own step below; here just note whether the board binary answers at all - `${CLAUDE_PLUGIN_ROOT}/board/board.sh --version`. No binary means no board, which is fine and is not a failure.

If anything failed: report every failure with its one-line fix (`/claudecode-agents:init` for missing skeleton pieces, restart-and-trust for a plugin or agent problem, edit the marker for a surviving `<FILL: ...>`), and stop. Do not start work on a red preflight.

## Board

Run this step only when `${CLAUDE_PLUGIN_ROOT}/board/board.sh --version` succeeds. On a machine where the binary has never been built it will not, and that is a legitimate outcome: say so and move on. Read the `board` skill first; it is the contract this step is verifying. No board is a legitimate outcome throughout - most work is not board work, and the human declining any part of this is a note in the report, never a failure.

**Check.** The board is a directory of markdown files under the memory tree, so everything here is a file read. The root is `CLAUDECODE_AGENTS_BOARD_ROOT`, defaulting to `$HOME/.memory`:

- `board/config.yml` exists under that root. If it does not, the installer has not run on this machine; say that and stop the step. Do not write the file yourself - that is the installer's job, and guessing at it writes a board the other three machines will conflict with.
- Its `statuses` are the five the fleet uses, spelled `To Do`, `Doing`, `Blocked`, `Blocked by human`, `Done`. The hooks match them ignoring case, so a difference in case is not a failure; a different word is, and the fix is the config rather than a `BOARD_COL_*` override in `~/.config/claudecode-agents/board.env` - the override leaves every other reader seeing the odd name.
- This repo's project name is in the config's `projects` list. Match by name against the repo.
- Its `labels` carry `outcome/shipped`, `outcome/abandoned` and `outcome/superseded`.

**Setup.** Say what is missing and ask the human before changing anything - the config is one file on a memory tree four machines share. On a yes to adding this repo's project: add the name to `projects` in `board/config.yml`, then commit the memory tree with a `git -C "$CLAUDECODE_AGENTS_BOARD_ROOT"` add and commit. The memory watcher may commit it first, which is fine; what matters is that the change is committed rather than left loose in the tree, because an uncommitted config edit reaches no other machine.

**State the conventions.** End the board section by saying, concretely, what the fleet will use - so the session and the human agree before the first item is filed:

- the board root, and that the items are the files under `board/tasks/` in it,
- the prefix `BD`, so an item is `BD-12` and a sub-item `BD-12.1`,
- the five status names as the config spells them,
- the project this repo's items go in, as it appears in the config's list,
- labels: `outcome/shipped`, `outcome/abandoned` and `outcome/superseded` on an item at close, nothing else load-bearing,
- and the binding reminder: a board session launches with `CLAUDECODE_AGENTS_BOARD_PAGE_ID=BD-12`, and only a task subject carrying `[board:BD-12]` closes an item.

**What this step cannot do, said out loud.** It can see the shim answer, but not whether the binary that shim found is the one this plugin version expects. The binary is built into `~/.local/bin/board` by `scripts/install-home.sh` and never committed, so a plugin update reaches a machine long before a rebuild does. End with the one manual check: `~/.local/bin/board --version` against the `version` in `${CLAUDE_PLUGIN_ROOT}/board/package.json`. If they differ, re-run the installer. A `board shim missing at ...` line, the shim's own `board: no binary at ~/.local/bin/board ...` line, or a `board <cmd> failed (exit N): ...` line in `~/.local/state/claudecode-agents/log/hooks.log` after the first real spawn is the symptom of a board the hooks cannot reach.

## The idea

The text after the command is the idea. If there is none, ask the human one open question - what are we building, in a sentence or a brain dump, messy is fine - and wait. Do not invent a task, and do not substitute a repo TODO for an answer.

## Start

With a green preflight and an idea in hand, start the fleet's intake as the lead's routing says: an unshaped idea goes to `spec-writer`, whose interview opens the problem out before the spec closes it down - the `spec-to-plan` flow. Recall from the memory server and send `scout` ahead if the idea touches existing code, then spawn `spec-writer` with the idea verbatim, not paraphrased. From there the normal pipeline holds: the human edits the spec, the plan is written and approved, and only then does a `coder` run.

Report the preflight result either way - one line per check when green, the failure list when not.
