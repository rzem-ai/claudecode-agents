# The board lives with the project

Author: Angus, for the human. Date: 18 September 2026. Status: spec, for the plan. Supersedes sections 4 and 9 of `docs/2026-09-17-backlog-board.md` and revises the fleet plan's section 7 a second time in one day.

## 1. What this is for

The board moved off a hosted tracker and into the memory tree on 18 September. It was one tree holding every project's items, carried between machines by the memory sync agent, and the plan called that "one place to look". Two things changed the human's mind in the same afternoon. First, every session had to be told which board and which item it was on, by an environment variable set at launch, and a running instance said as much when it asked for `CLAUDECODE_AGENTS_BOARD_PAGE_ID=BD-24` on the next start - a thing the human does not want to have to deal with. Second, other people are going to use this, and a board in one person's memory tree is not something a second contributor can clone.

The human's position, stated plainly: the board is project state, in the way `docs/plans/` is. It lives in the repository at `.boards/`, committed by default, and there is no global view. That is a reversal of "one place to look", made deliberately, with the human queue across repositories accepted as an aggregation that does not exist yet rather than a column that does.

This spec works out the technicalities the human handed over: which board, which item, and how the board and git get along without anyone having to remember anything.

## 2. The principle

A board write is a file change in the repository, made by the binary, committed by the binary, on the main checkout's current branch, never pushed. Nothing depends on a human or a lead remembering to commit it, nothing depends on a sync agent, and nothing about the board depends on which branch a coder is on. A feature branch never carries a board change unless a person put one there on purpose.

Discovery is from the working directory through git, with one rule that survives from the previous design: the board is the main checkout's `.boards/`, never a linked worktree's copy. A worktree carries a copy because the directory is committed; nothing writes to it.

## 3. Where the board is

`<repo>/.boards/`, where `<repo>` is the main checkout of the repository containing the working directory: `git rev-parse --git-common-dir` from cwd, and the directory that contains that `.git`. A cwd that is not inside a repository has no board. `CLAUDECODE_AGENTS_BOARD_ROOT` is honoured when set and names the directory that contains `.boards/`; it exists for the contract suite and for the rare deliberate override, and nothing in the fleet sets it.

Layout, unchanged from the memory tree except for the name: `.boards/config.yml`, `.boards/tasks/`, `.boards/docs/`, `.boards/milestones/`, and a `.boards/.gitignore` that ignores only `.focus` (section 6). The directory name is `.boards`, the human's spelling, and the binary's `BOARD_DIR` constant changes from `board` to `.boards`.

The config drops `projects` as a requirement. One board is one repository, so a project is the repository and the `project` field on an item is optional, kept for a monorepo that wants it. `task_prefix` stays and defaults to `BD`; `/init` offers a per-repository prefix and takes `BD` on a shrug. `default_port` is gone already. The shipped template moves from `home/board.config.yml` to `templates/board.config.yml`, because it is a project file now and not a user-scope one.

The memory tree's `board/` directory is retired: the installer stops creating it, stops adding `board` to the memory watcher's scopes, and section 10 migrates what is in it.

## 4. Git

**Commits.** After every write the binary makes - a create, an edit, a status move, a comment, a milestone or document change - it runs, in the main checkout:

```
git add -- .boards
git commit -q -m "<message>" -- .boards
```

The pathspec on both keeps the human's own staged work out of the commit: `git commit -- <paths>` records the working-tree content of those paths and ignores whatever else is staged. That cuts both ways: everything outside `.boards` is left alone, and anything inside it, staged or not, goes with the next board commit - a hand edit inside `.boards` is swept in whether the human staged it or not. The `add` is needed because a new task file is not yet known to git. The message is one line, `board: BD-24 Doing (SubagentStop)` for a status move, `board: BD-24 comment (SubagentStop)` for a comment, `board: BD-24 created` for a create, with the writer named where there is one: the hook's name, or the MCP tool's caller when the binary is asked to record one via `--by`.

The commit is soft-fail in the same sense the hooks are: the file write has already happened and stands, and a commit that cannot be made - the index is locked by another process, the checkout is mid-rebase or mid-merge, the repository has no commits yet, `.boards` is ignored - is logged and the exit is still 0. The index lock is retried three times over a second before it is logged, because two hooks landing together is ordinary. An ignored `.boards` is detected with `git check-ignore -q .boards` and skipped silently, because "can be gitignored" is a supported configuration and not an error.

The commit runs on whatever branch the main checkout has out. That is usually the default branch, and it is a local commit; the push is the human's, with their next push. Branch protection on the remote is untouched. The identity is the repository's own `user.name` and `user.email`, so a contributor's board commits are theirs.

`CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` turns the commit off, for the test suites and for a human who wants to batch. It is the only switch.

