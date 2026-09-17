# The board moves to Backlog.md: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Linear as the fleet's board with a copy of the pertinent parts of Backlog.md carried inside the plugin, storing items as markdown files in the memory tree, written by the hooks through the plugin's own `board` binary.

**Architecture:** A `board/` package inside the plugin holds upstream Backlog.md source at one pinned commit, trimmed by deleting what is not carried and letting the type checker and upstream's own tests gate every cut. A thin CLI replaces upstream's, root resolution is one environment variable, the git layer is a throwing stub behind a forced filesystem-only mode. The hook library swaps its Linear half for three calls to that binary behind the existing `board_write` and `board_comment` seam. The web board runs on slarti behind the tunnel.

**Tech Stack:** Bun 1.3.10 (runtime, test runner, bundler, single-binary compile), TypeScript, commander, React (carried web UI), the MCP TypeScript SDK (carried), bash hooks, jq.

**Spec:** `docs/2026-09-17-backlog-board.md`

## Global Constraints

- Upstream is imported once, at commit `aded8e254e6a0205b878cf07e631d1a592782040`, under MIT. `LICENSE` is carried verbatim and `NOTICE.md` names the origin, the commit and what was removed. No task adds `backlog.md` as a dependency anywhere.
- Bun 1.3.10 is the floor. Every command in the package runs with `bun`; nothing uses `node` or `npm`.
- The board root is `CLAUDECODE_AGENTS_BOARD_ROOT`, default `$HOME/.memory`. The board directory under it is `board/`, its config `board/config.yml`. There is no walk-up and no `--cwd`.
- The five statuses are exactly `To Do`, `Doing`, `Blocked`, `Blocked by human`, `Done`. The task prefix is `BD`.
- The git layer is not carried: no auto-commit, no cross-branch resolution, no remote operations. The memory sync agent is the only committer.
- The hooks' public seam is unchanged: `board_write HOOK ITEM COLUMN [COMMENT]` and `board_comment HOOK ITEM TEXT`, both always returning 0.
- Prose in the repo says "the human", never a name. Australian English, hyphens not em dashes.
- `evals/lib/check-all.sh` passes at the end of every task that touches the plugin. Run it once per command and grep the captured output; a doubled run blows the timeout.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Nothing under `~/.claude/projects/`, sessions or the plugin cache is written by any script.

## File structure

```
claudecode-agents/board/                 the carried package (new)
  LICENSE                                upstream's MIT text, verbatim
  NOTICE.md                              origin, commit, date, removals
  package.json  bun.lock  tsconfig.json  bunfig.toml  biome.json
  build.sh                               bun build --compile -> bin/board
  board.sh                               shim: ~/.local/bin/board, else bun run src/cli.ts
  src/cli.ts                             thin CLI (rewritten)
  src/board-root.ts                      root from one env var (new)
  src/git/operations.ts                  throwing stub (rewritten)
  src/core/ src/markdown/ src/file-system/ src/utils/ src/formatters/
  src/types/ src/constants/ src/mcp/ src/server/ src/web/   carried
  src/test/                              upstream tests for carried modules
claudecode-agents/hooks/lib/board.sh     from linear.sh: neutral half kept, Linear half replaced
claudecode-agents/hooks/board-*.sh       source board.sh; no other change
claudecode-agents/.mcp.json              the `board` stdio server (new)
home/board.config.yml                    template the installer writes to ~/.memory/board/config.yml (new)
scripts/install-home.sh                  drops the Linear token, builds the binary, writes config, extends the watcher
evals/lib/board-hook-contract.sh         identifier cases and one live-backend case
```

---

## Phase 1: the package

### Task 1: Import upstream at the pinned commit

**Files:**
- Create: `claudecode-agents/board/{LICENSE,NOTICE.md,package.json,bun.lock,tsconfig.json,bunfig.toml,biome.json}` and `claudecode-agents/board/src/**`
- Modify: `.gitignore`

**Interfaces:**
- Produces: the package directory every later task edits, with `bun test` and `bunx tsc --noEmit` both runnable from it.

- [ ] **Step 1: Clone upstream at the pin and record its baseline**

```bash
SCRATCH=$(mktemp -d)
git clone -q https://github.com/MrLesk/Backlog.md "$SCRATCH/upstream"
git -C "$SCRATCH/upstream" checkout -q aded8e254e6a0205b878cf07e631d1a592782040
( cd "$SCRATCH/upstream" && bun install --frozen-lockfile && bun test --timeout=10000 ) > "$SCRATCH/baseline.log" 2>&1
tail -5 "$SCRATCH/baseline.log"
```

Expected: the last lines report pass and fail counts. Copy those two numbers; they go in `NOTICE.md`. A non-zero fail count at the pin is recorded, not fixed.

- [ ] **Step 2: Copy the carried files**

```bash
REPO=$(git rev-parse --show-toplevel)
mkdir -p "$REPO/claudecode-agents/board"
cd "$SCRATCH/upstream"
cp LICENSE package.json bun.lock tsconfig.json bunfig.toml biome.json "$REPO/claudecode-agents/board/"
cp -R src "$REPO/claudecode-agents/board/src"
```

- [ ] **Step 3: Trim package.json to the package's own identity**

Edit `claudecode-agents/board/package.json`: set `"name": "claudecode-agents-board"`, `"version": "0.1.0"`, `"private": true`; delete the `bin`, `optionalDependencies`, `repository`, `homepage`, `bugs`, `keywords`, `files` and `publishConfig` keys if present; replace `scripts` with:

```json
"scripts": {
  "test": "bun test --timeout=10000",
  "check:types": "bunx tsc --noEmit",
  "check": "biome check .",
  "build": "./build.sh"
}
```

Keep `devDependencies` exactly as upstream has them for now; Task 5 prunes them once the code that needs them is gone. Keep `"type": "module"`.

- [ ] **Step 4: Write NOTICE.md**

```markdown
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

Removed, in the order the plan removed them:

- root discovery by walking up and by git (`src/utils/find-backlog-root.ts`, `src/utils/runtime-cwd.ts`)
- the commander CLI (`src/cli.ts`, `src/commands/`, `src/completions/`)
- the git layer (`src/git/`, `src/core/cross-branch-tasks.ts`, auto-commit and remote operations)
- the terminal UI (`src/ui/`, `src/board.ts` terminal format, `neo-neo-bblessed`)
- project initialisation and instruction injection (`src/core/init.ts`, `src/agent-instructions.ts`, `src/guidelines/`, `src/readme.ts`)
- duplicate-ID repair and the prefix and config migrations
- editor, clipboard, browser-launch and MCP client setup helpers, the config watcher
- the MCP workflow tool and resources and the init-required resource
```

Replace the numbers with Step 1's if they differ.

- [ ] **Step 5: Ignore build output and dependencies**

Append to `.gitignore`:

```
claudecode-agents/board/node_modules/
claudecode-agents/board/bin/
claudecode-agents/board/dist/
```

- [ ] **Step 6: Install and run the suite in place**

```bash
cd "$REPO/claudecode-agents/board" && bun install --frozen-lockfile && bun test --timeout=10000 2>&1 | tail -5
```

Expected: the same pass and fail counts as Step 1.

- [ ] **Step 7: Commit**

```bash
cd "$REPO" && git add .gitignore claudecode-agents/board
git commit -m "board: import Backlog.md at aded8e2 under MIT

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: One root, one directory

**Files:**
- Create: `claudecode-agents/board/src/board-root.ts`, `claudecode-agents/board/src/test/board-root.test.ts`
- Modify: `claudecode-agents/board/src/constants/index.ts` (the `DEFAULT_DIRECTORIES.BACKLOG` value)
- Delete: `claudecode-agents/board/src/utils/find-backlog-root.ts`, `claudecode-agents/board/src/utils/runtime-cwd.ts`, and their tests under `src/test/`

**Interfaces:**
- Produces: `resolveBoardRoot(env?: NodeJS.ProcessEnv): string` and the constants `BOARD_ROOT_ENV = "CLAUDECODE_AGENTS_BOARD_ROOT"`, `BOARD_DIR = "board"`. Task 3's CLI and Task 6's MCP entry call `resolveBoardRoot()`.

- [ ] **Step 1: Write the failing test**

`src/test/board-root.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_ROOT_ENV, resolveBoardRoot } from "../board-root.ts";

