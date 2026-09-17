# The board moves to Backlog.md

Author: Angus, for Alex. Date: 17 September 2026. Status: design, for approval before a plan is written.

## 1. What this is for

The fleet's board has lived in Linear since 12 September, and before that in Notion. Both are servers: a hook that wants to move a card needs a key, a network, and a vendor that is up. The human's own reading of the board goes through a vendor app, and an agent that wants to know what is in flight pays for an MCP tool list on every turn.

This design moves the board into files. Backlog.md stores each item as a markdown file with YAML frontmatter, reads and writes them through a CLI that speaks JSON, and draws a kanban over them in a terminal or a browser. The files live in the memory tree, which already syncs across the four machines, so the board is wherever the fleet is. Hooks write it with one shell command and no credential. The human reads it on a phone through the same tunnel and gate as every other lab app.

The fleet plan deferred exactly this decision to Milestone 4, to be made after a month of measuring Linear. The human made it early, on the strength of the spike in section 2, chose the fuller cutover over a trial, and then chose to carry the pertinent parts of Backlog.md into the plugin under its MIT licence rather than depend on the upstream binary. Section 15 says what is carried and what is left behind. The plan's section 7 stays as the record of why the board is shaped the way it is; only the backing store changes, and the plan gains a revision paragraph pointing here.

## 2. The evidence

Backlog.md 1.52.0 was installed in a scratch directory and driven the way the hooks would drive it. Everything below was observed, not read.

- **The five columns are one config line.** `statuses` in `backlog.config.yml` accepts any list. The CLI refuses to set it through `backlog config set` and says to edit the file, so the installer edits the file.
- **A status write from a hook takes a third of a second** with remote operations and active-branch checking off, from any working directory, with `BACKLOG_CWD` naming the tree. It is not slower with them on, but they are off anyway for the reason two bullets down.
- **Auto-commit commits only its own file** and never pushes. With it on, a task create produced one commit touching one task file and left an unrelated untracked file alone. With it off, nothing touches git. The memory sync agent is the only committer either way, so it stays off.
- **Cross-branch status resolution did not work.** A status move committed on a feature branch was not reflected on main's board in three setups: local branch only, branch pushed to a remote, and the move made from a worktree and pushed. The docs claim the feature and never describe its mechanism. The design does not rely on it: the board repo is only ever on main, and no fleet worktree ever contains it.
- **A custom directory works.** `backlog init --backlog-dir board --config-location root` puts the tasks under `board/` and the config at the tree root. Upstream insists on a root config for a custom directory only at init time; the carried code reads `board/config.yml` because the root is fixed and the walk-up is gone. The memory tree's own scopes are untouched.
- **The read side is JSON with a schema version.** `task view`, `task list` and `search` take `--json`; `task list --json --watch` streams a fresh document on every change. `task view ID --json` returns status, assignees, labels, project, milestone, parent, dependencies, acceptance criteria, notes, comments and the file path.
- **Comments and notes carry an author and a UTC timestamp.** `task edit ID --comment "..." --comment-author @hook` appends a dated comment block to the file. Dates are stored as UTC with no zone marker, so a card reads ten or eleven hours early. Accepted.
- **The MCP server is stdio and exposes 20 tools:** seven task tools, five milestone tools, two definition-of-done tools, five document tools and one that returns the workflow guides. `backlog mcp start` starts it; `--cwd` or `BACKLOG_CWD` names the tree.
- **The web UI is plain HTTP on the loopback interface** with a JSON API under `/api/`, editable, and needs its own process. `backlog browser --no-open --non-interactive --port N` is the unattended form.
- **Nested help falls through.** `backlog task create --help` prints the root help. The flags below were confirmed by running them, and the board skill has to carry the reference because the tool will not.
- **The source is carriable.** Upstream at commit `aded8e2` (the 1.52.0 line, 17 September 2026) is about 65,000 lines of TypeScript outside its tests, MIT licensed, with no runtime dependencies beyond what Bun bundles. Thirty-one source files use Bun APIs directly. A `filesystem_only` config mode already exists that disables every git code path, and it is tested. The terminal UI, the shell completions, the interactive wizards and the git layer are roughly a third of the total and none of it is needed here.

## 3. The principle

Four things do not change. The board is one queue for everything the human tracks, in one place. Columns are written by machinery in the fleet and by instruction in Cowork, and the meaning of the five columns is what the board skill already says. What earns an item is unchanged. And nothing sits between the board and Claude Code's native task list.