**One implementation.** The commit lives in the binary, not in the hooks and not in the MCP server separately. The CLI's write commands commit after writing; the MCP server calls the same code; the hooks call the CLI. So there is one place it can be wrong. The carried git stub gains exactly the methods this needs - add, commit, check-ignore, the index-lock retry - and `Core.shouldAutoCommit` returns the config's `auto_commit`, which the template sets to `true`. Everything else in the stub stays a throwing stub.

**Worktrees.** A hook running with its cwd in a coder's worktree resolves the root to the main checkout, so the write and the commit both land there. The worktree's copy of `.boards/` goes stale and nothing reads it; the next merge from the default branch refreshes it. A coder never writes the board - it carries no board tools, and the hooks that write on its behalf resolve past it - so a coder's branch never carries a board diff. A board diff in a pull request therefore means a person edited an item on a branch, which is allowed and is theirs to explain.

**Ids across contributors.** Sequential ids and two people creating `BD-30` on separate branches would merge into two `BD-30` files. Upstream Backlog.md answers this by consulting every branch before allocating, and that code was in the git layer this package cut. One read-only function does the same job, written fresh rather than carried, because upstream's version drags in fetching and branch-age windows this board does not want: before minting an id, list `.boards/tasks/` in every local and remote-tracking ref (`git for-each-ref` and `git ls-tree -r --name-only <ref> -- .boards/tasks`), parse the ids, and take the highest across all of them and the working tree. No fetch - what the clone knows is what is consulted - and no writes. Nothing else from the cut layer returns.

**Conflicts.** Two machines moving the same card between pushes conflict on one frontmatter line when they pull. That is the same shape as any shared file and is resolved the same way; the task file is small and the status line is one line. The previous design had the sync agent rebase for you; this one does not, and the human accepted that when they chose git over sync.

## 5. Which board

The binary resolves the root as section 3 says, from its own cwd. That is correct for every caller:

- The MCP server is started by Claude Code with the project directory as its cwd - observed on three running instances on 18 September - so `board mcp` finds the project's `.boards/` with nothing passed.
- The hooks receive `cwd` in their input and pass it to the binary as its working directory. `hooks/lib/board.sh` stops exporting a default root and instead runs the binary in the hook's cwd; the binary does the git resolution, so a hook fired from a worktree still lands in the main checkout.
- The CLI, run by a human, uses the shell's cwd.
- The web UI serves the board of the MCP process that started it, which is the project's. "The state of the instance it is connected to" is now literally true.

A hook whose cwd is not in a repository, or is in one with no `.boards/`, logs `no board here` and exits 0. That replaces the memory-tree default: there is no fallback board.

## 6. Which item

This is the launch-time variable, and it is a separate mechanism from location. The hooks already keep per-session state under `~/.local/state/claudecode-agents/sessions/<session_id>/` - the item each spawned agent was bound to, and `last-item`, the item most recently picked up - keyed by the `session_id` every hook receives. What is missing is a way for the session to say which item it is on without the human setting anything at launch.

**`task_focus`.** A new MCP tool, `task_focus <id>`, granted to the lead. It resolves the id through the binary, and writes it to `.boards/.focus` in the main checkout - one line, the canonical id. `.focus` is ignored by the shipped `.boards/.gitignore`, so it is per checkout and never committed. The lead calls it when it starts a phase against an item, as its body's routing step will say; the `/work BD-24` command is the human's way to do the same by hand. `task_focus` with no id clears it.

**Precedence in the hooks.** `SubagentStart` binds the spawn to the first of: `.boards/.focus` in the resolved root, the session's `last-item` state, `CLAUDECODE_AGENTS_BOARD_PAGE_ID`. Focus comes first because the session state is written by `SubagentStart` itself on every bind - if it came first, a focus set mid-session could never take over from the item the previous spawn was on. The environment variable drops to last so that a stale one set in a shell does not override a focus, and it is kept at all only so a scripted launch still works. `SubagentStop` and `TaskCompleted` are unchanged: they read the binding the start wrote, and `TaskCompleted` keeps its `[board:BD-12]` subject marker as the only thing that closes an item.

**Two items in one session.** `.focus` holds one id. A session working two items focuses the second before spawning against it; the task marker in the subject still wins for completion. This is the same rule as before with a tool instead of an environment variable.

## 7. The hook library

`hooks/lib/board.sh` changes in three places. It no longer exports a default `CLAUDECODE_AGENTS_BOARD_ROOT`; it runs the binary with the hook's `cwd` as the working directory and lets the binary resolve. `board_resolve` gains the `.focus` read as a fallback source. And the messages the binary commits with are passed through: the hook's name goes in as `--by <hook>`, so the commit reads `board: BD-24 Doing (SubagentStop)`. The soft-fail contract, the logging, the archive for cut comments and the identifier parsers are untouched.

The contract suite's live case creates a temporary git repository with a commit, a `.boards/config.yml` and a linked worktree, runs each hook from the worktree's path, and asserts that the item moved in the main checkout, that a commit landed there with the expected subject, and that the worktree's copy did not change. A second case sets `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` and asserts the write with no commit. A third runs a hook from a directory that is not a repository and asserts the `no board here` log line and exit 0.