describe("resolveBoardRoot", () => {
	it("uses the environment variable when it names a directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "board-root-"));
		try {
			expect(resolveBoardRoot({ [BOARD_ROOT_ENV]: dir })).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults to ~/.memory when the variable is unset or blank", () => {
		const home = mkdtempSync(join(tmpdir(), "board-home-"));
		try {
			const expected = join(home, ".memory");
			require("node:fs").mkdirSync(expected);
			expect(resolveBoardRoot({ HOME: home })).toBe(expected);
			expect(resolveBoardRoot({ HOME: home, [BOARD_ROOT_ENV]: "  " })).toBe(expected);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws a message naming the variable when the root is not a directory", () => {
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "/nonexistent/board-root" })).toThrow(BOARD_ROOT_ENV);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd claudecode-agents/board && bun test src/test/board-root.test.ts`
Expected: FAIL, cannot resolve `../board-root.ts`.

- [ ] **Step 3: Write the module**

`src/board-root.ts`:

```ts
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The one place the board's location comes from. No walk-up, no git fallback, no --cwd. */
export const BOARD_ROOT_ENV = "CLAUDECODE_AGENTS_BOARD_ROOT";
/** The directory under the root that holds tasks, config and the rest. */
export const BOARD_DIR = "board";

export function resolveBoardRoot(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env[BOARD_ROOT_ENV]?.trim();
	const home = env.HOME ?? env.USERPROFILE ?? "";
	const root = resolve(fromEnv && fromEnv.length > 0 ? fromEnv : join(home, ".memory"));
	let isDirectory = false;
	try {
		isDirectory = statSync(root).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) {
		throw new Error(`board root is not a directory: ${root} (set ${BOARD_ROOT_ENV} to the memory tree)`);
	}
	return root;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/test/board-root.test.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Withdrawn during execution; see Task 5 Step 6**

The directory rename cannot happen while upstream's walk-up and the tests that spawn the old CLI are still present: the package itself lives at `claudecode-agents/board/`, so a constant of `"board"` makes the walk-up resolve the plugin as a project, and a subprocess test then writes into the real repository. The rename is done in Task 5 once those are deleted. The text that follows describes that later step.

In `src/constants/index.ts` change `BACKLOG: "backlog"` to `BACKLOG: "board"`. Leave `HIDDEN_BACKLOG` and `ROOT_CONFIG` alone; nothing in the fleet creates either, and deleting them would touch the resolver for no gain.

Then find every test that spells the directory by hand:

```bash
grep -rln '"backlog"' src/test | wc -l
grep -rln "join([^)]*\"backlog\"" src/test | head
```

For each hit that builds a path to the backlog directory, replace the literal with `DEFAULT_DIRECTORIES.BACKLOG` (import it from `../constants/index.ts`). Do not touch hits that are prose in an assertion message about the upstream product.

- [ ] **Step 6: Withdrawn during execution; see Task 3 Step 4**

Upstream's `cli.ts` imports both resolvers and about seventy upstream tests spawn that CLI as a subprocess, so deleting the resolvers before the CLI is replaced fails every one of them. The deletion and the importer repair happen in Task 3 Step 4 alongside the CLI rewrite. The text that follows describes that later step.

```bash
git rm -q src/utils/find-backlog-root.ts src/utils/runtime-cwd.ts
git rm -q src/test/find-backlog-root.test.ts src/test/runtime-cwd.test.ts 2>/dev/null || true
grep -rln "find-backlog-root\|runtime-cwd" src
```

Every importer listed is either `src/cli.ts` (rewritten in Task 3, leave it), `src/commands/mcp.ts` (deleted in Task 5, leave it), or `src/core/backlog.ts` and `src/mcp/server.ts`. In the last two, replace the import with `import { resolveBoardRoot } from "../board-root.ts";` and replace each call to `resolveRuntimeCwd(...)` or `getProjectRoot(...)` with `resolveBoardRoot()`. Where the old code returned `null` for "no project", the new code throws; delete the `null` branch.

- [ ] **Step 7: Gate**

Run: `bunx tsc --noEmit 2>&1 | grep -v "src/cli.ts\|src/commands/" | head` and `bun test --timeout=10000 2>&1 | tail -3`
Expected: no type errors outside the two files the next tasks replace; test counts at or above baseline minus the two deleted files.

- [ ] **Step 8: Commit**

```bash
git add -A src && git commit -m "board: root comes from CLAUDECODE_AGENTS_BOARD_ROOT, directory is board/

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: The thin CLI

**Files:**
- Rewrite: `claudecode-agents/board/src/cli.ts`
- Create: `claudecode-agents/board/src/test/cli-board.test.ts`
- Delete: `claudecode-agents/board/src/commands/` and its tests, `src/index.ts`

**Interfaces:**
- Consumes: `resolveBoardRoot()` (Task 2); upstream's `Core` (`createTaskFromInput`, `updateTaskFromInput`, `getTask`, `queryTasks`, `getSearchService`, `filesystem.loadConfig`), `buildTaskUpdateInput(args: TaskEditArgs)`, `loadTaskDetail`, `loadTaskListItems`, `taskViewJson`, `taskListJson`, `searchJson`, `formatTaskPlainText`, `generateKanbanBoardWithMetadata`, `BacklogServer`, `createMcpServer`.
- Produces: the `board` command surface every later task and the hooks call: `board task create|edit|view|list|search`, `board export`, `board mcp`, `board serve`.

- [ ] **Step 1: Write the failing test**

`src/test/cli-board.test.ts` drives the CLI as a subprocess against a temporary root, the way a hook will:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");
let root = "";

function board(...args: string[]) {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		env: { ...process.env, CLAUDECODE_AGENTS_BOARD_ROOT: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "board-cli-"));
	mkdirSync(join(root, "board"));
	writeFileSync(
		join(root, "board", "config.yml"),
		[
			'project_name: "test"',
			'task_prefix: "BD"',
			'statuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]',
			'default_status: "To Do"',
			'projects: ["fleet"]',
			"",
		].join("\n"),
	);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("board task", () => {
	it("creates a task with the BD prefix and returns JSON", () => {
		const r = board("task", "create", "Rotate refresh tokens", "--project", "fleet", "--ac", "Old token is refused", "--json");
		expect(r.code).toBe(0);
		const json = JSON.parse(r.out);
		expect(json.task.id).toBe("BD-1");
		expect(json.task.status).toBe("To Do");
		expect(json.task.acceptanceCriteria[0].text).toBe("Old token is refused");
	});

	it("moves status and appends an authored comment", () => {
		const r = board("task", "edit", "BD-1", "-s", "Blocked by human", "--comment", "Blocker: which key?", "--comment-author", "@subagent-stop", "--json");
		expect(r.code).toBe(0);
		const view = JSON.parse(board("task", "view", "BD-1", "--json").out);
		expect(view.task.status).toBe("Blocked by human");
		expect(view.task.comments[0].author).toBe("@subagent-stop");
		expect(view.task.comments[0].content).toContain("Blocker: which key?");
	});

	it("rejects a status that is not configured", () => {
		const r = board("task", "edit", "BD-1", "-s", "In Progress");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("Blocked by human");
	});

	it("lists by status as JSON and resolves lower-case ids", () => {
		const list = JSON.parse(board("task", "list", "--status", "blocked by human", "--json").out);
		expect(list.tasks.map((t: { id: string }) => t.id)).toEqual(["BD-1"]);
		expect(JSON.parse(board("task", "view", "bd-1", "--json").out).task.id).toBe("BD-1");
	});

	it("exports a markdown board with the five columns", () => {
		const r = board("export");
		expect(r.code).toBe(0);
		expect(r.out).toContain("| To Do | Doing | Blocked | Blocked by human | Done |");
		expect(r.out).toContain("BD-1");
	});

	it("fails with the variable's name when the root is wrong", () => {
		const proc = Bun.spawnSync(["bun", CLI, "task", "list"], {
			env: { ...process.env, CLAUDECODE_AGENTS_BOARD_ROOT: "/nonexistent" },
			stderr: "pipe",
		});
		expect(proc.exitCode).not.toBe(0);
		expect(proc.stderr.toString()).toContain("CLAUDECODE_AGENTS_BOARD_ROOT");
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/test/cli-board.test.ts`
Expected: FAIL. Upstream's `cli.ts` walks up from the working directory, ignores the variable, and has no `export` at the root.

- [ ] **Step 3: Replace cli.ts**

`src/cli.ts`, complete:

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import { resolveBoardRoot } from "./board-root.ts";
import { generateKanbanBoardWithMetadata } from "./board.ts";
import { Core } from "./core/backlog.ts";
import { loadTaskDetail, loadTaskListItems } from "./core/task-detail.ts";
import { printJson, searchJson, taskListJson, taskViewJson } from "./formatters/json-output.ts";
import { formatTaskPlainText } from "./formatters/task-plain-text.ts";
import { createMcpServer } from "./mcp/server.ts";
import { BacklogServer } from "./server/index.ts";
import type { TaskEditArgs } from "./types/task-edit-args.ts";
import type { SearchResultType, TaskCreateInput } from "./types/index.ts";
import { buildTaskUpdateInput } from "./utils/task-edit-builder.ts";
import { getCanonicalStatuses } from "./utils/status.ts";

declare const __EMBEDDED_VERSION__: string | undefined;
const VERSION = typeof __EMBEDDED_VERSION__ === "string" ? __EMBEDDED_VERSION__ : "dev";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function list(value: string, previous: string[] = []): string[] {
	return previous.concat(value.split(",").map((v) => v.trim()).filter(Boolean));
}

function repeat(value: string, previous: string[] = []): string[] {
	return previous.concat([value]);
}

function core(): Core {
	try {
		return new Core(resolveBoardRoot());
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

async function statusOrFail(c: Core, wanted: string): Promise<string> {
	const config = await c.filesystem.loadConfig();
	const statuses = getCanonicalStatuses(config);
	const hit = statuses.find((s) => s.toLowerCase() === wanted.trim().toLowerCase());
	if (!hit) fail(`invalid status "${wanted}". Configured statuses: ${statuses.join(", ")}`);
	return hit;
}

async function emitTask(c: Core, id: string, json: boolean) {
	const task = await c.getTask(id);
	if (!task) fail(`no task ${id}`);
	const detail = await loadTaskDetail(c, task);
	if (json) printJson(taskViewJson(detail, c.filesystem.rootDir));
	else console.log(formatTaskPlainText(detail));
}

const program = new Command().name("board").description("The fleet's board").version(VERSION);
const task = program.command("task").description("tasks on the board");

task
	.command("create <title>")
	.option("-d, --description <text>")
	.option("-s, --status <status>")
	.option("-a, --assignee <names>", "comma-separated or repeated", list)
	.option("-l, --labels <labels>", "comma-separated or repeated", list)
	.option("--priority <priority>")
	.option("--project <project>")
	.option("--milestone <milestone>")
	.option("-p, --parent <taskId>")
	.option("--dep <taskId>", "repeatable", repeat)
	.option("--ac <text>", "acceptance criterion, repeatable", repeat)
	.option("--plan <text>")
	.option("--notes <text>")
	.option("--json")
	.option("--plain")
	.action(async (title: string, o) => {
		const c = core();
		const input: TaskCreateInput = {
			title,
			description: o.description,
			status: o.status ? await statusOrFail(c, o.status) : undefined,
			assignee: o.assignee,
			labels: o.labels,
			priority: o.priority,
			project: o.project,
			milestone: o.milestone,
			parentTaskId: o.parent,
			dependencies: o.dep,
			acceptanceCriteria: o.ac?.map((text: string) => ({ text, checked: false })),
			implementationPlan: o.plan,
			implementationNotes: o.notes,
		};
		const { task: created } = await c.createTaskFromInput(input);
		if (o.json || o.plain) await emitTask(c, created.id, Boolean(o.json));
		else console.log(`Created ${created.id}`);
	});

task
	.command("edit <taskId>")
	.option("-t, --title <text>")
	.option("-d, --description <text>")
	.option("-s, --status <status>")
	.option("-a, --assignee <names>", "comma-separated or repeated", list)
	.option("-l, --labels <labels>", "replace labels", list)
	.option("--add-label <label>", "repeatable", repeat)
	.option("--remove-label <label>", "repeatable", repeat)
	.option("--priority <priority>")
	.option("--project <project>")
	.option("--milestone <milestone>")
	.option("--dep <taskId>", "repeatable", repeat)
	.option("--ref <text>", "add a reference, repeatable", repeat)
	.option("--ac <text>", "add acceptance criterion, repeatable", repeat)
	.option("--check-ac <n>", "repeatable", repeat)
	.option("--uncheck-ac <n>", "repeatable", repeat)
	.option("--remove-ac <n>", "repeatable", repeat)
	.option("--plan <text>", "replace the plan")
	.option("--append-plan <text>", "repeatable", repeat)
	.option("--notes <text>", "replace the notes")
	.option("--append-notes <text>", "repeatable", repeat)
	.option("--comment <text>", "repeatable", repeat)
	.option("--comment-author <name>")
	.option("--final-summary <text>")
	.option("--json")
	.option("--plain")
	.action(async (taskId: string, o) => {
		const c = core();
		const current = await c.getTask(taskId);
		if (!current) fail(`no task ${taskId}`);
		if (o.comment?.length && !o.commentAuthor) fail("--comment needs --comment-author");
		const args: TaskEditArgs = {
			title: o.title,
			description: o.description,
			status: o.status ? await statusOrFail(c, o.status) : undefined,
			assignee: o.assignee,
			labels: o.labels,
			addLabels: o.addLabel,
			removeLabels: o.removeLabel,
			priority: o.priority,
			project: o.project,
			milestone: o.milestone,
			dependencies: o.dep,
			addReferences: o.ref,
			acceptanceCriteriaAdd: o.ac,
			acceptanceCriteriaCheck: o.checkAc?.map(Number),
			acceptanceCriteriaUncheck: o.uncheckAc?.map(Number),
			acceptanceCriteriaRemove: o.removeAc?.map(Number),
			planSet: o.plan,
			planAppend: o.appendPlan,
			notesSet: o.notes,
			notesAppend: o.appendNotes,
			commentsAppend: o.comment,
			commentAuthor: o.commentAuthor,
			finalSummary: o.finalSummary,
		};
		await c.updateTaskFromInput(current.id, buildTaskUpdateInput(args));
		if (o.json || o.plain) await emitTask(c, current.id, Boolean(o.json));
		else console.log(`Updated ${current.id}`);
	});

task
	.command("view <taskId>")
	.option("--json")
	.option("--plain")
	.action(async (taskId: string, o) => {
		await emitTask(core(), taskId, Boolean(o.json));
	});

task
	.command("list")
	.option("--status <status>", "repeatable", repeat)
	.option("--project <project>")
	.option("--assignee <name>")
	.option("--labels <labels>", list)
	.option("--search <text>")
	.option("--limit <n>")
	.option("--json")
	.option("--plain")
	.action(async (o) => {
		const c = core();
		const statuses = o.status ? await Promise.all(o.status.map((s: string) => statusOrFail(c, s))) : undefined;
		const tasks = await c.queryTasks({
			query: o.search,
			limit: o.limit ? Number(o.limit) : undefined,
			filters: { status: statuses, project: o.project, assignee: o.assignee, labels: o.labels },
		});
		const items = await loadTaskListItems(c, tasks);
		if (o.json) printJson(taskListJson(items));
		else for (const t of items) console.log(`${t.id}  ${t.status}  ${t.title}`);
	});

task
	.command("search <query>")
	.option("--type <type>", "task, document or decision; repeatable", repeat)
	.option("--limit <n>")
	.option("--json")
	.action(async (query: string, o) => {
		const c = core();
		const service = await c.getSearchService();
		const results = service.search({
			query,
			limit: o.limit ? Number(o.limit) : undefined,
			types: o.type as SearchResultType[] | undefined,
		});
		if (o.json) printJson(searchJson(results, query));
		else for (const r of results) console.log(r.type === "task" ? `${r.task.id}  ${r.task.title}` : `${r.type}`);
	});

program
	.command("export")
	.description("the board as a markdown table on stdout")
	.action(async () => {
		const c = core();
		const config = await c.filesystem.loadConfig();
		const tasks = await c.queryTasks();
		console.log(generateKanbanBoardWithMetadata(tasks, getCanonicalStatuses(config), config?.projectName ?? "board"));
	});

program
	.command("mcp")
	.description("MCP server on stdio")
	.action(async () => {
		const server = await createMcpServer(resolveBoardRoot());
		await server.connect();
		await server.start();
	});

program
	.command("serve")
	.description("the web board on 127.0.0.1")
	.option("--port <n>", "default 6420")
	.action(async (o) => {
		const server = new BacklogServer(resolveBoardRoot());
		await server.start(o.port ? Number(o.port) : undefined, false);
	});

program.parseAsync(process.argv).catch((error) => fail(error instanceof Error ? error.message : String(error)));
```

Two names in that file may not match upstream at the pin: `getCanonicalStatuses(config)` in `src/utils/status.ts`, and the shape of `filters` in `TaskListFilter` (`src/core/backlog.ts` around line 175, and `src/types/index.ts`). Open both before running, and use the exported names as they are spelled there. `searchJson`'s second argument is whatever `src/formatters/json-output.ts:259` declares. The status filter in `TaskListFilter` may be a single string rather than an array; if so, run one query per status and concatenate.

- [ ] **Step 4: Delete what only the old CLI used**

```bash
git rm -rq src/commands src/index.ts
git rm -q src/test/task-wizard.test.ts src/test/watch-json.test.ts 2>/dev/null || true
# The upstream tests that drive the old CLI as a subprocess test flags and
# commands that no longer exist. cli-board.test.ts is their replacement.
cd src/test && git rm -q $(ls cli-*.test.ts config-commands.test.ts implementation-notes.test.ts draft-create-consistency.test.ts 2>/dev/null) && cd ../..
grep -rln "commands/\|from \"\./index.ts\"\|from \"\.\./index.ts\"" src | grep -v "^src/test/"
```

Any non-test file still importing from `src/commands/` is a bug in this step; fix the import or delete the file if it is on the Task 5 list.

Then delete the old resolvers, which only the old CLI and the tests deleted above still used, and repair the two carried importers:

```bash
git rm -q src/utils/find-backlog-root.ts src/utils/runtime-cwd.ts
git rm -q src/test/find-backlog-root.test.ts src/test/runtime-cwd.test.ts 2>/dev/null || true
grep -rln "find-backlog-root\|runtime-cwd\|BACKLOG_CWD_ENV" src
```

In `src/core/backlog.ts` and `src/mcp/server.ts`, replace the import with `import { resolveBoardRoot } from "../board-root.ts";` and each call to `resolveRuntimeCwd(...)` or `getProjectRoot(...)` with `resolveBoardRoot()`; where the old code returned `null` for "no project", the new code throws, so delete the `null` branch. Any remaining test file that imports `BACKLOG_CWD_ENV` is a test of the old CLI and is deleted. Of the 26 failures in the baseline, 22 were in the `cli-*` and `config-commands` files deleted here; the remaining four (`content-store`, `draft-create-consistency`, `implementation-notes`, one `cli-*`) are noted in `NOTICE.md` as failing at the pin.

- [ ] **Step 5: Run the new test and the type check**

Run: `bun test src/test/cli-board.test.ts && bunx tsc --noEmit 2>&1 | grep "src/cli.ts" | head`
Expected: six tests pass, no type errors in `cli.ts`. Errors elsewhere from deleted commands are fixed in this task if the file is carried, or ignored if the file is on the Task 5 deletion list.

- [ ] **Step 6: Commit**

```bash
git add -A src && git commit -m "board: thin CLI over the carried core

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Cut the git layer

**Files:**
- Rewrite: `claudecode-agents/board/src/git/operations.ts` as a throwing stub
- Modify: `claudecode-agents/board/src/file-system/operations.ts` (force `filesystemOnly`), `src/core/backlog.ts` (drop `shouldAutoCommit` overrides)
- Delete: `src/core/cross-branch-tasks.ts`, `src/test/git.test.ts`, `src/test/core-autocommit-scope.test.ts`, `src/test/task-autocommit-index-scope.test.ts`, `src/test/shared-branch-task-loader.test.ts`, `src/test/cross-branch-*.test.ts`

**Interfaces:**
- Consumes: the `GitOperations` method names Core calls: `commitFiles`, `stageFileMove`, `addFile`, `addFiles`, `setConfig`, `resetPaths`, `getIndexEntries`, `commitTaskChange`, `addAndCommitTaskFile`, `restoreIndexEntriesIfMatches`, `listWorktreePaths`, `getRepositoryRoot`.
- Produces: a `Core` for which `shouldAutoCommit()` is always false and every git method is unreachable.

- [ ] **Step 1: Write the failing test**

`src/test/no-git.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";

describe("the git layer is not carried", () => {
	it("never auto-commits, whatever the config or the override says", async () => {
		const root = mkdtempSync(join(tmpdir(), "board-nogit-"));
		try {
			mkdirSync(join(root, "board"));
			writeFileSync(join(root, "board", "config.yml"), 'project_name: "t"\nauto_commit: true\nstatuses: ["To Do", "Done"]\n');
			const core = new Core(root);
			expect(await core.shouldAutoCommit()).toBe(false);
			expect(await core.shouldAutoCommit(true)).toBe(false);
			const { task } = await core.createTaskFromInput({ title: "x" });
			expect(task.id).toBe("TASK-1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/test/no-git.test.ts`
Expected: FAIL on `shouldAutoCommit(true)` returning true.

- [ ] **Step 3: Force filesystem-only in the loaded config**

In `src/file-system/operations.ts`, find the function that returns the parsed config to callers (`loadConfig`). Immediately before it returns a non-null config, set:

```ts
config.filesystemOnly = true;
config.autoCommit = false;
config.checkActiveBranches = false;
config.remoteOperations = false;
```

In `src/core/backlog.ts`, `shouldAutoCommit` becomes:

```ts
async shouldAutoCommit(_overrideValue?: boolean): Promise<boolean> {
	return false;
}
```

- [ ] **Step 4: Replace the git module with a stub**

`src/git/operations.ts`, complete:

```ts
// The git layer is not carried. Backlog.md's auto-commit, cross-branch resolution
// and remote fetches are all behind config.filesystemOnly, which
// file-system/operations.ts forces to true, so nothing below can be reached.
// The class exists so Core's type surface is unchanged; every method that would
// touch git throws, so a regression is loud rather than silent.
import type { BacklogConfig } from "../types/index.ts";

export type GitBranchTip = { name: string; sha: string };
export type GitIndexEntry = { path: string; mode: string; sha: string; stage: number };

const NOT_CARRIED = "git layer not carried: this path must be unreachable under filesystemOnly";

export class GitOperations {
	constructor(
		public readonly projectRoot: string,
		_config: BacklogConfig | null = null,
		_loadConfig?: () => Promise<BacklogConfig | null>,
	) {}
	setConfig(_config: BacklogConfig | null): void {}
	async getRepositoryRoot(): Promise<string | null> { return null; }
	async listWorktreePaths(): Promise<string[]> { return []; }
	async getIndexEntries(_paths?: string[]): Promise<GitIndexEntry[]> { return []; }
	async restoreIndexEntriesIfMatches(): Promise<void> {}
	async addFile(): Promise<void> { throw new Error(NOT_CARRIED); }
	async addFiles(): Promise<void> { throw new Error(NOT_CARRIED); }
	async stageFileMove(): Promise<void> { throw new Error(NOT_CARRIED); }
	async resetPaths(): Promise<void> { throw new Error(NOT_CARRIED); }
	async commitFiles(): Promise<void> { throw new Error(NOT_CARRIED); }
	async commitTaskChange(): Promise<void> { throw new Error(NOT_CARRIED); }
	async addAndCommitTaskFile(): Promise<void> { throw new Error(NOT_CARRIED); }
}

export async function isGitRepository(_path: string): Promise<boolean> { return false; }
export async function initializeGitRepository(_path: string): Promise<void> { throw new Error(NOT_CARRIED); }
```

Open upstream's `src/git/operations.ts` (in git history, `git show HEAD~3:claudecode-agents/board/src/git/operations.ts`) and match each stub's parameter list and return type to the original signature so `tsc` accepts the call sites in Core; the bodies stay as above.

- [ ] **Step 5: Delete cross-branch code and the tests of removed behaviour**

```bash
git rm -q src/core/cross-branch-tasks.ts
git rm -q src/test/git.test.ts src/test/core-autocommit-scope.test.ts src/test/task-autocommit-index-scope.test.ts src/test/shared-branch-task-loader.test.ts
git rm -q $(ls src/test/*cross-branch* src/test/*remote* src/test/*branch-tip* 2>/dev/null) 2>/dev/null || true
grep -rln "cross-branch-tasks\|BranchTaskLoader" src | grep -v "^src/test/"
```

In `src/core/backlog.ts`, the `BranchTaskLoader` and every method whose name contains `Branch` or `CrossBranch` (`loadActiveBranchSnapshot`, `refreshCrossBranch`, the `includeCrossBranch` option handling) are deleted; where a caller passed `includeCrossBranch`, the parameter is dropped. Let `bunx tsc --noEmit` list each dangling reference and remove it. `TaskIdentityIndex` stays, called with `repositoryRoot: null` and an empty branch record list.

- [ ] **Step 6: Gate**

Run: `bun test src/test/no-git.test.ts && bunx tsc --noEmit 2>&1 | head -20 && bun test --timeout=10000 2>&1 | tail -3`
Expected: the new test passes; no type errors outside files on the Task 5 deletion list; the upstream tests that remain pass.

- [ ] **Step 7: Commit**

```bash
git add -A src && git commit -m "board: filesystem-only is the only mode; git layer is a throwing stub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Remove everything nothing reaches

**Files:**
- Delete: `src/ui/`, `src/board.ts` terminal branches, `src/completions/`, `src/agent-instructions.ts`, `src/readme.ts`, `src/guidelines/`, `src/core/init.ts`, `src/core/duplicate-task-repair.ts`, `src/core/prefix-migration.ts`, `src/core/config-migration.ts`, `src/utils/{editor,clipboard,browser-launch,browser-loading-state,mcp-client-setup,config-watcher,agent-selection}.ts`, `src/types/neo-neo-bblessed.d.ts`, `src/mcp/tools/workflow/`, `src/mcp/resources/`, `src/mcp/workflow-guides.ts`, and the tests of each
- Modify: `package.json` devDependencies, `src/mcp/server.ts`, `src/core/backlog.ts`, `src/server/index.ts`

**Interfaces:**
- Produces: a package where `bunx tsc --noEmit` is clean and `bun build --target=bun src/cli.ts` bundles without the deleted modules.

- [ ] **Step 1: Delete the listed trees**

```bash
git rm -rq src/ui src/completions src/guidelines src/mcp/tools/workflow src/mcp/resources
git rm -q src/agent-instructions.ts src/readme.ts src/mcp/workflow-guides.ts \
  src/core/init.ts src/core/duplicate-task-repair.ts src/core/prefix-migration.ts src/core/config-migration.ts \
  src/utils/editor.ts src/utils/clipboard.ts src/utils/browser-launch.ts src/utils/browser-loading-state.ts \
  src/utils/mcp-client-setup.ts src/utils/config-watcher.ts src/utils/agent-selection.ts \
  src/types/neo-neo-bblessed.d.ts
```

- [ ] **Step 2: Delete the tests of deleted behaviour**

```bash
cd src/test
git rm -q $(ls *init* *tui* *completion* *agent-instructions* *readme* *guideline* *duplicate-id* *duplicate-task* *duplicate-repair* *prefix-migration* *config-migration* *editor* *clipboard* *browser-open* *mcp-client-setup* *config-watcher* *agent-selection* *workflow* *mcp-roots* *mcp-fallback* *mcp-workspace-root* *loading-progress* 2>/dev/null)
cd ../..
```

A glob that matches nothing prints an error from `ls` and is harmless.

- [ ] **Step 3: Repair the survivors with the type checker**

Run: `bunx tsc --noEmit 2>&1 | sort | uniq | head -60`

Work through the list file by file. The expected shapes:

- `src/core/backlog.ts`: delete `editTaskInTui`, `openEditor`, `previewDuplicateTaskIdRepair`, `repairDuplicateTaskIds`, `diagnoseDraftIdentity`, `diagnoseContentIdentity`, `ensureConfigMigrated` and the migration helpers under it; delete imports of the removed modules. Where `ensureConfigMigrated` was awaited, delete the await.
- `src/mcp/server.ts`: delete `registerInitRequiredResource`, `registerWorkflowResources`, `registerWorkflowTools`, `enableRootsDiscovery` and every field and method whose comment mentions roots discovery or fallback mode; `createMcpServer` becomes: load config, throw `new Error("no board/config.yml under the board root")` when it is null, register task, milestone, definition-of-done and document tools, return. The `pinned` option is deleted because the root is always pinned.
- `src/server/index.ts`: delete the `launchBrowser` import and the `openBrowser` parameter's effect (keep the parameter so `start(port, false)` still type-checks), delete the initialisation endpoint and the duplicate-repair and cleanup endpoints, and every import from a deleted module.
- `src/board.ts`: keep `generateKanbanBoardWithMetadata` and `buildKanbanStatusGroups`; delete the terminal format branch and `exportKanbanBoardToFile` if it imports anything deleted.

Stop when `bunx tsc --noEmit` prints nothing.

- [ ] **Step 4: Prune devDependencies**

Remove from `package.json`: `@clack/core`, `@clack/prompts`, `neo-neo-bblessed`, `husky`, `lint-staged`, `install`. Then:

```bash
bun install && bun test --timeout=10000 2>&1 | tail -3 && bun build --target=bun src/cli.ts --outdir /tmp/board-bundle-check >/dev/null && echo bundled
```

Expected: tests pass; `bundled`.

- [ ] **Step 5: Update NOTICE.md's removal list** so it matches what this task actually deleted.

- [ ] **Step 6: Make `board` the directory the resolver looks for**

Now that `src/cli.ts` is the thin CLI (no walk-up) and the tests that spawned the old CLI are gone, change `BACKLOG: "backlog"` to `BACKLOG: "board"` in `src/constants/index.ts`. Then rewrite the tests that build a path to the backlog directory by hand:

```bash
grep -rln '"backlog"' src/test | wc -l
```

For each hit that builds a path to the backlog directory, replace the literal with `DEFAULT_DIRECTORIES.BACKLOG` (import it from `../constants/index.ts`). Leave prose in assertion messages alone. The Task 2 implementer saw a `logicalTaskPath` substring collision when trying this early; read the note in `.superpowers/sdd/backlog-board/task-2-report.md` before starting. Run `bun test --timeout=10000 2>&1 | tail -3` once; failing test names must match the run before this step. Then commit this task.

```bash
git add -A && git commit -m "board: remove the TUI, init, migrations and guideline machinery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: The web board, and the word "Board"

**Files:**
- Modify: `src/web/index.html`, `src/web/components/Navigation.tsx`, `src/web/components/SideNavigation.tsx`, `src/web/components/Layout.tsx`, `src/web/App.tsx`
- Delete: `src/web/components/{InitializationScreen,BranchIndexingIndicator,DuplicateIdRepairModal,DuplicateIdWarning,CleanupModal}.tsx` and the routes to them

**Interfaces:**
- Produces: `board serve --port N` serving the kanban at `http://127.0.0.1:N/` with the JSON API under `/api/`.

- [ ] **Step 1: Write the failing test**

`src/test/serve-board.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogServer } from "../server/index.ts";

let root = "";
let server: BacklogServer;
const port = 6480 + Math.floor(Math.random() * 100);

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "board-serve-"));
	mkdirSync(join(root, "board", "tasks"), { recursive: true });
	writeFileSync(join(root, "board", "config.yml"), 'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\n');
	server = new BacklogServer(root);
	await server.start(port, false);
});

afterAll(async () => {
	await server.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("board serve", () => {
	it("serves the page with the fleet's name and no upstream branding", async () => {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		expect(html).toContain("<title>Board</title>");
		expect(html).not.toContain("Backlog.md");
	});

	it("serves the tasks API", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("serves the configured statuses", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/statuses`);
		expect(await res.json()).toEqual(["To Do", "Doing", "Blocked", "Blocked by human", "Done"]);
	});
});
```

If upstream's statuses endpoint has a different path, read it from `src/server/index.ts` and use that path; the assertion on the value stays.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/test/serve-board.test.ts`
Expected: FAIL on the title assertion.