One thing does. The board is a directory of files in the memory tree, and the truth of a card is the file. Every writer goes through the Backlog.md CLI or its MCP server so the frontmatter, the IDs, the filenames and the section markers stay consistent; nothing edits a task file by hand. The sync agent moves the files between machines the way it already moves memory, and a conflict is handled the way a memory conflict is.

## 4. The board repo

**Where.** `~/.memory/board/` on every machine, with the config at `~/.memory/board/config.yml`, so everything the board owns is under one directory. The memory tree is a full clone on marvin, slarti, trillian and eddie with the private repo `alexrzem/memory` as hub. The board is a fourth scope beside `global`, `hosts` and `projects`.

**Config.** The installer writes this file and re-runs are idempotent. The git-related keys upstream reads are gone, because the git layer is not carried:

```yaml
project_name: "rzem"
task_prefix: "BD"
statuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]
default_status: "To Do"
labels: ["outcome/shipped", "outcome/abandoned", "outcome/superseded"]
projects: ["Agents", "Angus", "art.rzem.guru", "Claude Agents", "Fathom", "files.rzem.ai", "MovingDay", "MyAssist Researcher", "OpenCode Agents", "Photos", "photos.rzem.ai", "SkillfulClaude", "Tabletop", "Tailwind Builder"]
priorities: ["High", "Medium", "Low"]
default_port: 6420
```

The project list is the fourteen Linear projects as they stand today, for the human to trim in the config file. The key spellings are upstream's, kept so the carried parser reads them unchanged.

**Identity.** The prefix is `BD`, so an item is `BD-12`. The human chose a new prefix over keeping `RZE` so that a memory note or a run article naming an old Linear number can never be mistaken for a live item. Numbering starts at 1. A sub-issue is `BD-12.1`, which is Backlog.md's native parent form and replaces Linear's sub-issue relation.

**Mapping from the glossary.** Project maps to the `project` field, chosen from the config list. Milestone maps to a milestone file. Sub-issue maps to a parent task. The outcome labels stay labels. Initiative has no home in Backlog.md and is dropped from the glossary's mapping column; a goal spanning projects is a milestone shared across them, or a document.

**Fresh start.** The board begins empty. Linear stays readable until the human closes it. Nothing is migrated, by the human's choice; anything still worth doing is re-filed by hand over the first week.

**Sync.** The memory watcher on each machine watches named scope directories rather than the tree root, because a root watch loops on its own commits. `board` joins that list in `memory-watch.sh`, so a hook's write triggers a commit, a rebase-pull and a push within the two-second debounce, with the five-minute timer as backstop. Two machines editing one task file inside one window produce a rebase conflict that halts that machine's sync until the human clears `.sync/CONFLICT`, exactly as memory does today. One item is worked by one agent on one machine, so this should be rare; the web UI on slarti shows slarti's clone, so a halted sync elsewhere shows as a stale column rather than a lost write.

**The indexer.** The memory tree's indexer and webhook are future work in the memory spec. When they are built they exclude `board/`. A task file is not a memory.

## 5. The hook library

`hooks/lib/linear.sh` is 620 lines, and about half of it is not about Linear: logging, the soft-fail contract, session state binding, the archive for cut comments, the identifier parsers for the `Board-Item:` line and the `[board:...]` task marker. That half is kept, renamed into `hooks/lib/board.sh`, and the Linear half is replaced.

**Removed:** the token file and its loader, the curl config and the request wrapper, the GraphQL resolve, state lookup, status mutation and comment mutation, and the state-name cache. `~/.config/claudecode-agents/linear.token` stops existing and the installer stops rendering it.

**Added:** three functions over the CLI, each fail-soft, each honouring `CLAUDECODE_AGENTS_BOARD=off` and the dry-run path the contract suite uses.

| Function | Runs | Notes |
|---|---|---|
| `board_resolve ID` | `board task view ID --json` | Returns the canonical ID and current status, or empty. Replaces the GraphQL resolve |
| `board_set_status ID COLUMN` | `board task edit ID -s COLUMN` | Column names come from `BOARD_COL_*` as today; the defaults now match the config exactly, so `board.env` needs no override |
| `board_comment_raw ID TEXT AUTHOR` | `board task edit ID --comment TEXT --comment-author AUTHOR` | Author is the hook's name, `@subagent-stop` and so on, so a card reads who wrote what |

`board_write` and `board_comment`, the two functions the three hooks call, keep their signatures. The comment cap and the archive for cut comments stay: a comment is still a summary and the archive is still the only copy of the rest.