## 8. Agents and the MCP server

The tool identifiers are unchanged. `task_focus` joins the server and is granted to the lead only; `spec-writer` and `fleet-steward` keep their lists. `fleet-steward` files into the claudecode-agents repository's own `.boards/`, which is inside the working copy its invariant confines it to, so its scope rule needs no change. The server's instructions line says the board is this repository's.

`coder` still carries no board tools and still never writes a column. Its worktree guard is unchanged; the board's own worktree rule is the binary's, not the hook's.

## 9. Commands and docs

- `/init` gains a board step: create `.boards/` from `templates/board.config.yml` with the `.gitignore`, offer a prefix, and remind the human that the first commit is theirs. Skips when `.boards/` exists.
- `/kickoff`'s board step checks `.boards/config.yml` in this repository instead of the memory tree, and its "binding reminder" becomes `task_focus` and `/work`, not an environment variable.
- `/work <id>` is new: focus an item by hand. `/board` is unchanged.
- The `board` skill: the opening paragraph, the columns paragraph, the `Board-Item` section's binding, the CLI table, a new "Git" section carrying section 4 in the skill's voice.
- The glossary's `Project` row maps to "the repository", and `Board` to "the task files under `.boards/` grouped by status".
- The fleet plan gets a second dated note on section 7 and section 7's opening paragraph is rewritten a second time. Section 12's client-material paragraph changes shape again: the board travels with the repository now, so client material on a board is exactly as exposed as the repository is, which is the right answer and needs one sentence.
- `hooks/README.md`: the board-root paragraph, the column-move explanation, the troubleshooting entries for a commit that did not land.
- `scripts/install-home.sh`: builds the binary as before, stops touching the memory tree.
- The changelog entry is a minor version bump, because a board that was in the memory tree is not found by this version and section 10 is a required step.

## 10. Migration

The memory tree's `board/tasks/` holds 26 items on 18 September: 25 under `Fathom`, one under `Claude Agents`, all in To Do. A one-shot script, `scripts/migrate-memory-board.sh <project> <repo-path>`, moves the items of one project into that repository's `.boards/tasks/`, renumbering from 1 in creation order and keeping the old id as a `ref` on each item, then commits once with a message naming the source. Run twice, by hand, once per project. The memory tree's `board/` is then left as it is and never read again; deleting it is the human's, when they are satisfied.

`docs/plans/BD-24.md` in the Fathom repository, the plan the running instance was waiting on, is renamed to the new id as part of the same step, because it was named after the board.

## 11. Phases

1. **The binary.** Root resolution through git, `.boards` as the directory, the commit after every write behind `auto_commit`, the cross-branch id check, `task_focus`, the `.gitignore` in the template. Tests for each, including a linked-worktree case.
2. **The hooks.** `board.sh` runs the binary in the hook's cwd, reads `.focus`, passes `--by`. The contract suite's live case becomes the git case.
3. **Commands, agents and docs.** `/init`, `/kickoff`, `/work`, the lead's routing step, the skill, the glossary, the plan, the READMEs, the installer, the changelog, a release.
4. **Migration.** The script, run against Fathom and claudecode-agents, and the Fathom plan renamed.

## 12. What this rests on that has not been observed

- That Claude Code always starts a plugin's MCP server with the project directory as cwd. Three running instances say so; the settings reference does not promise it. If a future version starts it elsewhere, `CLAUDECODE_AGENTS_BOARD_ROOT` in the plugin's `.mcp.json` `env` block, set to `${CLAUDE_PROJECT_DIR}`, is the fallback and is the first thing to try.
- That `git commit -- .boards` with a concurrent index lock resolves within three retries. It will on a laptop; a CI runner that commits in parallel is a different environment and the retry count is a constant.
- That the human's other contributors run the plugin. A clone without it has the files and no hooks, which is a readable board nobody moves; that is acceptable and should be said in the README.

## 13. Out of scope

A human-queue view across repositories. Fetching before the cross-branch id check. Auto-push. Any board outside a repository - personal and non-code items are not the fleet's board, by the human's decision on 18 September that there is no global view. Moving `.boards/` under `.claude/`. A board per branch.

## 14. Decisions taken

- Per-repository boards at `.boards/`, committed by default, no global view. The human, 18 September 2026, reversing the plan's "one place to look" on the grounds that others will use it.
- The binary commits its own writes, pathspec-limited, no push. Recommended by Angus, accepted.
- The cross-branch id check is carried back from upstream, read-only. Recommended by Angus, accepted.
- Discovery through git to the main checkout, never a worktree's copy. Angus, holding the half of the earlier reasoning that was about worktrees rather than about one place.
- `task_focus` replaces the launch-time variable; the variable is kept last in precedence. Angus, under the human's "work out the technicalities".
- The 26 memory-tree items migrate by script rather than by hand. Angus; the human chose a fresh start at the last cutover and can again by not running the script.