- [ ] **Step 3: Rename and remove**

In `src/web/index.html` set `<title>Board</title>`. Then:

```bash
grep -rn "Backlog.md\|Backlog\.md\|backlog.md" src/web --include='*.tsx' --include='*.ts' --include='*.html' | grep -v "\.test\."
```

Replace each user-visible string with `Board`; leave the `localStorage` key `backlog-theme` alone so a viewer's theme survives. Delete the five components listed above and the imports, routes and state that referenced them in `App.tsx`, `Layout.tsx` and `Navigation.tsx`; delete their tests.

- [ ] **Step 4: Gate**

Run: `bunx tsc --noEmit && bun test src/test/serve-board.test.ts && bun test --timeout=10000 2>&1 | tail -3`
Expected: clean, three tests pass, suite passes.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "board: the web UI says Board and loses the init, repair and cleanup screens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6b: Restore coverage of carried behaviour the old CLI's tests carried

Added during execution. Task 3 deleted every upstream test that drove the old CLI as a subprocess, and about twenty of those were the only tests of behaviour this package still carries and the hooks depend on.

**Files:**
- Create: `claudecode-agents/board/src/test/cli-board-behaviour.test.ts`

**Interfaces:**
- Consumes: the thin CLI from Task 3, driven as a subprocess against a temporary root exactly as `src/test/cli-board.test.ts` does (copy its `board()` helper and its `beforeAll` fixture).

