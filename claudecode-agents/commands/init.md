---
description: Initialise the current project for the fleet - settings, CLAUDE.md skeleton, glossary rule, spec and plan directories, then a guided fill of every placeholder
---

Initialise this project for the claudecode-agents fleet. Work through the five steps in order, report at the end, and never overwrite anything the project already has.

Templates live in this plugin at `${CLAUDE_PLUGIN_ROOT}/templates/`. Read each one from there; never reconstruct its content from memory.

## 0. Repository

Run `git rev-parse --is-inside-work-tree` at the project root before anything else.

If it prints `true`, compare `git rev-parse --show-toplevel` with the current directory. When they match, say nothing and continue. When they differ, this directory sits inside a repository rooted elsewhere; the fleet initialises a repository root, not a subdirectory. Say where the root is and ask, with AskUserQuestion, whether to run the remaining steps at that root or stop.

If it is not a repository, the fleet cannot work here: coder worktrees, review-round diffs, run articles and the `[board:...]` task markers all assume git. Ask, with AskUserQuestion, whether to initialise one - `git init -b main` - or stop. On yes, run exactly that and continue; the first commit stays the human's, made after this command has created the skeleton, which the report already reminds them to do. On no, stop here and say that every later step assumes a repository.

## 1. Settings

Merge the three keys from `${CLAUDE_PLUGIN_ROOT}/templates/project-settings.json` into the project's `.claude/settings.json`:

- `agent` (`claudecode-agents:lead`)
- `extraKnownMarketplaces.rzem`
- `enabledPlugins["claudecode-agents@rzem"]`

If `.claude/settings.json` does not exist, copy the template as-is. If it exists, add only the keys that are missing and leave every existing key exactly as it is - including an existing `agent`, an existing `rzem` marketplace entry, and any other plugins. A key that is present but differs from the template is a conflict: report it and leave it alone rather than changing it.

## 2. Skeleton

- `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md` -> `CLAUDE.md` at the project root. If a `CLAUDE.md` already exists, do not touch it - note the skip and, in the final report, list which sections of the template (stack, conventions, glossary pointer, where work lives, writing conventions) the existing file lacks, so the human can decide what to add.
- `${CLAUDE_PLUGIN_ROOT}/templates/rules/glossary.md` -> `.claude/rules/glossary.md`. If it exists but differs from the template, replace it - the file is generated and the plugin's copy is current; never hand-merge it.
- Create `docs/specs/` and `docs/plans/` if missing.

## 2b. Board

The board is this repository's, at `.boards/`, committed like any other project file, and the fleet's hooks and the board MCP server find it from the working directory through git. Create it here so the first `/kickoff` has one to check.

- If `.boards/config.yml` exists, say so and skip the rest of this step.
- Otherwise copy `${CLAUDE_PLUGIN_ROOT}/templates/board.config.yml` to `.boards/config.yml` and `${CLAUDE_PLUGIN_ROOT}/templates/board.gitignore` to `.boards/.gitignore`, and create `.boards/tasks/`, `.boards/docs/` and `.boards/milestones/`, each holding a `.gitkeep` so an empty directory survives a clone.
- Set `project_name` in the copied config to the repository's directory name. Then offer the prefix with AskUserQuestion: `BD` (recommended) or a short upper-case one derived from the repository name, two to four letters. Write the answer as `task_prefix`.
- Say that every write the binary makes will be committed on the checked-out branch, and that `auto_commit: false` in the config or `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` in a shell turns that off.
- Say that the first commit here may end up being the board's own, if a hook fires before the human commits; that is harmless.

Renumber nothing: step 3 below stays step 3. Add `.boards/` to the reminder in step 4's report, alongside `.claude/settings.json`, as something to commit.

## 3. Guided fill

Skip this step entirely if step 2 skipped `CLAUDE.md`.

Read the project before asking anything: manifest and lockfiles (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` or equivalent), build and test configuration, the directory layout, and the last dozen commit subjects (none, in a repository step 0 just created). Draft an answer for every `<FILL: ...>` marker in the copied `CLAUDE.md` from that evidence.

Then walk the markers with the human using the AskUserQuestion tool, one topic per question, offering the inferred value as the recommended option. Markers you could not infer get an open question, not a guess. Write each confirmed value into `CLAUDE.md` as you go, and delete the marker-explainer paragraph near the top once no markers remain.

If the human declines the interview, fill the markers you inferred with confidence, leave the rest as `<FILL: ...>`, and say which remain.

## 4. Report

End with a short report: whether step 0 created a repository, what was created, what was merged and which keys, what was skipped and why, any settings conflicts, and any markers still unfilled. Remind the human to commit `.claude/settings.json` and `.boards/` (and the rest) so every clone and every Claude Code on the web session gets the same fleet.

Then say what comes next, exactly: restart Claude Code and trust the folder - the new settings, `CLAUDE.md` and (if it was not already installed) the plugin all load at session start, so nothing done here is live until then - and in the new session run `/claudecode-agents:kickoff` to verify the install and start the first piece of work.

Re-running this command is safe: every step skips what already exists, step 0 is silent in a repository, and step 3 only offers markers still present.