**Environment.** The binary is the plugin's own `board`, found through the shim at `${CLAUDE_PLUGIN_ROOT}/board/board.sh` (section 15), never through `PATH` lookup of the upstream tool. The board's root is `CLAUDECODE_AGENTS_BOARD_ROOT`, defaulting to `$HOME/.memory`, and the binary resolves it from that variable alone: there is no walk up from the working directory and no `--cwd`, so a hook fired inside a worktree can never discover a board there by accident. An explicit value of the variable is honoured, because the contract suite and the slarti unit set it deliberately (ruled during execution; an earlier draft claimed the library's export made the variable immune to inheritance, which it does not). A missing binary is a logged soft failure, the same as a missing curl was.

**Identifier parsing.** `normalise_page_id` accepts `BD-12` and `bd-12.3` in any case and normalises to upper case. The Linear URL form and the UUID form are removed; a task file path under `board/tasks/` is accepted and reduced to its ID, because that is what the web UI and `task view --json` hand back. Anything else is not a ref and the line is treated as absent, silently, as today.

**Timeouts.** A CLI call is bounded at ten seconds by the library, inside the hooks' existing 20, 30 and 600 second budgets.

## 6. The contract suite

`evals/lib/board-hook-contract.sh` already runs offline with the board off and a throwaway config, feeding the hooks real CLI event schemas. It keeps that shape and changes in two places.

The identifier cases move from `RZE-123`, a Linear URL and a UUID to `BD-12`, `bd-12.3` and a task file path, with the URL and UUID cases becoming negative cases. And it gains one live-backend case: it creates a temporary tree with a `board/config.yml`, points `CLAUDECODE_AGENTS_BOARD_ROOT` at it, runs each hook against a real item, and asserts the status and the comment through `board task view --json`. That case is skipped with a named reason when the `board` binary cannot be resolved, so the suite stays runnable on a bare machine.

`evals/run.sh` and the check suite pick it up as they do today. The suite runs once per command, as the memory note says.

## 7. Agents and the MCP server

**The server ships with the plugin.** The plugin's `.mcp.json` registers `board` as a stdio server running `${CLAUDE_PLUGIN_ROOT}/board/board.sh mcp`, so every machine that has the plugin has the server under one deterministic name and the same binary the hooks use. The tool identifier is expected to be `mcp__plugin_claudecode-agents_board__<tool>`. That spelling is confirmed with `claude mcp list` and a live tool listing before any body is edited, and recorded in `docs/agent-contract.md` first, because a wrong server name grants nothing and raises no error.

**Grants follow the Linear pattern exactly.** The same three carry it and nobody else does.

| Agent | Allowed | Denied |
|---|---|---|
| `spec-writer` | `task_view`, `task_list`, `task_search`, `milestone_list`, `document_view`, `document_list`, `document_search` | `task_create`, `task_edit`, `task_archive`, `task_complete`, every milestone and document write |
| `fleet-steward` | the reads above plus `task_create` and `task_edit` | `task_archive`, `task_complete`, every milestone and document write |
| the lead | the whole server | nothing |

`fleet-steward`'s licence is the same as today: it files issues under its own project and comments on them, and never moves a column. `task_edit` is the only way to add a comment, so the body carries the invariant that it passes nothing but `--comment` through that tool.

**The lead** files `Propose item:` lines with `task_create`, sets the project on every item, and links `docs/specs/<id>.md` and `docs/plans/<id>.md` in the task's references rather than pasting them.

**Angus in Cowork** gets the same server registered in Claude Desktop on marvin, pointed at the same tree, and the three Cowork board rules in the board skill are unchanged.

**The Linear connector** stays installed until the human removes it; no fleet body names it after this lands.

## 8. The web UI on slarti

The web UI runs on slarti as a systemd unit in the house shape: `board.service` under `/srv/sprites/services/board/`, symlinked into `/etc/systemd/system`, running as the user that owns `~/.memory` there, with `CLAUDECODE_AGENTS_BOARD_ROOT=/home/<user>/.memory` and `~/.local/bin/board serve --port 6420`, which binds `127.0.0.1` and nothing else. Restart on failure. The unit is not a compose wrapper, so `systemctl stop` is safe.

It is published as `board.rzem.ai` by recipe 1 of the homelab skill (a tunnel rule and an nginx vhost proxying to `127.0.0.1:6420`) and gated by recipe 2 (the `auth_request` block to oauth2-proxy and Keycloak). The vhost carries the WebSocket upgrade headers in case the UI's live refresh uses one; that costs nothing and the page works without it.

An edit in the browser lands in slarti's clone and reaches the other machines through the sync. The UI reads slarti's clone, so the board the human sees is at most one sync window behind a hook on another machine.

## 9. Install and environment

`scripts/install-home.sh` changes in four places. It drops `linear.token` from the secret specs and its 1Password reference. It requires Bun, prints the one-line installer for it when missing, and builds the plugin's `board` package into `~/.local/bin/board` (section 15). It writes `~/.memory/board/config.yml` from a template in `home/` when the file is missing, and reports a diff when it exists and differs, never overwriting a hand edit. And it adds `board` to the watch list in `~/.memory/.sync/memory-watch.sh` if absent, then reloads the watcher.

`home/settings.json` loses `api.linear.app` from the sandbox network allowlist and the two Linear env denies. Nothing is added: the board needs no network and no secret.

The memory tree itself gains the `board/` directory and its config file through one commit from the first machine the installer runs on; the other three receive it through the sync before their installers run, and the installer copes with either order.

## 10. Docs and skills that change

- `skills/board/SKILL.md`: every Linear noun becomes the file form; the columns table's third column and the Cowork rules are unchanged; the `Board-Item:` section describes the `BD-12` and file-path forms; a new section carries the CLI reference the tool's help does not, and the glossary mapping paragraph loses Initiative.
- `skills/glossary/SKILL.md`: the mapping column for Initiative, Project, Milestone, Issue, Sub-issue, Board and Human queue.
- `commands/kickoff.md`: the Board section checks that the tree, the config, the five statuses and the project for this repo exist, offers to add the project to the config list, and states the conventions; the paragraph about the untestable API key goes, replaced by one about the binary and `CLAUDECODE_AGENTS_BOARD_ROOT`.
- `agents/spec-writer.md`, `agents/fleet-steward.md`, `agents/lead.md`: tool lines and the sentences that name Linear.
- `docs/agent-contract.md`: the server table row.
- `docs/fleet-plan.md`: one revision paragraph at the top, pointing here.
- `.claude-plugin/plugin.json`: description. `CHANGELOG.md`: the Unreleased entry.
- The memory note on Linear board conventions is rewritten for the new board once the cutover lands, not before.

## 11. Phases

1. **The package.** Import upstream at the pinned commit into `claudecode-agents/board/`, remove what is not carried with the compiler and upstream's own tests as the gate, replace root resolution, write the thin CLI, build a binary. Section 15.
2. **The repo and the hooks.** Board scope, config template, installer changes, `board.sh`, the three hooks, the contract suite green with the live case, on marvin first and then the three lab boxes.
3. **Agents and docs.** The plugin MCP server, the confirmed tool identifiers, the three bodies, the skills, kickoff, the contract doc, the plan's revision paragraph, the changelog, a release.
4. **The web UI.** The slarti unit, the vhost, the gate, the tunnel rule.
5. **The human queue digest.** Twice a day and the four-hour escalation were designed in the plan and never built. They read the queue with one `task list --json` and need a delivery channel chosen first. Separate design.

Phases 1 to 3 are one release. Phase 4 is lab work that follows the homelab recipes and does not touch the plugin. Phase 5 is its own spec.

## 12. What this rests on that has not been observed

- The MCP server's tool identifier under the plugin. Expected from the pattern the contract doc records for plugin servers; confirmed only when `claude mcp list` prints it.
- The web UI behind nginx and the gate. Plain HTTP on loopback was observed; the proxied, gated form was not.
- The carried package on the lab boxes. Upstream ran on the laptop under Bun 1.3.10. The Linux hosts need Bun installed and the build was not tried there.
- How much of upstream's test suite survives the trim. At the pin on the laptop the suite ran 2896 tests across 290 files with 26 failing and one erroring before any change; the tests for carried modules are expected to keep passing, and the plan's first task records the count on the importing machine.
- Whether the sync's two-second debounce and a hook's third-of-a-second write ever collide on one machine. The sync holds a lock and the CLI does not take one; the failure would be a hook write landing during a rebase and being picked up by the next commit, which is benign, but it was not exercised.
- Two machines writing one task file in one window. Predicted from the sync agent's documented behaviour, not reproduced.

## 13. Out of scope

Migrating any Linear history. The human queue digest and escalation (phase 4). An Initiative equivalent. Multi-repo boards; there is one board. Backlog.md's drafts, definition-of-done defaults and decision records, which are carried because they are entangled with the task code, but nothing in the fleet is told to use them. Tracking upstream after the import: this is a one-time fork at a pinned commit, not a subtree, and a later upstream feature is ported by hand if wanted. OpenCode, which has its own board issue on the old board.

## 14. Decisions taken

- Backlog.md replaces Linear as the board's backing store, now, rather than after the Milestone 4 month.
- One board for everything, as a `board` scope in the memory tree, synced by the existing agent. Not a dedicated repo, not one backlog per project.
- Fresh start; nothing migrated.
- Prefix `BD`, numbering from 1.
- Auto-commit off, remote operations off, active-branch checking off. The sync agent is the only committer and the board repo is only ever on main.
- The `board_write` and `board_comment` seam is kept; the library underneath is replaced and renamed.
- The MCP server ships with the plugin and is granted to the same three agents as Linear was, with the same read-versus-write split.
- The web UI runs on slarti behind the tunnel and the gate, in phase 3, as `board.rzem.ai`.
- The digest is phase 5 and its own spec.
- The pertinent parts of Backlog.md are carried into the plugin under MIT, at one pinned commit, with attribution kept. The upstream binary and package are not a dependency of anything.
- The binary is built per machine by the installer into `~/.local/bin/board`; hooks and the MCP server reach it through one shim in the plugin; the board root comes from one environment variable with one default.

## 15. Vendoring Backlog.md

**Why carry it rather than install it.** The board is load-bearing for every hook, and a hook that depends on a third-party binary's install state and release cadence on four machines is a hook that will one day fail quietly. Carrying the source pins the behaviour, lets the fleet remove what it does not want, and makes the file format the plugin's own contract. MIT permits it; the licence text and the copyright line travel with the code.

**Where.** `claudecode-agents/board/` inside the plugin: `src/` for the carried source, `LICENSE` as upstream ships it, `NOTICE.md` naming the origin repository, the pinned commit, the date, and a list of what was removed, plus `package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml` and a `build.sh`. The package is tested with `bun test` and type-checked with `tsc --noEmit`, both wired into the repo's check suite.

**What is carried.** The markdown layer (frontmatter, parser, serializer, structured sections), the core (task loading and querying, IDs, the content store, search, statistics, task detail, milestones, reorder), the file-system layer with its locks, the config watcher folded into the content store (so the long-running `serve` and `mcp` processes pick up a config edit without a restart), the types, the utilities those need, the formatters, the MCP server with the task, milestone, document and definition-of-done tools, the HTTP server and the React web board, and every upstream test that exercises those modules.

**What is not.** The terminal UI (`src/ui`, `src/board.ts` and the blessed dependency), shell completions, the interactive wizards under `src/commands`, `init` and its project scaffolding, agent-instruction injection, the guideline texts and the MCP workflow tool and resources that serve them (the board skill is the fleet's guidance), the readme helpers, the editor, clipboard and browser-launch helpers, the MCP client setup, cross-branch task resolution, duplicate-ID repair, prefix and config migration, and the entire git layer. `filesystem_only` behaviour becomes the only behaviour: the code paths it guarded are deleted rather than left switchable.

**Root resolution.** `find-backlog-root.ts` and `runtime-cwd.ts` are replaced by one module that reads `CLAUDECODE_AGENTS_BOARD_ROOT`, defaults to `$HOME/.memory`, and expects `board/config.yml` under it. No walk up, no git fallback, no `--cwd`.

**The CLI.** Upstream's `cli.ts` is five and a half thousand lines of commander wiring for every feature. It is replaced by a thin `board` command with the subcommands the fleet uses and nothing else: `task create`, `task edit`, `task view`, `task list`, `task search`, `export`, `mcp` and `serve`. Flags keep upstream's names where they exist so the board skill's reference stays true for anyone who has used the upstream tool. `--json` and `--plain` come from the carried formatters unchanged.

**Build.** `bun build --compile` on `src/cli.ts` produces one binary. The installer builds it into `~/.local/bin/board` on each machine; the artefact is never committed. The shim `board/board.sh` runs that binary when present and falls back to `bun run src/cli.ts` in the plugin directory when Bun is present and the binary is not, so a fresh plugin update before an installer run still works.

**Naming.** The word "Backlog.md" in the web UI's title, navigation and page copy becomes "Board". Nothing else in the UI is restyled in this design.