- [ ] **Step 1: Write the tests, one `describe` per behaviour, each asserting through `task view --json` after the edit**

Cover, with one or two cases each: a comment appended with author and text lands in `comments` with `author` and `body` and a date; `--ac` on create then `--check-ac 1` flips `acceptanceCriteria[0].checked` and `acceptanceCriteriaCompleted`; `--append-notes` twice yields both lines in order in `implementationNotes`; `--plan` then `--append-plan` replaces then appends; `--dep BD-1` on a second task makes `readiness.isBlocked` true while BD-1 is not Done and false after `task edit BD-1 -s Done`; `--final-summary` lands in `finalSummary`; a second `task create` with `-p BD-1` gets id `BD-1.1` and `parentTaskId` `BD-1`; a title containing `<!-- SECTION:DESCRIPTION:BEGIN -->` is refused (section-marker safety); `task list --status "Blocked by human" --json` returns only that status; `task search "<word from a title>" --json` returns that task with `kind` `search`.

- [ ] **Step 2: Run them**

Run: `bun test src/test/cli-board-behaviour.test.ts`
Expected: all pass. A case that fails because the carried core behaves differently from what upstream's deleted test asserted is a finding for the report, not something to paper over: leave the failing case in with `it.todo` and the reason.

- [ ] **Step 3: Commit**

