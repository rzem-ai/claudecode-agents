# Notice

This package carries source from Backlog.md, https://github.com/MrLesk/Backlog.md,
copyright (c) 2025 Backlog.md, under the MIT licence in `LICENSE`.

Imported once at commit `aded8e254e6a0205b878cf07e631d1a592782040` (the 1.52.0
line, 17 September 2026). It is a fork at a pin, not a subtree: upstream changes
after that commit are ported by hand if wanted.

Upstream's test suite at the pin, on marvin (Bun 1.3.10, macOS), 17 September 2026:
2862 pass, 8 skip, 26 fail, 1 error, across 290 files. Twenty-two of the
failures were in tests of the commander CLI, which is replaced rather than
carried; the rest are recorded, not fixed. Task 1 re-runs the suite and
replaces this line if the numbers differ on the importing machine.

Run in this package (not the full upstream clone), same machine, same day:
2833 pass, 8 skip, 31 fail, 2 errors, across 290 files, 2872 tests. The extra
failures and errors exercise upstream's root-level `scripts/` and `tools/`
directories and its dogfooded `backlog/` project directory, none of which
this package carries; they go away with the modules later tasks remove.

Removed, in the order the plan removed them:

- root discovery by walking up and by git (`src/utils/find-backlog-root.ts`, `src/utils/runtime-cwd.ts`)
- upstream's commander CLI and its command tree (`src/cli.ts`, `src/commands/`)
- the git layer (`src/git/`, `src/core/cross-branch-tasks.ts`, auto-commit and remote operations)
- the terminal UI (`src/ui/`, `src/types/neo-neo-bblessed.d.ts`, `Core.editTaskInTui`, `Core.openEditor`, `src/board.ts`'s terminal format and layout types, `neo-neo-bblessed`, `@clack/core`, `@clack/prompts`)
- shell completions (`src/completions/`)
- project initialisation and instruction injection (`src/core/init.ts`, `src/agent-instructions.ts`, `src/guidelines/`, `src/readme.ts`, the server's `/api/init` endpoint)
- duplicate-ID repair (`src/core/duplicate-task-repair.ts`, `Core.previewDuplicateTaskIdRepair`, `Core.repairDuplicateTaskIds`, the server's `/api/tasks/duplicates` endpoint, `DuplicateIdRepairModal`, `DuplicateIdWarning`)
- the terminal-status cleanup endpoints (`/api/tasks/cleanup`, `/api/tasks/cleanup/execute`)
- the prefix and config migrations (`src/core/prefix-migration.ts`, `src/core/config-migration.ts`, `Core.ensureConfigMigrated` and the legacy-milestone helpers under it)
- the identity diagnostics the removed `doctor` command reached (`Core.diagnoseDraftIdentity`, `Core.diagnoseContentIdentity`)
- the editor, clipboard, browser-launch, browser loading state, MCP client setup, agent selection and config watcher helper modules (`src/utils/{editor,clipboard,browser-launch,browser-loading-state,mcp-client-setup,config-watcher,agent-selection}.ts`); the two whose behaviour the board still reaches were moved into their only caller (the config watcher into `src/core/content-store.ts`, the loading-state parser into `src/web/App.tsx`)
- the MCP workflow tools and resources, the init-required resource, and roots discovery with its fallback mode (`src/mcp/tools/workflow/`, `src/mcp/resources/`, `src/mcp/workflow-guides.ts`, `McpServer.enableRootsDiscovery` and the `pinned` option)
- the repository tooling upstream's package.json carried (`husky`, `lint-staged`, `install`)

## Adjusted at import

- `src/guidelines/project-manager-backlog.md` was a symlink into upstream's `.claude/agents/`; it was a plain copy here until `src/guidelines/` was removed with the instruction machinery.