```bash
git add src/test/cli-board-behaviour.test.ts && git commit -m "board: behaviour tests through the thin CLI for what the old CLI tests covered

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Build, shim, and the check suite

**Files:**
- Create: `claudecode-agents/board/build.sh`, `claudecode-agents/board/board.sh`
- Modify: `evals/lib/check-all.sh`

**Interfaces:**
- Produces: `board/bin/board` (a compiled binary, ignored by git); `board.sh <args>` runnable from any directory, used by Task 10's hook library and Task 12's `.mcp.json`.

- [ ] **Step 1: build.sh**

```bash
#!/usr/bin/env bash
# Build the board binary. Output: bin/board next to this script, or $1.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-bin/board}"
mkdir -p "$(dirname "$out")"
version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json)"
bun install --frozen-lockfile >/dev/null
bun build src/cli.ts --compile --target=bun --minify \
  --define "__EMBEDDED_VERSION__=\"$version\"" \
  --define "process.env.NODE_ENV=\"production\"" \
  --outfile "$out"
chmod 0755 "$out"
printf 'built %s (%s)\n' "$out" "$version"
```

Upstream's build uses `bun-plugin-tailwind` through `Bun.build` in a script; if `bun build` on the command line does not pick the plugin up from `bunfig.toml`, replace the `bun build` line with `bun scripts/build.ts` after copying upstream's `scripts/build.ts` into `board/scripts/` and pointing its `outfile` at `$out`.

- [ ] **Step 2: board.sh**

```bash
#!/usr/bin/env bash
# The one way the hooks and the MCP config reach the board binary.
#   1. ~/.local/bin/board, built by scripts/install-home.sh
#   2. bin/board beside this script, built by build.sh
#   3. bun run src/cli.ts, when Bun is present and nothing is built yet
# Exit 127 with a one-line reason otherwise; the hook library treats that as a soft failure.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$HOME/.local/bin/board" ]; then exec "$HOME/.local/bin/board" "$@"; fi
if [ -x "$here/bin/board" ]; then exec "$here/bin/board" "$@"; fi
if command -v bun >/dev/null 2>&1; then exec bun "$here/src/cli.ts" "$@"; fi
printf 'board: no binary at ~/.local/bin/board or %s/bin/board and no bun on PATH\n' "$here" >&2
exit 127
```

`chmod 0755 build.sh board.sh`.

- [ ] **Step 3: Prove the binary works from a foreign directory**

```bash
claudecode-agents/board/build.sh
T=$(mktemp -d); mkdir -p "$T/board"; printf 'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\n' > "$T/board/config.yml"
( cd /tmp && CLAUDECODE_AGENTS_BOARD_ROOT="$T" "$OLDPWD/claudecode-agents/board/board.sh" task create "Smoke" --json | jq -r .task.id )
rm -rf "$T"
```

Expected: `BD-1`.

- [ ] **Step 4: Wire the package into the check suite**

In `evals/lib/check-all.sh`, add a step in the same style as the existing ones that runs, from `claudecode-agents/board`, `bunx tsc --noEmit`, a `bun build --target=bun src/cli.ts` bundle into a temp dir, and `bun test` on the five fleet-owned test files (`board-root`, `cli-board`, `cli-board-behaviour`, `no-git`, `serve-board`), and skips with a named reason when `bun` is not on `PATH`. The full upstream suite takes five minutes and `check-all.sh` must finish inside the two-minute shell timeout, so the step runs the full suite only when `CHECK_ALL_BOARD_FULL=1` is set (ruled during execution). Run `evals/lib/check-all.sh 2>&1 | tee /tmp/check.log | tail -20`.

Expected: the board step is listed and passes; everything that passed before still passes.

- [ ] **Step 5: Commit**

```bash
git add claudecode-agents/board/build.sh claudecode-agents/board/board.sh evals/lib/check-all.sh
git commit -m "board: build script, resolver shim, and the check suite runs the package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 2: the repo and the hooks

### Task 8: The board scope in the memory tree and the installer

**Files:**
- Create: `home/board.config.yml`
- Modify: `scripts/install-home.sh`, `home/settings.json`

**Interfaces:**
- Produces: `~/.memory/board/config.yml` on every machine, `~/.local/bin/board`, and a watcher that sees `board/`.

- [ ] **Step 1: The config template**

`home/board.config.yml`:

```yaml
# The fleet's board. Written by scripts/install-home.sh to ~/.memory/board/config.yml
# when that file does not exist; a hand edit there is never overwritten.
project_name: "rzem"
task_prefix: "BD"
statuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]
default_status: "To Do"
labels: ["outcome/shipped", "outcome/abandoned", "outcome/superseded"]
projects: ["Agents", "Angus", "art.rzem.guru", "Claude Agents", "Fathom", "files.rzem.ai", "MovingDay", "MyAssist Researcher", "OpenCode Agents", "Photos", "photos.rzem.ai", "SkillfulClaude", "Tabletop", "Tailwind Builder"]
priorities: ["High", "Medium", "Low"]
default_port: 6420
```

`install_tree` copies everything under `home/` into `~/.claude`, so add `board.config.yml` to the skip list in `install_tree`'s caller the way `hosts/` is skipped, and handle it in the new function below instead.

- [ ] **Step 2: The installer**

In `scripts/install-home.sh`:

1. Delete `OP_REF_LINEAR_TOKEN` and the `"linear.token|$OP_REF_LINEAR_TOKEN"` line from `secret_specs`, and the two comment paragraphs that describe the Linear key.
2. Add, after the secrets section, a `install_board()` function:

```bash
install_board() {
    local tree="${CLAUDECODE_AGENTS_BOARD_ROOT:-$HOME/.memory}"
    local pkg="$REPO_ROOT/claudecode-agents/board"
    local cfg="$tree/board/config.yml"
    local watcher="$tree/.sync/memory-watch.sh"
    say ""
    say "Board ($tree/board)"

    [ -d "$tree" ] || { warn "no memory tree at $tree; skipping the board (clone alexrzem/memory first)"; return 0; }

    if ! command -v bun >/dev/null 2>&1; then
        warn "bun is not installed; the board binary cannot be built."
        warn "  curl -fsSL https://bun.sh/install | bash   then re-run."
    elif [ "$DRY_RUN" -eq 1 ]; then
        info "would build    ~/.local/bin/board"
    else
        mkdir -p "$HOME/.local/bin"
        "$pkg/build.sh" "$HOME/.local/bin/board" >/dev/null && info "built          ~/.local/bin/board"
    fi

    if [ -f "$cfg" ]; then
        if cmp -s "$HOME_SRC/board.config.yml" "$cfg"; then
            N_UNCHANGED=$((N_UNCHANGED + 1))
        else
            info "kept           board/config.yml (differs from the template; diff below)"
            diff "$HOME_SRC/board.config.yml" "$cfg" | sed 's/^/    /' || true
        fi
    elif [ "$DRY_RUN" -eq 1 ]; then
        info "would create   board/config.yml"
    else
        mkdir -p "$tree/board/tasks" "$tree/board/docs" "$tree/board/milestones"
        cp "$HOME_SRC/board.config.yml" "$cfg"
        info "created        board/config.yml"
        N_CREATED=$((N_CREATED + 1))
    fi

    if [ -f "$watcher" ] && ! grep -q 'for scope in global hosts projects board' "$watcher"; then
        if [ "$DRY_RUN" -eq 1 ]; then
            info "would add      board to the memory watcher's scopes"
        else
            sed -i.bak 's/for scope in global hosts projects; do/for scope in global hosts projects board; do/' "$watcher" && rm -f "$watcher.bak"
            info "updated        memory watcher scopes (restart the watcher to pick it up)"
        fi
    fi
}
```

3. Call `install_board` from the run section after the secrets block, unconditionally (it does its own dry-run handling).
4. Update the header comment: job 2 now reads "Render the ten per-agent rzem-memory credentials", and a job 3 describes the board.

- [ ] **Step 3: settings.json**

In `home/settings.json` delete the `LINEAR_TOKEN` and `LINEAR_API_KEY` env-deny entries and `"api.linear.app"` from the sandbox network allowlist. Run `python3 -m json.tool home/settings.json >/dev/null` to prove it still parses.

- [ ] **Step 4: Dry run, then run**

```bash
scripts/install-home.sh --dry-run --home-only 2>&1 | grep -A6 "^Board"
scripts/install-home.sh --home-only 2>&1 | grep -A6 "^Board"
ls -la ~/.local/bin/board ~/.memory/board/config.yml
grep -n "for scope in" ~/.memory/.sync/memory-watch.sh
```

Expected: the dry run lists three "would" lines; the real run builds, creates and updates; the watcher line includes `board`.

- [ ] **Step 5: Commit the memory tree and the repo**

```bash
git -C ~/.memory add board .sync/memory-watch.sh && git -C ~/.memory commit -m "board: scope and config for the fleet's board" && git -C ~/.memory push
git add home/board.config.yml home/settings.json scripts/install-home.sh
git commit -m "installer: build the board binary, write its config, watch its scope; drop the Linear token

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: The hook library

**Files:**
- Rename: `claudecode-agents/hooks/lib/linear.sh` to `claudecode-agents/hooks/lib/board.sh`
- Modify: `claudecode-agents/hooks/board-subagent-start.sh:12-13`, `board-subagent-stop.sh:40-41`, `board-task-completed.sh:25-26` (the source line and its shellcheck directive)

**Interfaces:**
- Consumes: `board.sh` (Task 7) via `$HOOK_DIR/../board/board.sh`.
- Produces: `board_write` and `board_comment` unchanged in signature; `normalise_page_id` now accepts `BD-12`, `bd-12.3` and a task file path.

- [ ] **Step 1: Rename and delete the Linear half**

```bash
git mv claudecode-agents/hooks/lib/linear.sh claudecode-agents/hooks/lib/board.sh
```

In `board.sh`, delete from the line `# ---- Linear API` (around line 293) through the end of `linear_comment` (just before `# board_would_send` around line 555): `linear_tmp_init`, `linear_tmp_cleanup`, `linear_load_token`, `linear_api`, `linear_ok`, `linear_error_text`, `linear_resolve`, `linear_state_id`, `linear_set_status`, `linear_comment`. Delete `CLAUDECODE_AGENTS_TOKEN_FILE` and `LINEAR_API` at the top. Change `require_tools` to require `jq` only. In `BOARD_COL_*`, change the `To do` default to `To Do`.

- [ ] **Step 2: The three replacements**

Insert where the Linear block was:

```bash
# ------------------------------------------------------------------ the binary
#
# The board is the plugin's own binary, reached through one shim. The root is
# CLAUDECODE_AGENTS_BOARD_ROOT, defaulting to the memory tree; it is exported
# here, never inherited, so a hook fired inside a worktree cannot be pointed
# at that worktree by a stray variable.
BOARD_SHIM="${BOARD_SHIM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../board" 2>/dev/null && pwd)/board.sh}"
export CLAUDECODE_AGENTS_BOARD_ROOT="${CLAUDECODE_AGENTS_BOARD_ROOT:-$HOME/.memory}"
BOARD_CLI_TIMEOUT="${BOARD_CLI_TIMEOUT:-10}"

board_cli() {
  # $1 hook name, rest arguments. stdout is the command's; failures are logged.
  local hook="$1"; shift
  local err rc
  [ -x "$BOARD_SHIM" ] || { board_log "$hook" "board shim missing at $BOARD_SHIM"; return 1; }
  err="$(mktemp "${TMPDIR:-/tmp}/board-err.XXXXXX")" || return 1
  if command -v timeout >/dev/null 2>&1; then
    timeout "$BOARD_CLI_TIMEOUT" "$BOARD_SHIM" "$@" 2>"$err"; rc=$?
  else
    "$BOARD_SHIM" "$@" 2>"$err"; rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    board_log "$hook" "board $1 failed (exit $rc): $(head -c 300 "$err" | tr '\n' ' ')"
  fi
  rm -f "$err"
  return "$rc"
}

# board_resolve HOOK ID -> prints the canonical id, or nothing
board_resolve() {
  local hook="$1" id="$2"
  board_cli "$hook" task view "$id" --json | jq -r '.task.id // empty'
}

# board_set_status HOOK ID COLUMN
board_set_status() {
  local hook="$1" id="$2" col="$3"
  board_cli "$hook" task edit "$id" -s "$col" >/dev/null || return 1
  board_log "$hook" "$id -> $col"
}

# board_comment_raw HOOK ID TEXT
board_comment_raw() {
  local hook="$1" id="$2" text="$3"
  board_cli "$hook" task edit "$id" --comment "$text" --comment-author "@$hook" >/dev/null || return 1
  board_log "$hook" "commented on $id"
}
```

Then `board_write` and `board_comment` become:

```bash
board_write() {
  local hook="$1" page="$2" col="$3" comment="${4:-}"
  if [ -z "$page" ]; then
    board_log "$hook" "no board item resolved, nothing to move to \"$col\" (see README, Which board item)"
    return 0
  fi
  require_tools "$hook" || return 0
  if board_would_send; then
    local resolved
    resolved="$(board_resolve "$hook" "$page")" || resolved=""
    if [ -z "$resolved" ]; then board_log "$hook" "board item $page not found; nothing moved"; return 0; fi
    board_set_status "$hook" "$resolved" "$col" || true
    if [ -n "$comment" ]; then board_comment_raw "$hook" "$resolved" "$(board_cap_comment "$hook" "$page" "$comment")" || true; fi
  else
    board_log "$hook" "dry run: would move $page to $col${comment:+ with a comment}"
  fi
  return 0
}

board_comment() {
  local hook="$1" page="$2" text="$3"
  if [ -z "$page" ]; then
    board_log "$hook" "no board item resolved, nothing to comment on (see README, Which board item)"
    return 0
  fi
  if [ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]; then
    board_log "$hook" "no comment text; nothing posted on $page"
    return 0
  fi
  require_tools "$hook" || return 0
  if board_would_send; then
    local resolved
    resolved="$(board_resolve "$hook" "$page")" || resolved=""
    if [ -z "$resolved" ]; then board_log "$hook" "board item $page not found; nothing posted"; return 0; fi
    board_comment_raw "$hook" "$resolved" "$(board_cap_comment "$hook" "$page" "$text")" || true
  else
    board_log "$hook" "dry run: would comment on $page"
  fi
  return 0
}
```

`board_cap_comment HOOK PAGE TEXT` is the cap-and-archive step that lives inside `linear_comment` today: it prints the text cut to `BOARD_COMMENT_MAX_CHARS` with the `[Cut to fit a board comment ...]` trailer and writes the whole text through `board_archive_comment`. Before Step 1 deletes `linear_comment`, copy that portion (from where it measures the length to where it prints the capped body; roughly lines 485-540 of the old file) into `board_cap_comment`, unchanged except that it prints the capped text to stdout instead of building a GraphQL body. The contract suite already covers the cap and the archive, so a wrong lift fails there.

- [ ] **Step 3: The identifier parser**

Replace `normalise_page_id` with:

```bash
# A ref is a task id (BD-12, bd-12.3, any case), or a task file path under
# board/tasks/ as the CLI and the web UI hand it back. Nothing else is a ref.
normalise_page_id() {
  local raw ident
  raw="$(printf '%s' "$1" | tr -d '\r' | sed -e 's/[?#].*$//' -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
  [ -n "$raw" ] || return 1
  case "$raw" in
    */tasks/*)
      ident="$(basename "$raw" | grep -Eio '^[A-Za-z]+-[0-9]+(\.[0-9]+)*' | head -1 || true)"
      ;;
    *)
      ident="$(printf '%s' "$raw" | grep -Eio '^[A-Za-z]+-[0-9]+(\.[0-9]+)*$' || true)"
      ;;
  esac
  [ -n "$ident" ] || return 1
  printf '%s\n' "$ident" | tr 'a-z' 'A-Z'
}
```

Update the comment above `page_id_from_instructions` to read `Board-Item: BD-12`.

- [ ] **Step 4: Point the hooks at the new file**

In each of the three hooks, change `# shellcheck source=lib/linear.sh` and `. "$HOOK_DIR/lib/linear.sh"` to `board.sh`. `grep -rn "linear" claudecode-agents/hooks/` must then return only comments, and each of those is rewritten to say the board.

- [ ] **Step 5: Run the contract suite as it stands**

Run: `evals/lib/board-hook-contract.sh 2>&1 | tail -8`
Expected: the two Linear-format identifier cases fail (`identifier-binds` may pass, `issue-url-binds` fails); everything else passes. Task 10 rewrites those cases.

- [ ] **Step 6: Commit**

```bash
git add -A claudecode-agents/hooks && git commit -m "hooks: the board library calls the plugin's own binary; Linear half removed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: The contract suite

**Files:**
- Modify: `evals/lib/board-hook-contract.sh` (the identifier block around lines 102-115; append a live-backend section at the end)

- [ ] **Step 1: Rewrite the identifier cases**

Replace the block from the comment `# The board backend is Linear` through the `issue-url-binds` check with:

```bash
# A ref is a BD id in any case, a sub-task id, or a task file path. A Linear
# URL and a UUID were refs on the old board and are not refs now.
run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship the refresh [board:bd-12]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12"; check identifier-binds "a lower-case id resolves, uppercased" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:BD-12.3]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12.3"; check subtask-binds "a sub-task id resolves" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:/home/x/.memory/board/tasks/BD-12 - Ship-the-refresh.md]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
log_has "names board item BD-12" && ! log_has "SHIP"; check path-binds "a task file path resolves to its id, not its title" $?

run_hook board-task-completed.sh \
    "$(jq -nc --arg s "Ship [board:https://linear.app/rzemai/issue/RZE-123/fix-thing-2]" --arg c "$TMP" \
        '{session_id:"s1",cwd:$c,task_id:"t1",task_subject:$s}')"
! log_has "names board item"; check url-is-not-a-ref "a Linear URL is no longer a ref" $?
```

`PAGE_A` and `PAGE_B` at the top of the file are 32-hex UUIDs; change them to `BD-1` and `BD-2` and delete `PAGE_A_H`/`PAGE_B_H`, replacing every use with `PAGE_A`/`PAGE_B`.

- [ ] **Step 2: Append the live-backend section**

```bash
printf '\nLive backend: the hooks move a real item through the binary\n'

SHIM="$REPO_ROOT/claudecode-agents/board/board.sh"
if ! "$SHIM" --version >/dev/null 2>&1; then
    printf '  skipped: board binary not resolvable (%s); build it with claudecode-agents/board/build.sh\n' "$SHIM"
else
    LIVE="$TMP/live"; mkdir -p "$LIVE/board"
    printf 'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\ndefault_status: "To Do"\n' > "$LIVE/board/config.yml"
    export CLAUDECODE_AGENTS_BOARD_ROOT="$LIVE"
    export CLAUDECODE_AGENTS_BOARD=on
    unset BOARD_DRY_RUN
    ID="$(CLAUDECODE_AGENTS_BOARD_ROOT="$LIVE" "$SHIM" task create "Live item" --json | jq -r .task.id)"

    run_hook board-subagent-start.sh \
        "$(jq -nc --arg id "$ID" --arg c "$LIVE" '{session_id:"live",cwd:$c,agent_id:"a1",agent_type:"claudecode-agents:coder"}')" \
        CLAUDECODE_AGENTS_BOARD_PAGE_ID="$ID"
    [ "$("$SHIM" task view "$ID" --json | jq -r .task.status)" = "Doing" ]; check live-start-doing "SubagentStart moves the item to Doing" $?

    run_hook board-subagent-stop.sh \
        "$(jq -nc --arg id "$ID" --arg c "$LIVE" --arg m "$(printf '## Done\n- x\n\n## Not done\n- none\n\n## Unverified\n- none\n\n## Decisions needed\n- Blocker: which key?\n')" \
            '{session_id:"live",cwd:$c,agent_id:"a1",agent_type:"claudecode-agents:coder",status:"success",last_assistant_message:$m}')"
    [ "$("$SHIM" task view "$ID" --json | jq -r .task.status)" = "Blocked by human" ]; check live-blocker "a Blocker: line moves the item to Blocked by human" $?
    "$SHIM" task view "$ID" --json | jq -e '.task.comments[] | select(.author == "@board-subagent-stop") | select(.content | test("which key"))' >/dev/null
    check live-comment "the blocker text lands as an authored comment" $?

    export CLAUDECODE_AGENTS_BOARD=off
fi
```

`run_hook` in this suite takes the hook and its JSON; check how it passes environment (the `CLAUDECODE_AGENTS_BOARD_PAGE_ID` binding above) and, if it does not, export the variable before the call and unset it after. The `agent_type` and `status` field names come from the hook input schemas the suite already uses in its earlier cases; copy them from there.

- [ ] **Step 3: Run**

Run: `evals/lib/board-hook-contract.sh 2>&1 | tail -12`
Expected: every check passes including the three live ones. Then `evals/lib/check-all.sh 2>&1 | tail -5` passes.

- [ ] **Step 4: Commit**

```bash
git add evals/lib/board-hook-contract.sh && git commit -m "contract suite: BD identifiers, paths, and a live pass through the binary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 3: agents and docs

### Task 11: The MCP server and the three bodies

**Files:**
- Create: `claudecode-agents/.mcp.json`
- Modify: `claudecode-agents/agents/spec-writer.md:7-8`, `claudecode-agents/agents/fleet-steward.md:7-8`, `claudecode-agents/agents/lead.md:31`, `docs/agent-contract.md` (the server table)

- [ ] **Step 1: .mcp.json**

```json
{
  "mcpServers": {
    "board": {
      "command": "${CLAUDE_PLUGIN_ROOT}/board/board.sh",
      "args": ["mcp"]
    }
  }
}
```

- [ ] **Step 2: Confirm the identifier before touching a body**

Refresh the marketplace so the plugin cache carries `.mcp.json`, start a session, and run `claude mcp list`; then in the session list the tools and copy the exact prefix of `task_view`. Expected form: `mcp__plugin_claudecode-agents_board__task_view`. Record the confirmed spelling as a new row in the table in `docs/agent-contract.md`, replacing the Linear row, with today's date and "tool listing in a live session" as the source. If the spelling differs from the expected form, the confirmed one wins everywhere below.

- [ ] **Step 3: The bodies**

Using the confirmed prefix `P`:

`spec-writer.md` tools: replace the nine `mcp__claude_ai_Linear__*` entries with `P__task_view, P__task_list, P__task_search, P__milestone_list, P__document_view, P__document_list, P__document_search`; disallowedTools: replace the five Linear saves with `P__task_create, P__task_edit, P__task_archive, P__task_complete, P__milestone_add, P__milestone_rename, P__milestone_remove, P__milestone_archive, P__document_create, P__document_update, P__definition_of_done_defaults_upsert`.

`fleet-steward.md` tools: the seven reads above plus `P__task_create, P__task_edit`; disallowedTools: `P__task_archive, P__task_complete` and the milestone and document writes listed above. Add to its Invariants section: "Through `task_edit` you pass `comments` and nothing else: no status, no field. Moving a column is a hook's act."

`lead.md:31`: "a board item you file in Linear" becomes "a board item you file on the board with `task_create`, with the project set, and with `docs/specs/<id>.md` and `docs/plans/<id>.md` added as references rather than pasted in". Search the three bodies for any other "Linear" and rewrite each.

- [ ] **Step 4: Gate**

Run `evals/lib/check-all.sh 2>&1 | tail -5` (the roster contract and the migration checklist read the frontmatter). Expected: pass.

- [ ] **Step 5: Register the same server for Cowork on the laptop**

Claude Desktop reads `~/Library/Application Support/Claude/claude_desktop_config.json`, which today has no `mcpServers`. Add:

```json
{
  "mcpServers": {
    "board": {
      "command": "/Users/alex/.local/bin/board",
      "args": ["mcp"],
      "env": { "CLAUDECODE_AGENTS_BOARD_ROOT": "/Users/alex/.memory" }
    }
  }
}
```

Restart Claude Desktop; the `board` server shows in its connectors list with the task tools. This file is per-machine and is not committed anywhere.

- [ ] **Step 6: Commit**

```bash
git add claudecode-agents/.mcp.json claudecode-agents/agents docs/agent-contract.md
git commit -m "agents: the board MCP server replaces the Linear connector for the same three

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Skills, commands, plan, changelog

**Files:**
- Modify: `claudecode-agents/skills/board/SKILL.md`, `claudecode-agents/skills/glossary/SKILL.md:10-14,27-28`, `claudecode-agents/commands/kickoff.md:21-41`, `docs/fleet-plan.md` (top revision paragraphs), `claudecode-agents/.claude-plugin/plugin.json:6,21`, `claudecode-agents/CHANGELOG.md`, `~/.memory/projects/claudecode-agents/rzemai-linear-board-conventions.md`, `claudecode-agents/hooks/README.md` (added during execution; no earlier task owned it: the `lib/linear.sh` table row becomes `lib/board.sh`, the token section goes, the column-move explanation describes the `board` binary and the memory tree instead of GraphQL, and the troubleshooting "HTTP error" symptom becomes the shim's exit 127 and the `board <cmd> failed` log line)

- [ ] **Step 1: The board skill**

Rewrite these parts of `skills/board/SKILL.md`, leaving every paragraph that does not name Linear alone:

- Frontmatter `description` and `when_to_use`: "the Linear board" becomes "the board", "Linear issue or project" becomes "board item or project".
- "# The board" opening: "The board lives in Linear: one workspace, one team, and the board is the team's issues grouped by workflow state." becomes "The board is a directory of markdown files, one per item, at `board/tasks/` under the memory tree, and the board is those files grouped by status. It is written through the plugin's own `board` binary and never by hand; the memory sync agent carries it between machines."
- **Projects** paragraph: "one Linear project per bounded body of work" becomes "one entry in the config's `projects` list per bounded body of work"; delete the initiative sentence and add "A goal spanning projects is a milestone shared across them, or a document."
- **Issues** paragraph: "sub-issues as Linear's native parent relation" becomes "sub-items as a parent task, `BD-12.1` under `BD-12`".
- The columns paragraph after the table: replace from "The columns are Linear workflow states" to "not waiting to start." with "The columns are the `statuses` list in `board/config.yml`, spelled exactly as the table has them, and the hooks match them ignoring case. `board.env` overrides still exist for a tree whose config spells them differently, but the installer writes the fleet's spelling and nothing should need one."
- "each calling Linear's GraphQL API directly with their own key" becomes "each calling the `board` binary against the memory tree".
- The `Board-Item:` section: the example becomes `Board-Item: BD-12`; the accepted-shapes list becomes: an id in any case (`bd-12` resolves as `BD-12`), a sub-task id (`BD-12.3`), or the task file's path as the CLI or web UI hands it back. Delete the URL and UUID bullets. The `CLAUDECODE_AGENTS_BOARD_PAGE_ID=RZE-123` example becomes `BD-12`; `hooks/lib/linear.sh` becomes `hooks/lib/board.sh`.
- "Done, and the outcome": "Linear has no free-form fields on an issue, and a label is queryable where a comment is not." becomes "A label is queryable where a comment is not."
- "Item conventions": "Every issue is in a project, because an issue with no project is invisible in every view that matters." stays; add "The project is one of the names in the config's list, and the lead adds a name there before filing the first item under it."
- "What earns an item": `fleet-steward` files "as issues under the Agent fleet project" becomes "as items under the `Claude Agents` project" (added during execution: "Agent fleet" is not in the config's project list and `task_create` rejects it).
- `claudecode-agents/agents/fleet-steward.md`, the step that audits MCP identifiers against `claude mcp list` (added during execution): a plugin-shipped server never appears in `claude mcp list`; the sentence says the board's server is confirmed by a live tool listing, as `docs/agent-contract.md` records, and is not filed as broken on that evidence.
- Add a section "## The CLI" after "Item conventions" carrying the flags as the plan's Task 3 defines them, in a table: create (`-d`, `-s`, `-a`, `-l`, `--priority`, `--project`, `--milestone`, `-p`, `--dep`, `--ac`, `--plan`, `--notes`), edit (the same plus `--append-notes`, `--comment` with `--comment-author`, `--check-ac`, `--final-summary`), `view`, `list --status --project --json`, `search`, `export`. Note that nested `--help` in the upstream tool fell through, which is why this table exists.

- [ ] **Step 2: The glossary**

Lines 10-14 and 27-28 of `skills/glossary/SKILL.md`, third column: Initiative "none; a shared milestone or a document"; Project "an entry in the board config's `projects` list"; Milestone "a milestone file"; Issue "a task file (`BD-12`)"; Sub-issue "a sub-task (`BD-12.1`)"; Board "the task files grouped by status; `board export` or the web UI"; Human queue "the `Blocked by human` status". Run `scripts/gen-glossary-rule.sh` if the glossary has generated copies, and commit those too.

- [ ] **Step 3: kickoff**

Replace the "## Board" section of `commands/kickoff.md` (lines 21-41) with a section that: runs only when `${CLAUDE_PLUGIN_ROOT}/board/board.sh --version` succeeds; checks `board/config.yml` exists under the board root, that its `statuses` are the five, and that this repo's name is in `projects`; on a missing project offers to add it and, on a yes, edits the config file and commits the memory tree; states the conventions (the root, the prefix `BD`, the five names, the repo's project name, the outcome labels, the `CLAUDECODE_AGENTS_BOARD_PAGE_ID=BD-12` launch line and the `[board:BD-12]` task marker); and ends with the one check it cannot do: whether the `board` binary on this machine is current, which `~/.local/bin/board --version` against the plugin's `package.json` answers.

- [ ] **Step 4: The plan's revision paragraph, plugin.json, CHANGELOG, memory**

At the top of `docs/fleet-plan.md`, after the existing revision paragraphs, add one paragraph dated 17 September 2026: section 7's backing store is now the plugin's own copy of Backlog.md in the memory tree, per `docs/2026-09-17-backlog-board.md`; the column meanings, the hook ownership of columns and the human queue are unchanged; the Milestone 4 decision was taken early.

`plugin.json`: description "the hooks that keep a Linear board honest" becomes "the hooks that keep the board honest, and the board itself"; keyword `linear` becomes `board`.

`CHANGELOG.md` Unreleased: one entry in the house style naming the package, the hook library, the identifier change, the removed token and sandbox entries, the MCP server, and the docs.

Rewrite `~/.memory/projects/claudecode-agents/rzemai-linear-board-conventions.md` as `board-conventions.md` (name, description and body) for the new board: root, prefix, statuses, where the config is, that the sync agent commits it; update its line in that directory's `MEMORY.md`; commit the memory tree.

- [ ] **Step 5: Gate and commit**

Run `grep -rn -i "linear" claudecode-agents/ docs/agent-contract.md README.md | grep -v CHANGELOG | grep -v "non-linear\|superlinear\|not linear\|linear pass"`. Expected: no output. Run `evals/lib/check-all.sh 2>&1 | tail -5`. Expected: pass.

```bash
git add -A && git commit -m "docs: the board skill, glossary, kickoff and plan describe the file board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Release

- [ ] **Step 1:** Move the Unreleased entry to `0.17.0` with today's date; bump `plugin.json` version to `0.17.0`.
- [ ] **Step 2:** `evals/lib/check-all.sh 2>&1 | tail -5` passes.
- [ ] **Step 3:** Commit `v0.17.0: the board moves into the plugin`, then on each of marvin, slarti, trillian and eddie: `claude plugin marketplace update rzem`, `git -C ~/.memory pull`, `scripts/install-home.sh --home-only`, and `~/.local/bin/board task list --json | jq .kind` prints `task-list`.

---

## Phase 4: the web board on slarti

These steps follow the homelab skill's recipes 1, 2 and 3 and touch no file in this repo. Read `references/recipes.md` before each.

- [ ] **Step 1:** On slarti, `~/.local/bin/board serve --port 6420` from a shell with `CLAUDECODE_AGENTS_BOARD_ROOT=$HOME/.memory`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6420/` prints 200. Stop it.
- [ ] **Step 2:** Create `/srv/sprites/services/board/board.service` in the house unit shape (recipe 3): `ExecStart=%h/.local/bin/board serve --port 6420`, `Environment=CLAUDECODE_AGENTS_BOARD_ROOT=%h/.memory`, `Restart=on-failure`, `User=` the user that owns the memory clone; symlink into `/etc/systemd/system`, `daemon-reload`, `enable --now`, and repeat the curl.
- [ ] **Step 3:** Recipe 1: the nginx vhost `board.rzem.ai` proxying to `127.0.0.1:6420` with the WebSocket upgrade headers, the tunnel rule before the catch-all, `systemctl restart cloudflared`; `curl -s -o /dev/null -w '%{http_code}' https://board.rzem.ai/` prints 200.
- [ ] **Step 4:** Recipe 2: put the vhost behind the gate; the same curl now prints 302 to `id.rzem.ai`, and a browser login shows the board.
- [ ] **Step 5:** Move an item in the browser; within a minute `git -C ~/.memory log -1 --stat` on marvin shows the task file changed by the slarti sync commit.
