# Project Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the board from the memory tree into each repository at `.boards/`, committed by the binary after every write, discovered from cwd through git to the main checkout, with a `task_focus` tool replacing the launch-time item variable.

**Architecture:** The board binary resolves its root from cwd via `git rev-parse --git-common-dir` (env override kept), names the directory `.boards`, and commits its own writes pathspec-limited through a small real git layer that replaces the throwing stub for add and commit only. The hooks run the binary in the hook's cwd and gain a focus-file source for the item binding. Commands, agents, docs and a one-shot migration follow.

**Tech Stack:** Bun + TypeScript (the `board` package under `claudecode-agents/board/`), bash hooks under `claudecode-agents/hooks/`, the bash contract suites under `evals/lib/`.

**Spec:** `docs/2026-09-18-project-boards.md`

## Global Constraints

- The board directory is `.boards` at the root of the main checkout. Never a linked worktree's copy.
- `CLAUDECODE_AGENTS_BOARD_ROOT`, when set, names the directory that contains `.boards/` and wins over discovery.
- Every write the binary makes is followed by `git add -- .boards` and `git commit -q -m "<msg>" -- .boards` in the main checkout, unless `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1`, `.boards` is ignored, or `auto_commit` is not `true` in `config.yml`.
- Commit subjects: `board: <id> <note> (<by>)`, with `<note>` the status name for a move, `comment` for a comment, `created`/`updated`/`archived` otherwise, and `(<by>)` omitted when no writer was named.
- A commit that cannot be made is logged to stderr and the exit is 0. The index lock is retried three times, 300 ms apart.
- Item precedence in `SubagentStart`: `.boards/.focus`, then the session's `last-item` state, then `CLAUDECODE_AGENTS_BOARD_PAGE_ID`.
- No em dashes or en dashes in any agent body, command or skill (the roster contract checks bodies).
- Agent bodies stay under 60 lines with exactly four H2 sections.
- Every agent-facing doc says "the human", never a name.
- `evals/lib/check-all.sh` must pass, except the board test step under the sandbox, which fails only on the loopback listener; run the board tests outside the sandbox to confirm.
- Version bump to 0.19.0 in `claudecode-agents/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, with a matching `## [0.19.0]` changelog heading, in the release task only.

## File structure

Created:
- `claudecode-agents/board/src/git/commit-context.ts` - who and what a commit is for, set by the CLI and the MCP server, read by the git layer.
- `claudecode-agents/board/src/git/branch-ids.ts` - read-only scan of task ids across every local and remote-tracking ref.
- `claudecode-agents/board/src/core/focus.ts` - read, write and clear `.boards/.focus`.
- `claudecode-agents/board/src/mcp/tools/focus/index.ts` - the `task_focus` tool.
- `claudecode-agents/board/src/test/board-root-git.test.ts`, `git-commit.test.ts`, `branch-ids.test.ts`, `focus.test.ts`, `mcp-focus.test.ts`.
- `claudecode-agents/templates/board.config.yml`, `claudecode-agents/templates/board.gitignore`.
- `claudecode-agents/commands/work.md`.
- `scripts/migrate-memory-board.sh`.

Modified:
- `claudecode-agents/board/src/constants/index.ts` - `BACKLOG: ".boards"`.
- `claudecode-agents/board/src/board-root.ts` - git discovery.
- `claudecode-agents/board/src/git/operations.ts` - real add, commit, stage-move, reset, repository root; the rest stays a stub.
- `claudecode-agents/board/src/file-system/operations.ts` - stop forcing `autoCommit` off.
- `claudecode-agents/board/src/core/backlog.ts` - `shouldAutoCommit`, cross-ref ids in `getActiveAndCompletedTaskIds`.
- `claudecode-agents/board/src/cli.ts` - `--by`, commit notes, `focus` command.
- `claudecode-agents/board/src/mcp/server.ts` - register the focus tool, set the MCP commit context.
- `claudecode-agents/board/NOTICE.md` - the git layer's partial return.
- `claudecode-agents/hooks/lib/board.sh`, `board-subagent-start.sh`, `board-subagent-stop.sh`, `board-task-completed.sh`.
- `evals/lib/board-hook-contract.sh`, `evals/lib/check-all.sh`.
- `claudecode-agents/commands/init.md`, `kickoff.md`; `claudecode-agents/agents/lead.md`; `claudecode-agents/skills/board/SKILL.md`, `skills/glossary/SKILL.md` (+ regenerated `templates/rules/glossary.md`); `claudecode-agents/hooks/README.md`; `docs/fleet-plan.md`; `docs/2026-09-17-backlog-board.md`; `scripts/install-home.sh`; `claudecode-agents/CHANGELOG.md`; both manifests.
- Deleted: `home/board.config.yml`.

---

## Phase 1: the binary

### Task 1: `.boards` and root discovery through git

**Files:**
- Modify: `claudecode-agents/board/src/constants/index.ts:6`
- Modify: `claudecode-agents/board/src/board-root.ts`
- Modify: `claudecode-agents/board/src/test/board-root.test.ts`
- Create: `claudecode-agents/board/src/test/board-root-git.test.ts`

**Interfaces:**
- Produces: `resolveBoardRoot(env = process.env, cwd = process.cwd()): string` - the directory that contains `.boards/`. Throws `Error` whose message contains `no board here` when cwd is not in a repository or the main checkout has no `.boards/`, and contains `CLAUDECODE_AGENTS_BOARD_ROOT` when the variable names a non-directory.
- Produces: `BOARD_DIR = ".boards"` (unchanged name, new value) and `DEFAULT_DIRECTORIES.BACKLOG = ".boards"`.
- Produces: `mainCheckoutOf(cwd: string): string | null` - exported for the hooks' contract and later tasks.

- [ ] **Step 1: Change the directory constant**

In `src/constants/index.ts` change line 6 from `BACKLOG: "board",` to `BACKLOG: ".boards",`. Leave `HIDDEN_BACKLOG` alone.

- [ ] **Step 2: Write the failing git-discovery tests**

Create `src/test/board-root-git.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR, mainCheckoutOf, resolveBoardRoot } from "../board-root.ts";

// The board is the main checkout's .boards, found from any cwd inside the
// repository - a subdirectory, or a linked worktree, which carries its own
// stale copy and must never be the answer.
let tmp = "";
let repo = "";
let wt = "";

function git(dir: string, ...args: string[]) {
	const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "board-root-git-"));
	repo = join(tmp, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	mkdirSync(join(repo, BOARD_DIR, "tasks"), { recursive: true });
	writeFileSync(join(repo, BOARD_DIR, "config.yml"), 'project_name: "t"\ntask_prefix: "BD"\n');
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	wt = join(tmp, "wt");
	git(repo, "worktree", "add", "-q", wt, "-b", "agent-x");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveBoardRoot through git", () => {
	it("finds the repository root from a subdirectory", () => {
		expect(resolveBoardRoot({}, join(repo, "src", "deep"))).toBe(repo);
	});

	it("resolves a linked worktree to the main checkout, never the worktree's copy", () => {
		expect(mainCheckoutOf(wt)).toBe(repo);
		expect(resolveBoardRoot({}, wt)).toBe(repo);
	});

	it("says 'no board here' outside a repository", () => {
		const bare = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(() => resolveBoardRoot({}, bare)).toThrow("no board here");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("says 'no board here' in a repository with no .boards", () => {
		const other = join(tmp, "other");
		mkdirSync(other);
		git(other, "init", "-q", "-b", "main");
		expect(() => resolveBoardRoot({}, other)).toThrow("no board here");
	});

	it("lets the environment variable win over discovery", () => {
		expect(resolveBoardRoot({ CLAUDECODE_AGENTS_BOARD_ROOT: repo }, wt)).toBe(repo);
	});
});
```

- [ ] **Step 3: Run the new tests to see them fail**

Run: `cd claudecode-agents/board && bun test src/test/board-root-git.test.ts`
Expected: FAIL - `mainCheckoutOf` is not exported; `resolveBoardRoot` takes no cwd.

- [ ] **Step 4: Rewrite `board-root.ts`**

Replace the whole file with:

```ts
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Overrides discovery when set: the directory that contains `.boards/`. */
export const BOARD_ROOT_ENV = "CLAUDECODE_AGENTS_BOARD_ROOT";
/** The directory under the root that holds tasks, config and the rest. */
export const BOARD_DIR = ".boards";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The main checkout of the repository containing `cwd`, or null outside a
 * repository. A linked worktree's git dir is `<main>/.git/worktrees/<name>`,
 * and `--git-common-dir` answers `<main>/.git` from either, so the parent of
 * that is the main checkout in both cases. This is the one rule that survives
 * from the memory-tree design: a worktree carries a copy of `.boards/` because
 * it is committed, and nothing may write to that copy.
 */
export function mainCheckoutOf(cwd: string): string | null {
	const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) return null;
	const common = proc.stdout.toString().trim();
	if (common.length === 0) return null;
	const absolute = resolve(cwd, common);
	return dirname(absolute);
}

/**
 * Where the board is. The environment variable wins when set; otherwise the
 * main checkout of the repository containing cwd, which must already hold a
 * `.boards/` directory. There is no fallback board.
 */
export function resolveBoardRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
	const fromEnv = env[BOARD_ROOT_ENV]?.trim();
	if (fromEnv && fromEnv.length > 0) {
		const root = resolve(fromEnv);
		if (!isDirectory(root)) {
			throw new Error(`board root is not a directory: ${root} (${BOARD_ROOT_ENV} names the directory that contains ${BOARD_DIR}/)`);
		}
		return root;
	}
	const main = mainCheckoutOf(cwd);
	if (main === null) {
		throw new Error(`no board here: ${cwd} is not inside a git repository, and there is no ${BOARD_DIR}/ without one`);
	}
	if (!isDirectory(join(main, BOARD_DIR))) {
		throw new Error(`no board here: ${main} has no ${BOARD_DIR}/ directory (run /init in that repository to create one)`);
	}
	return main;
}
```

- [ ] **Step 5: Rewrite the existing root tests**

Replace `src/test/board-root.test.ts` with:

```ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR, BOARD_ROOT_ENV, resolveBoardRoot } from "../board-root.ts";

describe("resolveBoardRoot with the environment variable", () => {
	it("uses the variable when it names a directory, without asking git", () => {
		const dir = mkdtempSync(join(tmpdir(), "board-root-"));
		try {
			expect(resolveBoardRoot({ [BOARD_ROOT_ENV]: dir }, "/")).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws a message naming the variable when the root is not a directory", () => {
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "/nonexistent/board-root" }, "/")).toThrow(BOARD_ROOT_ENV);
	});

	it("ignores a blank variable and falls through to discovery", () => {
		// "/" is not a repository, so discovery must say so rather than
		// resolving against the process cwd or a home directory.
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "  " }, "/")).toThrow("no board here");
	});

	it("names the directory constant in the no-board message", () => {
		const bare = mkdtempSync(join(tmpdir(), "no-board-"));
		mkdirSync(join(bare, "x"));
		try {
			expect(() => resolveBoardRoot({}, join(bare, "x"))).toThrow(BOARD_DIR);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 6: Run both root test files and the fleet's board tests**

Run: `cd claudecode-agents/board && bun test src/test/board-root.test.ts src/test/board-root-git.test.ts src/test/cli-board.test.ts src/test/cli-board-behaviour.test.ts src/test/no-git.test.ts src/test/serve-board.test.ts src/test/mcp-serve.test.ts && bunx tsc --noEmit`
Expected: all pass; the CLI tests create `DEFAULT_DIRECTORIES.BACKLOG` so they follow the constant. If `no-git.test.ts` asserts anything about the `.memory` default, rewrite that assertion to expect `no board here` from a non-repository cwd.

- [ ] **Step 7: Commit**

```bash
git add claudecode-agents/board/src/constants/index.ts claudecode-agents/board/src/board-root.ts claudecode-agents/board/src/test/board-root.test.ts claudecode-agents/board/src/test/board-root-git.test.ts
git commit -m "board: the root is the main checkout's .boards, found from cwd through git"
```

---

### Task 2: the binary commits its own writes

**Files:**
- Create: `claudecode-agents/board/src/git/commit-context.ts`
- Modify: `claudecode-agents/board/src/git/operations.ts`
- Modify: `claudecode-agents/board/src/file-system/operations.ts:230-240`
- Modify: `claudecode-agents/board/src/core/backlog.ts:1005-1007`
- Create: `claudecode-agents/board/src/test/git-commit.test.ts`

**Interfaces:**
- Produces: `setCommitContext({ by?: string; note?: string }): void` and `getCommitContext(): { by?: string; note?: string }` and `clearCommitContext()`.
- Produces: `GitOperations.commitBoard(subjectNote: string, taskId?: string): Promise<boolean>` - the one commit routine every other method funnels into; returns `true` when a commit landed, `false` when skipped or failed (logged).
- Produces: `formatCommitSubject(id: string | undefined, note: string, by?: string): string` - `board: BD-1 Doing (SubagentStop)`.
- Consumes: `resolveBoardRoot`, `BOARD_DIR` from Task 1.

- [ ] **Step 1: Write the failing tests**

Create `src/test/git-commit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import { Core } from "../core/backlog.ts";
import { clearCommitContext, setCommitContext } from "../git/commit-context.ts";
import { formatCommitSubject } from "../git/operations.ts";

// Every write the binary makes is committed, pathspec-limited to .boards, on
// the main checkout's current branch. The human's own staged work is never
// swept in, a locked index is retried, and three switches turn it off: the
// env var, an ignored .boards, and auto_commit not being true.

let tmp = "";
let repo = "";

function git(...args: string[]) {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function config(extra = "auto_commit: true\n") {
	writeFileSync(
		join(repo, BOARD_DIR, "config.yml"),
		`project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\ndefault_status: "To Do"\n${extra}`,
	);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "git-commit-"));
	repo = join(tmp, "repo");
	mkdirSync(join(repo, BOARD_DIR, "tasks"), { recursive: true });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	config();
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	delete process.env.CLAUDECODE_AGENTS_BOARD_NO_COMMIT;
	clearCommitContext();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CLAUDECODE_AGENTS_BOARD_NO_COMMIT;
	clearCommitContext();
});

describe("formatCommitSubject", () => {
	it("names the id, the note and the writer", () => {
		expect(formatCommitSubject("BD-1", "Doing", "SubagentStop")).toBe("board: BD-1 Doing (SubagentStop)");
		expect(formatCommitSubject("BD-1", "created")).toBe("board: BD-1 created");
		expect(formatCommitSubject(undefined, "milestone added")).toBe("board: milestone added");
	});
});

describe("the binary commits its writes", () => {
	it("commits a create with a subject naming the id", async () => {
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} created`);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("commits a status move with the status as the note and the writer in parens", async () => {
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		setCommitContext({ by: "SubagentStop", note: "Doing" });
		await core.updateTaskFromInput(task.id, { status: "Doing" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} Doing (SubagentStop)`);
	});

	it("leaves the human's staged work out of the commit", async () => {
		writeFileSync(join(repo, "notes.txt"), "mine\n");
		git("add", "notes.txt");
		const core = new Core(repo);
		await core.createTaskFromInput({ title: "First" });
		expect(git("diff", "--cached", "--name-only")).toBe("notes.txt");
		expect(git("show", "--stat", "--format=", "HEAD")).not.toContain("notes.txt");
	});

	it("skips the commit when CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1 and leaves the file", async () => {
		process.env.CLAUDECODE_AGENTS_BOARD_NO_COMMIT = "1";
		const core = new Core(repo);
		await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe("base");
		expect(git("status", "--porcelain")).toContain(BOARD_DIR);
	});

	it("skips the commit when .boards is ignored", async () => {
		writeFileSync(join(repo, ".gitignore"), `${BOARD_DIR}/\n`);
		git("add", ".gitignore");
		git("commit", "-q", "-m", "ignore");
		git("rm", "-r", "-q", "--cached", BOARD_DIR);
		git("commit", "-q", "-m", "untrack");
		const core = new Core(repo);
		await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe("untrack");
	});

	it("skips the commit when auto_commit is not true", async () => {
		config("");
		git("commit", "-q", "-a", "-m", "config");
		const core = new Core(repo);
		await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe("config");
	});

	it("retries a locked index and lands once the lock clears", async () => {
		const lock = join(repo, ".git", "index.lock");
		writeFileSync(lock, "");
		setTimeout(() => rmSync(lock, { force: true }), 400);
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} created`);
	});

	it("logs and keeps the file when the commit cannot be made at all", async () => {
		const lock = join(repo, ".git", "index.lock");
		writeFileSync(lock, "");
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		rmSync(lock, { force: true });
		expect(git("log", "-1", "--format=%s")).toBe("base");
		expect((await core.getTask(task.id))?.title).toBe("First");
	});
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd claudecode-agents/board && bun test src/test/git-commit.test.ts`
Expected: FAIL - `commit-context.ts` does not exist; `formatCommitSubject` not exported.

- [ ] **Step 3: Write the commit context module**

Create `src/git/commit-context.ts`:

```ts
/**
 * Who a commit is for and what it records. The CLI sets it from `--by` and
 * from the shape of the edit (a `-s` is a status move, a `--comment` is a
 * comment); the MCP server sets `by: "mcp"`. The git layer reads it when it
 * builds the subject. Process-wide because one invocation makes one write.
 */
export type CommitContext = { by?: string; note?: string };

let current: CommitContext = {};

export function setCommitContext(ctx: CommitContext): void {
	current = { ...current, ...ctx };
}

export function getCommitContext(): CommitContext {
	return current;
}

export function clearCommitContext(): void {
	current = {};
}
```

- [ ] **Step 4: Replace the git stub's write methods with real ones**

In `src/git/operations.ts`, replace the header comment and the class with:

```ts
// The git layer, carried back in part on 18 September 2026 (docs/2026-09-18-project-boards.md).
//
// Only what a board that commits its own writes needs: add and commit,
// pathspec-limited to the board directory, an index-lock retry, and the
// repository root. Cross-branch task loading, remote fetches and everything
// else upstream's layer did stay out; the methods Core still calls for those
// return empty rather than throwing, so filesystem-only reads are unchanged.
import { relative, resolve } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import type { BacklogConfig } from "../types/index.ts";
import { getCommitContext } from "./commit-context.ts";

export interface GitBranchTip {
	name: string;
	commit: string;
	current: boolean;
}

export interface GitIndexEntry {
	mode: string;
	objectId: string;
	stage: number;
}

export const NO_COMMIT_ENV = "CLAUDECODE_AGENTS_BOARD_NO_COMMIT";
const LOCK_RETRIES = 3;
const LOCK_RETRY_MS = 300;

export function formatCommitSubject(id: string | undefined, note: string, by?: string): string {
	const head = id ? `board: ${id} ${note}` : `board: ${note}`;
	return by ? `${head} (${by})` : head;
}

function run(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitOperations {
	constructor(
		public readonly projectRoot: string,
		_config: BacklogConfig | null = null,
		_configLoader?: () => Promise<BacklogConfig | null>,
	) {}

	setConfig(_config: BacklogConfig | null): void {}

	async getRepositoryRoot(cwd?: string): Promise<string | null> {
		const r = run(cwd ?? this.projectRoot, ["rev-parse", "--show-toplevel"]);
		return r.code === 0 && r.out.length > 0 ? r.out : null;
	}

	/** Worktree copies of the board are never consulted, so there are none to list. */
	async listWorktreePaths(): Promise<string[]> {
		return [];
	}

	async getIndexEntries(_filePath: string): Promise<GitIndexEntry[]> {
		return [];
	}

	async restoreIndexEntriesIfMatches(
		_filePath: string,
		_expectedEntries: readonly GitIndexEntry[],
		_restoreEntries: readonly GitIndexEntry[],
	): Promise<boolean> {
		return true;
	}

	/**
	 * The one commit routine. `git add -- .boards` then `git commit -- .boards`,
	 * so the human's own staged work stays out of it. Skipped, quietly, when the
	 * env var says so or .boards is ignored; retried on a locked index; logged and
	 * false on anything else. The file write has already happened either way.
	 */
	async commitBoard(note: string, taskId?: string): Promise<boolean> {
		if (process.env[NO_COMMIT_ENV] === "1") return false;
		const root = await this.getRepositoryRoot();
		if (!root) return false;
		const boardPath = relative(root, resolve(this.projectRoot, BOARD_DIR)) || BOARD_DIR;
		if (run(root, ["check-ignore", "-q", boardPath]).code === 0) return false;
		const ctx = getCommitContext();
		const subject = formatCommitSubject(taskId, ctx.note ?? note, ctx.by);
		for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
			const add = run(root, ["add", "--", boardPath]);
			if (add.code !== 0 && /index\.lock/.test(add.err)) {
				await sleep(LOCK_RETRY_MS);
				continue;
			}
			if (add.code !== 0) {
				console.error(`board: commit skipped (git add): ${add.err}`);
				return false;
			}
			const commit = run(root, ["commit", "-q", "-m", subject, "--", boardPath]);
			if (commit.code === 0) return true;
			if (/index\.lock/.test(commit.err)) {
				await sleep(LOCK_RETRY_MS);
				continue;
			}
			if (/nothing to commit|no changes added/.test(commit.err + commit.out)) return false;
			console.error(`board: commit skipped (git commit): ${commit.err || commit.out}`);
			return false;
		}
		console.error(`board: commit skipped: the index stayed locked for ${LOCK_RETRIES} attempts`);
		return false;
	}

	async addFile(_filePath: string): Promise<void> {}

	async addFiles(_filePaths: string[]): Promise<void> {}

	async stageFileMove(_fromPath: string, _toPath: string): Promise<string | null> {
		return this.getRepositoryRoot();
	}

	async resetPaths(_filePaths: string[], _repoRoot?: string | null): Promise<void> {}

	async commitFiles(message: string, _filePaths: string[], _repoRoot?: string | null): Promise<void> {
		await this.commitBoard(message.replace(/^backlog:\s*/i, ""));
	}

	async commitTaskChange(taskId: string, message: string, _filePath: string): Promise<void> {
		await this.commitBoard(message.replace(new RegExp(`^(Create|Update) (draft )?${taskId}$`), (_m, verb) => (verb === "Create" ? "created" : "updated")), taskId);
	}

	async addAndCommitTaskFile(
		taskId: string,
		_filePath: string,
		action: "create" | "update" | "archive",
		_onStaged?: (entries: GitIndexEntry[]) => void,
	): Promise<void> {
		const note = action === "create" ? "created" : action === "update" ? "updated" : "archived";
		await this.commitBoard(note, taskId);
	}
}

export async function isGitRepository(projectRoot: string): Promise<boolean> {
	return run(projectRoot, ["rev-parse", "--is-inside-work-tree"]).code === 0;
}

export async function initializeGitRepository(_projectRoot: string): Promise<void> {
	throw new Error("the board never initialises a repository; /init does");
}
```

Note: `addFile`, `addFiles`, `stageFileMove` and `resetPaths` are no-ops because `commitBoard` adds the whole board directory itself, and the create-rollback path calls `restoreIndexEntriesIfMatches`, which now answers `true` so a failed create still cleans its file.

- [ ] **Step 5: Stop forcing auto-commit off, and let Core read the config**

In `src/file-system/operations.ts` change `forceFilesystemOnly` to:

```ts
/**
 * Cross-branch task loading and remote operations are not carried, so every
 * config says so. Auto-commit is carried - the board commits its own writes -
 * and is whatever config.yml says, `false` when it says nothing.
 */
function forceFilesystemOnly(config: BacklogConfig): BacklogConfig {
	config.filesystemOnly = true;
	config.checkActiveBranches = false;
	config.remoteOperations = false;
	config.autoCommit = config.autoCommit === true;
	return config;
}
```

In `src/core/backlog.ts` replace `shouldAutoCommit`:

```ts
	/**
	 * The config's `auto_commit`, unless the caller overrode it. The git layer
	 * itself honours CLAUDECODE_AGENTS_BOARD_NO_COMMIT and an ignored .boards,
	 * so this only answers whether the config asked for commits at all.
	 */
	async shouldAutoCommit(overrideValue?: boolean): Promise<boolean> {
		if (typeof overrideValue === "boolean") return overrideValue;
		const config = await this.fs.loadConfig();
		return config?.autoCommit === true;
	}
```

Search `src/core/backlog.ts` for every `this.git.` call that was behind `shouldAutoCommit` and confirm none awaits a method that now throws: the only remaining throw is `initializeGitRepository`, which Core never calls.

- [ ] **Step 6: Run the tests**

Run: `cd claudecode-agents/board && bun test src/test/git-commit.test.ts && bunx tsc --noEmit`
Expected: 9 pass. If the "leaves the human's staged work out" case fails because `git commit -- .boards` refuses with "paths ... with -a does not make sense", the `-a` flag has crept in; it must not be there.

- [ ] **Step 7: Run the whole fleet-owned set plus the upstream suite once**

Run: `cd claudecode-agents/board && bun test --timeout=10000`
Expected: pass. Upstream tests create projects with `initializeFilesystemTestProject`, which writes `filesystemOnly: true` and no `auto_commit`, so they still make no commits. Any test asserting `autoCommit` is forced `false` after `auto_commit: true` in config needs its expectation flipped; there should be none, but if one appears, change the expectation and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git add claudecode-agents/board/src/git claudecode-agents/board/src/file-system/operations.ts claudecode-agents/board/src/core/backlog.ts claudecode-agents/board/src/test/git-commit.test.ts
git commit -m "board: the binary commits its own writes, pathspec-limited to .boards"
```

---

### Task 3: `--by` and commit notes on the CLI

**Files:**
- Modify: `claudecode-agents/board/src/cli.ts` (the `task create` and `task edit` commands, lines 81-180)
- Modify: `claudecode-agents/board/src/test/cli-board.test.ts`

**Interfaces:**
- Produces: `board task create <title> --by <name>` and `board task edit <id> --by <name>`; an edit with `-s <status>` commits with the canonical status as the note, with `--comment` as `comment`, otherwise `updated`.
- Consumes: `setCommitContext` from Task 2.

- [ ] **Step 1: Write the failing test**

Append to `src/test/cli-board.test.ts`, inside a new `describe`, after converting the fixture to a git repository. Replace the `beforeAll` with:

```ts
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "board-cli-"));
	mkdirSync(join(root, DEFAULT_DIRECTORIES.BACKLOG));
	writeFileSync(
		join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"),
		[
			'project_name: "test"',
			'task_prefix: "BD"',
			'statuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]',
			'default_status: "To Do"',
			'projects: ["fleet"]',
			"auto_commit: true",
			"",
		].join("\n"),
	);
	for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) {
		const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	}
});
```

and add at the end of the file:

```ts
function lastSubject(): string {
	return Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%s"], { stdout: "pipe" }).stdout.toString().trim();
}

describe("board task commits with --by", () => {
	it("a status move commits with the status and the writer", () => {
		const created = JSON.parse(board("task", "create", "Move me", "--project", "fleet", "--json").out);
		const id = created.task.id as string;
		expect(lastSubject()).toBe(`board: ${id} created`);
		const r = board("task", "edit", id, "-s", "doing", "--by", "SubagentStart");
		expect(r.code).toBe(0);
		expect(lastSubject()).toBe(`board: ${id} Doing (SubagentStart)`);
	});

	it("a comment commits as a comment", () => {
		const created = JSON.parse(board("task", "create", "Comment me", "--project", "fleet", "--json").out);
		const id = created.task.id as string;
		board("task", "edit", id, "--comment", "hello", "--comment-author", "@SubagentStop", "--by", "SubagentStop");
		expect(lastSubject()).toBe(`board: ${id} comment (SubagentStop)`);
	});

	it("a create with --by names the writer", () => {
		const created = JSON.parse(board("task", "create", "Filed", "--project", "fleet", "--by", "fleet-steward", "--json").out);
		expect(lastSubject()).toBe(`board: ${created.task.id} created (fleet-steward)`);
	});
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd claudecode-agents/board && bun test src/test/cli-board.test.ts`
Expected: FAIL - `unknown option '--by'`.

- [ ] **Step 3: Add `--by` and the notes**

In `src/cli.ts`, import `setCommitContext` from `./git/commit-context.ts`. On the `create` command add `.option("--by <name>", "who is making this write, for the commit subject")` and at the top of its action `if (o.by) setCommitContext({ by: o.by });`. On the `edit` command add the same option, and at the top of its action, after the `--comment needs --comment-author` check:

```ts
		if (o.by) setCommitContext({ by: o.by });
		if (o.status) setCommitContext({ note: await statusOrFail(c, o.status) });
		else if (o.comment?.length) setCommitContext({ note: "comment" });
```

`statusOrFail` already exists in the file and returns the canonical spelling, so `doing` commits as `Doing`. Place these lines before `buildTaskUpdateInput` is called so the context is set before Core writes.

- [ ] **Step 4: Run the CLI tests**

Run: `cd claudecode-agents/board && bun test src/test/cli-board.test.ts src/test/cli-board-behaviour.test.ts && bunx tsc --noEmit`
Expected: pass. `cli-board-behaviour.test.ts` builds its own fixture; if it fails on `no board here` because its root is not a repository, it still passes `CLAUDECODE_AGENTS_BOARD_ROOT`, which wins over discovery, so a failure there is a real regression to investigate rather than a fixture to patch.

- [ ] **Step 5: Commit**

```bash
git add claudecode-agents/board/src/cli.ts claudecode-agents/board/src/test/cli-board.test.ts
git commit -m "board cli: --by names the writer, and a status move or comment commits as one"
```

---

### Task 4: ids across every ref

**Files:**
- Create: `claudecode-agents/board/src/git/branch-ids.ts`
- Modify: `claudecode-agents/board/src/core/backlog.ts` (`getActiveAndCompletedTaskIds`)
- Create: `claudecode-agents/board/src/test/branch-ids.test.ts`

**Interfaces:**
- Produces: `listTaskIdsAcrossRefs(repoRoot: string, boardRelPath: string, prefix: string): string[]` - every task id found under `<boardRelPath>/tasks/` in any local or remote-tracking ref, read-only, no fetch.

- [ ] **Step 1: Write the failing test**

Create `src/test/branch-ids.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import { Core } from "../core/backlog.ts";
import { listTaskIdsAcrossRefs } from "../git/branch-ids.ts";

// Two contributors on two branches must not both mint BD-2. Before allocating,
// the highest id in every ref the clone knows about is consulted - read-only,
// no fetch. What the clone has not fetched it cannot know, and that is accepted.
let tmp = "";
let repo = "";

function git(...args: string[]) {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "branch-ids-"));
	repo = join(tmp, "repo");
	mkdirSync(join(repo, BOARD_DIR, "tasks"), { recursive: true });
	writeFileSync(
		join(repo, BOARD_DIR, "config.yml"),
		'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Done"]\ndefault_status: "To Do"\nauto_commit: true\n',
	);
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	await new Core(repo).createTaskFromInput({ title: "one" }); // BD-1 on main, committed
	git("switch", "-q", "-c", "other");
	await new Core(repo).createTaskFromInput({ title: "two" }); // BD-2 on other, committed
	git("switch", "-q", "main"); // BD-2's file is gone from the working tree
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("listTaskIdsAcrossRefs", () => {
	it("sees the id committed on another branch", () => {
		expect(listTaskIdsAcrossRefs(repo, BOARD_DIR, "BD")).toEqual(expect.arrayContaining(["BD-1", "BD-2"]));
	});

	it("returns nothing outside a repository", () => {
		expect(listTaskIdsAcrossRefs(tmp, BOARD_DIR, "BD")).toEqual([]);
	});
});

describe("generateNextId", () => {
	it("skips an id that only exists on another branch", async () => {
		const { task } = await new Core(repo).createTaskFromInput({ title: "three" });
		expect(task.id).toBe("BD-3");
	});
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd claudecode-agents/board && bun test src/test/branch-ids.test.ts`
Expected: FAIL - module not found; then, once it exists, `generateNextId` gives `BD-2`.

- [ ] **Step 3: Write the scan**

Create `src/git/branch-ids.ts`:

```ts
/**
 * Task ids in every ref the clone knows about, read-only. `git for-each-ref`
 * lists local and remote-tracking branches; `git ls-tree` lists the task files
 * in each without checking anything out. No fetch: what the clone has not seen
 * it cannot consult, and that is the accepted limit.
 */
export function listTaskIdsAcrossRefs(repoRoot: string, boardRelPath: string, prefix: string): string[] {
	const refs = Bun.spawnSync(["git", "-C", repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (refs.exitCode !== 0) return [];
	const idRe = new RegExp(`(?:^|/)(${prefix}-\\d+(?:\\.\\d+)*)(?:[ .-]|$)`, "i");
	const ids = new Set<string>();
	for (const ref of refs.stdout.toString().split("\n").filter(Boolean)) {
		const tree = Bun.spawnSync(["git", "-C", repoRoot, "ls-tree", "-r", "--name-only", ref, "--", `${boardRelPath}/tasks`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (tree.exitCode !== 0) continue;
		for (const path of tree.stdout.toString().split("\n")) {
			const m = idRe.exec(path);
			if (m?.[1]) ids.add(m[1].toUpperCase());
		}
	}
	return [...ids];
}
```

- [ ] **Step 4: Consult it when allocating**

In `src/core/backlog.ts`, import `listTaskIdsAcrossRefs` from `../git/branch-ids.ts` and `BOARD_DIR` from `../board-root.ts`. In `getActiveAndCompletedTaskIds`, after the worktree loop and before `return [...occupiedIds];`, add:

```ts
		// Ids committed on other branches - a contributor's, or this machine's own
		// unmerged work - occupy the namespace too. Read-only; see git/branch-ids.ts.
		const repoRoot = await this.git.getRepositoryRoot();
		if (repoRoot) {
			const boardRel = relative(repoRoot, this.fs.rootDir) ? `${relative(repoRoot, this.fs.rootDir)}/${BOARD_DIR}` : BOARD_DIR;
			for (const id of listTaskIdsAcrossRefs(repoRoot, boardRel, taskPrefix)) occupiedIds.add(id);
		}
```

`relative` is already imported in that file (it is used by `loadWorktreeTaskStateEntries`).

- [ ] **Step 5: Run the tests**

Run: `cd claudecode-agents/board && bun test src/test/branch-ids.test.ts src/test/git-commit.test.ts && bunx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add claudecode-agents/board/src/git/branch-ids.ts claudecode-agents/board/src/core/backlog.ts claudecode-agents/board/src/test/branch-ids.test.ts
git commit -m "board: an id is allocated above every id any ref already holds"
```

---

### Task 5: focus, on the CLI and as an MCP tool

**Files:**
- Create: `claudecode-agents/board/src/core/focus.ts`
- Modify: `claudecode-agents/board/src/cli.ts` (new `focus` command next to `serve`)
- Create: `claudecode-agents/board/src/mcp/tools/focus/index.ts`
- Modify: `claudecode-agents/board/src/mcp/server.ts` (`createMcpServer`: register, set `by: "mcp"`)
- Create: `claudecode-agents/board/src/test/focus.test.ts`, `claudecode-agents/board/src/test/mcp-focus.test.ts`

**Interfaces:**
- Produces: `readFocus(root: string): string | null`, `writeFocus(root: string, id: string): void`, `clearFocus(root: string): void`; the file is `<root>/.boards/.focus`, one line.
- Produces: CLI `board focus [id]` prints the canonical id it set; `board focus --show` prints the current id or nothing (exit 0 either way); `board focus --clear`.
- Produces: MCP tool `task_focus` with input `{ id?: string; clear?: boolean }`, returning `{ focused: string | null }` as JSON text.

- [ ] **Step 1: Write the failing tests**

Create `src/test/focus.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import { clearFocus, readFocus, writeFocus } from "../core/focus.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let root = "";

function board(...args: string[]) {
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		env: { ...process.env, CLAUDECODE_AGENTS_BOARD_ROOT: root, CLAUDECODE_AGENTS_BOARD_NO_COMMIT: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "focus-"));
	mkdirSync(join(root, BOARD_DIR, "tasks"), { recursive: true });
	writeFileSync(
		join(root, BOARD_DIR, "config.yml"),
		'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Done"]\ndefault_status: "To Do"\n',
	);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("focus file", () => {
	it("round-trips one id and clears", () => {
		expect(readFocus(root)).toBeNull();
		writeFocus(root, "BD-7");
		expect(readFileSync(join(root, BOARD_DIR, ".focus"), "utf8")).toBe("BD-7\n");
		expect(readFocus(root)).toBe("BD-7");
		clearFocus(root);
		expect(existsSync(join(root, BOARD_DIR, ".focus"))).toBe(false);
	});
});

describe("board focus", () => {
	it("refuses an id that is not on the board", () => {
		const r = board("focus", "BD-99");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("BD-99");
	});

	it("sets, shows and clears", () => {
		const id = JSON.parse(board("task", "create", "Focus me", "--json").out).task.id as string;
		expect(board("focus", id.toLowerCase()).out).toBe(id);
		expect(board("focus", "--show").out).toBe(id);
		expect(board("focus", "--clear").code).toBe(0);
		expect(board("focus", "--show").out).toBe("");
	});
});
```

Create `src/test/mcp-focus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFocus } from "../core/focus.ts";
import { McpServer } from "../mcp/server.ts";
import { registerFocusTools } from "../mcp/tools/focus/index.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const getText = (content: unknown[] | undefined): string => (content?.[0] as { text?: string } | undefined)?.text ?? "";

let TEST_DIR: string;
let server: McpServer;

async function call(name: string, args: Record<string, unknown> = {}) {
	return server.testInterface.callTool({ params: { name, arguments: args } });
}

describe("task_focus", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-focus");
		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureBacklogStructure();
		await initializeFilesystemTestProject(server, "Test Project");
		const config = await server.filesystem.loadConfig();
		if (!config) throw new Error("no config");
		registerTaskTools(server, config);
		registerFocusTools(server);
	});

	afterEach(async () => {
		await server.stop();
		await safeCleanup(TEST_DIR);
	});

	it("focuses an existing item and clears it", async () => {
		const created = await call("task_create", { title: "Focus me" });
		const id = /\b([A-Za-z]+-\d+)\b/.exec(getText(created.content))?.[1];
		expect(id).toBeDefined();
		const focused = JSON.parse(getText((await call("task_focus", { id: id?.toLowerCase() })).content));
		expect(focused.focused).toBe(id);
		expect(readFocus(TEST_DIR)).toBe(id);
		const cleared = JSON.parse(getText((await call("task_focus", { clear: true })).content));
		expect(cleared.focused).toBeNull();
		expect(readFocus(TEST_DIR)).toBeNull();
	});

	it("refuses an unknown id", async () => {
		const r = await call("task_focus", { id: "BD-99" });
		expect(r.isError).toBe(true);
	});
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd claudecode-agents/board && bun test src/test/focus.test.ts src/test/mcp-focus.test.ts`
Expected: FAIL - modules missing.

- [ ] **Step 3: Write the focus module**

Create `src/core/focus.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";

/**
 * The item this checkout's sessions are working on. One line at
 * `.boards/.focus`, ignored by git, written by `task_focus` or `board focus`
 * and read by the SubagentStart hook ahead of everything else. Per checkout,
 * not per session: that is a known limit, the same one the launch-time
 * variable had, and the `[board:<id>]` task marker still decides completion.
 */
export const FOCUS_FILE = ".focus";

function focusPath(root: string): string {
	return join(root, BOARD_DIR, FOCUS_FILE);
}

export function readFocus(root: string): string | null {
	const path = focusPath(root);
	if (!existsSync(path)) return null;
	const line = readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "";
	return line.length > 0 ? line : null;
}

export function writeFocus(root: string, id: string): void {
	mkdirSync(join(root, BOARD_DIR), { recursive: true });
	writeFileSync(focusPath(root), `${id}\n`);
}

export function clearFocus(root: string): void {
	rmSync(focusPath(root), { force: true });
}
```

- [ ] **Step 4: Add the CLI command**

In `src/cli.ts`, import `clearFocus, readFocus, writeFocus` from `./core/focus.ts`. After the `serve` command add:

```ts
program
	.command("focus [taskId]")
	.description("the item this checkout's sessions are on: set it, --show it, or --clear it")
	.option("--show", "print the current focus, or nothing")
	.option("--clear", "forget the focus")
	.action(async (taskId: string | undefined, o) => {
		const root = (() => {
			try {
				return resolveBoardRoot();
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		})();
		if (o.clear) {
			clearFocus(root);
			return;
		}
		if (o.show || !taskId) {
			const current = readFocus(root);
			if (current) console.log(current);
			return;
		}
		const c = new Core(root);
		const task = await c.getTask(taskId);
		if (!task) fail(`no task ${taskId} on this board; focus takes an id that exists`);
		writeFocus(root, task.id);
		console.log(task.id);
	});
```

- [ ] **Step 5: Add the MCP tool**

Create `src/mcp/tools/focus/index.ts`:

```ts
import { clearFocus, readFocus, writeFocus } from "../../../core/focus.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";

/**
 * Which item this checkout's sessions are on. The lead calls it when it starts
 * a phase; the SubagentStart hook reads the file it writes before anything
 * else. Replaces setting CLAUDECODE_AGENTS_BOARD_PAGE_ID at launch.
 */
export function registerFocusTools(server: McpServer): void {
	const schema = {
		type: "object",
		properties: {
			id: { type: "string", description: "The item to focus, any case. Omit with clear: true to forget the focus." },
			clear: { type: "boolean", description: "Forget the current focus." },
		},
		additionalProperties: false,
	};

	const focusTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_focus",
			description:
				"Set the board item this checkout's sessions are working on, so the hooks move that item as agents start and stop. Call it when you start a phase against an item. Pass clear: true to forget it. Returns {focused: id | null}.",
			inputSchema: schema,
			annotations: { title: "Focus an item", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		schema,
		async (input) => {
			const root = server.filesystem.rootDir;
			const args = input as { id?: string; clear?: boolean };
			if (args.clear) {
				clearFocus(root);
				return { content: [{ type: "text", text: JSON.stringify({ focused: null }) }] };
			}
			if (!args.id) {
				return { content: [{ type: "text", text: JSON.stringify({ focused: readFocus(root) }) }] };
			}
			const task = await server.getTask(args.id);
			if (!task) {
				return { content: [{ type: "text", text: `no task ${args.id} on this board` }], isError: true };
			}
			writeFocus(root, task.id);
			return { content: [{ type: "text", text: JSON.stringify({ focused: task.id }) }] };
		},
	);

	server.addTool(focusTool);
}
```

In `src/mcp/server.ts`: import `registerFocusTools` from `./tools/focus/index.ts` and `setCommitContext` from `../git/commit-context.ts`; in `createMcpServer` add `registerFocusTools(server);` after `registerServeTools(server);` and `setCommitContext({ by: "mcp" });` before the registrations. Change `INSTRUCTIONS` to: `"This is the repository's board, under .boards/ in the main checkout. Read items with task_view, task_list and task_search; add a comment with task_edit; say which item a phase is on with task_focus; never move an item's status, the fleet's hooks own that."`

- [ ] **Step 6: Run the tests**

Run: `cd claudecode-agents/board && bun test src/test/focus.test.ts src/test/mcp-focus.test.ts src/test/mcp-serve.test.ts && bunx tsc --noEmit`
Expected: pass. If `server.getTask` is not a Core method under that name, use whatever `TaskHandlers.viewTask` uses to load a task by id (`this.core.getTask(id)` at `handlers.ts:468-480`) and match it.

- [ ] **Step 7: Add the new test files to the check suite and commit**

In `evals/lib/check-all.sh`, extend `BOARD_TESTS` with `src/test/board-root-git.test.ts`, `src/test/git-commit.test.ts`, `src/test/branch-ids.test.ts`, `src/test/focus.test.ts`, `src/test/mcp-focus.test.ts`.

```bash
git add claudecode-agents/board/src/core/focus.ts claudecode-agents/board/src/cli.ts claudecode-agents/board/src/mcp evals/lib/check-all.sh claudecode-agents/board/src/test/focus.test.ts claudecode-agents/board/src/test/mcp-focus.test.ts
git commit -m "board: task_focus and board focus say which item a checkout's sessions are on"
```

---

## Phase 2: the hooks

### Task 6: the hooks run the binary where the hook runs, and read the focus

**Files:**
- Modify: `claudecode-agents/hooks/lib/board.sh:270-300` (root export, `board_cli`), `:350-370` (`board_set_status`, `board_comment_raw`)
- Modify: `claudecode-agents/hooks/board-subagent-start.sh:24-70`
- Modify: `claudecode-agents/hooks/board-subagent-stop.sh` (read `.cwd`, export it)
- Modify: `claudecode-agents/hooks/board-task-completed.sh:47-63` (export the cwd it already reads)
- Modify: `evals/lib/board-hook-contract.sh` (the live case)
- Modify: `claudecode-agents/hooks/README.md` ("Which board item", "The fallbacks, in order", "Security" root paragraph, "Failure behaviour")

**Interfaces:**
- Consumes: `board focus --show`, `--by <hook>`, and `no board here` from the binary.
- Produces: `BOARD_CWD` - exported by each hook from the input's `cwd`; `board_cli` runs the binary with that as its working directory when set.
- Produces: `board_focus_id HOOK` - prints the focused id or nothing.

- [ ] **Step 1: Write the failing contract cases**

In `evals/lib/board-hook-contract.sh`, replace the live block from `LIVE="$TMP/live"; mkdir -p "$LIVE/board"` through the `live-comment` check with:

```bash
    # The board is the main checkout's .boards. The hooks are run with a cwd in
    # a linked worktree, and every move has to land in the main checkout - as a
    # file, and as a commit whose subject names the hook - while the worktree's
    # own copy of the board stays exactly as it was.
    LIVE="$TMP/live"; WTLIVE="$TMP/live-wt"
    mkdir -p "$LIVE/.boards/tasks"
    printf 'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\ndefault_status: "To Do"\nauto_commit: true\n' > "$LIVE/.boards/config.yml"
    git -C "$LIVE" init -q -b main
    git -C "$LIVE" config user.email t@t
    git -C "$LIVE" config user.name t
    git -C "$LIVE" add -A && git -C "$LIVE" commit -qm base
    git -C "$LIVE" worktree add -q "$WTLIVE" -b agent-live
    unset CLAUDECODE_AGENTS_BOARD_ROOT
    export CLAUDECODE_AGENTS_BOARD=on
    unset BOARD_DRY_RUN
    ID="$(cd "$LIVE" && "$SHIM" task create "Live item" --json | jq -r .task.id)"
    [ "$(git -C "$LIVE" log -1 --format=%s)" = "board: $ID created" ]; check live-create-commits "a create commits with the id in the subject" $?

    # Focus is the binding now. Written in the main checkout, read by the hook
    # run from the worktree: no environment variable anywhere.
    (cd "$LIVE" && "$SHIM" focus "$ID" >/dev/null)
    run_hook board-subagent-start.sh \
        "$(jq -nc --arg t "claudecode-agents:coder" --arg c "$WTLIVE" \
            '{session_id:"live",agent_id:"a1",agent_type:$t,cwd:$c}')"
    [ "$(cd "$LIVE" && "$SHIM" task view "$ID" --json | jq -r .task.status)" = "Doing" ]; check live-start-doing "SubagentStart, run from a worktree, moves the main checkout's item to Doing via the focus" $?
    [ "$(git -C "$LIVE" log -1 --format=%s)" = "board: $ID Doing (SubagentStart)" ]; check live-start-commits "the move is committed in the main checkout, naming the hook" $?
    [ -z "$(git -C "$WTLIVE" status --porcelain)" ]; check live-worktree-untouched "the worktree's copy of the board is untouched" $?
    log_has "from the focus file"; check live-focus-source "the log says the binding came from the focus file" $?

    run_hook board-subagent-stop.sh \
        "$(jq -nc --arg c "$WTLIVE" '{session_id:"live",agent_id:"a1",agent_type:"claudecode-agents:coder",cwd:$c,
                    stop_hook_active:false,agent_transcript_path:"/dev/null",
                    last_assistant_message:"## Done\n- Moved a live item through the binary\n\n## Not done\n- None\n\n## Unverified\n- None\n\n## Decisions needed\n- Blocker: which key?\n"}')"
    [ "$(cd "$LIVE" && "$SHIM" task view "$ID" --json | jq -r .task.status)" = "Blocked by human" ]; check live-blocker "a Blocker: line moves the item to Blocked by human" $?
    (cd "$LIVE" && "$SHIM" task view "$ID" --json) \
        | jq -e '.task.comments[] | select(.author == "@SubagentStop") | select(.body | test("which key"))' >/dev/null
    check live-comment "the blocker text lands as an authored comment" $?
    git -C "$LIVE" log --format=%s | grep -q "board: $ID comment (SubagentStop)"; check live-comment-commits "the comment is its own commit" $?

    # Two switches. NO_COMMIT writes the file and nothing else; a cwd outside
    # any repository has no board, and the hook says so and exits 0.
    ID2="$(cd "$LIVE" && CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1 "$SHIM" task create "Uncommitted" --json | jq -r .task.id)"
    git -C "$LIVE" status --porcelain | grep -q "$ID2"; check live-no-commit "CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1 leaves the write uncommitted" $?
    git -C "$LIVE" add -A && git -C "$LIVE" commit -qm tidy
    NOWHERE="$TMP/nowhere"; mkdir -p "$NOWHERE"
    run_hook board-subagent-start.sh \
        "$(jq -nc --arg c "$NOWHERE" '{session_id:"live2",agent_id:"a2",agent_type:"claudecode-agents:coder",cwd:$c}')"
    [ "$RC" -eq 0 ] && log_has "no board here"; check live-no-board "a cwd outside a repository logs 'no board here' and exits 0" $?
```

Also delete the earlier `export CLAUDECODE_AGENTS_BOARD_ROOT="$LIVE"` and the `export CLAUDECODE_AGENTS_BOARD_PAGE_ID` / `unset` pair, which the new block no longer uses. Keep `export CLAUDECODE_AGENTS_BOARD=off` at the end.

- [ ] **Step 2: Run to see the new cases fail**

Run: `bash evals/lib/board-hook-contract.sh 2>&1 | grep -E 'FAIL|passed'`
Expected: `live-start-doing`, `live-start-commits`, `live-focus-source`, `live-no-board` fail; the hooks still export a `~/.memory` root and know nothing about focus or cwd.

- [ ] **Step 3: The library**

In `hooks/lib/board.sh`:

Replace the root comment block (lines 270-278, "The board is the plugin's own binary ... Only an explicit value moves the root.") with:

```bash
# The board is the plugin's own binary, reached through one shim, and the
# binary finds the board itself: the main checkout's .boards/ of the repository
# containing its working directory, never a linked worktree's copy (see
# docs/2026-09-18-project-boards.md section 3). So the one thing this library
# owes it is the right working directory - BOARD_CWD, the cwd each hook reads
# from its input - and an inherited CLAUDECODE_AGENTS_BOARD_ROOT is left alone
# for the contract suite and the rare deliberate override. There is no default
# root and no fallback board: outside a repository the binary says "no board
# here", the hook logs it, and nothing moves.
```

Delete the line `export CLAUDECODE_AGENTS_BOARD_ROOT="${CLAUDECODE_AGENTS_BOARD_ROOT:-$HOME/.memory}"`. Add after `BOARD_CLI_TIMEOUT=...`:

```bash
BOARD_CWD="${BOARD_CWD:-}"
```

In `board_cli`, wrap the three invocations so they run in `BOARD_CWD` when it is set. Replace the `rc=0` ... `fi` block with:

```bash
  rc=0
  (
    if [ -n "$BOARD_CWD" ]; then cd "$BOARD_CWD" 2>/dev/null || exit 96; fi
    if command -v timeout >/dev/null 2>&1; then
      exec timeout "$BOARD_CLI_TIMEOUT" "$BOARD_SHIM" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then
      exec gtimeout "$BOARD_CLI_TIMEOUT" "$BOARD_SHIM" "$@"
    else
      exec "$BOARD_SHIM" "$@"
    fi
  ) 2>"$err" || rc=$?
  if [ "$rc" -eq 96 ]; then
    board_log "$hook" "board $what: cwd $BOARD_CWD does not exist"
  elif [ "$rc" -ne 0 ]; then
    if grep -q 'no board here' "$err"; then
      board_log "$hook" "no board here: $(head -c 200 "$err" | tr '\n' ' ')"
    else
      board_log "$hook" "board $what failed (exit $rc): $(head -c 300 "$err" | tr '\n' ' ')"
    fi
  fi
```

Add after `board_resolve`:

```bash
# board_focus_id HOOK -> prints the focused item id, or nothing
# The focus file is the binding now: written by task_focus or `board focus`,
# per checkout, read here ahead of the session state and the environment.
board_focus_id() {
  local hook="$1" out
  out="$(board_cli "$hook" focus --show)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}
```

In `board_set_status` change the call to `board_cli "$hook" task edit "$id" -s "$col" --by "$hook" >/dev/null || return 1`. In `board_comment_raw` change it to `board_cli "$hook" task edit "$id" --comment "$text" --comment-author "@$hook" --by "$hook" >/dev/null || return 1`.

- [ ] **Step 4: SubagentStart**

In `hooks/board-subagent-start.sh`, after `agent_type=...` add:

```bash
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
export BOARD_CWD="$cwd"
```

Replace the comment block that begins `# There is no spawn prompt on this event.` through the line `instructions="$(...)"` with:

```bash
# There is no spawn prompt on this event - the SubagentStart schema is the
# common fields plus agent_id and agent_type - so the binding comes from the
# checkout, not the spawn. In order: the focus file the lead wrote with
# task_focus (or the human with /work), then the item this session most
# recently picked up, then the launch-time environment variable, kept last so
# a stale one in a shell never overrides a focus. `instructions` is still read
# first so that a runtime which starts sending one works without another
# change here.
instructions="$(printf '%s' "$input" | jq -r '.instructions // .prompt // .initial_prompt // ""')"
```

Replace the block from `if [ -z "$page_id" ] && [ -n "${CLAUDECODE_AGENTS_BOARD_PAGE_ID:-}" ]; then` through its `fi` with:

```bash
if [ -z "$page_id" ] && page_id="$(board_focus_id "$HOOK")"; then
  source_of_id="focus file"
else
  page_id=""
fi

if [ -z "$page_id" ] && page_id="$(state_session_page_id "$session_id")"; then
  source_of_id="session's last item"
else
  [ -n "$page_id" ] || page_id=""
fi

if [ -z "$page_id" ] && [ -n "${CLAUDECODE_AGENTS_BOARD_PAGE_ID:-}" ]; then
  if page_id="$(normalise_page_id "$CLAUDECODE_AGENTS_BOARD_PAGE_ID")"; then
    source_of_id="CLAUDECODE_AGENTS_BOARD_PAGE_ID"
  else
    board_log "$HOOK" "CLAUDECODE_AGENTS_BOARD_PAGE_ID is set but is not a board item id or task file path"
    page_id=""
  fi
fi
```

Careful with the first two blocks: `if [ -z "$page_id" ] && page_id="$(...)"` leaves `page_id` set from the `instructions` branch when that branch found one, because the `-z` test fails before the assignment runs; the `else` clauses then must not clear it. Write them exactly as:

```bash
if [ -z "$page_id" ]; then
  if page_id="$(board_focus_id "$HOOK")"; then source_of_id="focus file"; else page_id=""; fi
fi
if [ -z "$page_id" ]; then
  if page_id="$(state_session_page_id "$session_id")"; then source_of_id="session's last item"; else page_id=""; fi
fi
```

and use these in place of the two `if ... else` pairs above. Change the unbound log line to: `board_log "$HOOK" "no board item for ${agent_type:-unknown agent} (${agent_id:-no id}): nothing is focused in this checkout. Call task_focus <id> (or run /work <id>) before spawning against an item. Nothing moved. See hooks/README.md."`

- [ ] **Step 5: SubagentStop and TaskCompleted**

In `hooks/board-subagent-stop.sh`, next to where `session_id` and `agent_id` are read from `$input`, add:

```bash
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
export BOARD_CWD="$cwd"
```

In `hooks/board-task-completed.sh`, after line 47 (`cwd="$(...)"`), add `export BOARD_CWD="$cwd"`.

- [ ] **Step 6: Run the contract suite**

Run: `bash evals/lib/board-hook-contract.sh 2>&1 | grep -E 'FAIL|passed'`
Expected: all pass, including every pre-existing case. The unit cases that never reach the binary are unaffected by the root change because `CLAUDECODE_AGENTS_BOARD=off` short-circuits before `board_cli`.

- [ ] **Step 7: The hooks README**

In `hooks/README.md`:

- Under "Which board item", replace "The convention" subsection (the struck-through paragraph and the `CLAUDECODE_AGENTS_BOARD_PAGE_ID=BD-12 \ claude ...` block and the two paragraphs after it) with:

```markdown
### The convention

**A checkout is focused on one item**, and the hooks read that focus. The lead sets it when it starts a phase, with the board server's `task_focus` tool; the human sets it by hand with `/work BD-12`. Either writes one line to `.boards/.focus` in the main checkout, which the shipped `.boards/.gitignore` keeps out of git. `SubagentStart` reads it first, ahead of the session's own state and the launch-time variable, so a focus set mid-session takes over from whatever the previous spawn was on.

Per checkout, not per session: two sessions in one checkout working two items would need `[board:<id>]` on their completion tasks, as before. `CLAUDECODE_AGENTS_BOARD_PAGE_ID` still works and is read last; it is for a scripted launch, and nothing in the fleet asks anyone to set it.
```

- Under "The fallbacks, in order", replace the `SubagentStart` list with:

```markdown
1. `Board-Item:` in the spawn prompt. **Unreachable** - the event carries no spawn prompt. Kept so that a runtime which starts sending one works without another change here.
2. `.boards/.focus` in the main checkout, via `board focus --show`.
3. The item this session most recently picked up (`sessions/<session_id>/last-item`).
4. `CLAUDECODE_AGENTS_BOARD_PAGE_ID` in the environment.
5. Nothing. No column moves, and the log says to call `task_focus`.
```

- Under "Security", replace the board-root bullet (the one beginning "The board root is honoured from the environment when it is set") with: `- The board is the main checkout's `.boards/` of the repository containing the hook's `cwd`, resolved by the binary through `git rev-parse --git-common-dir`, so a hook fired inside a coder's worktree writes to the main checkout and never to the worktree's committed copy. `CLAUDECODE_AGENTS_BOARD_ROOT` is honoured when set - the contract suite depends on that - and is as trusted as anything else the launching environment hands a hook. There is no default root: outside a repository the binary says `no board here` and the hook logs it and exits 0.`

- Under "Failure behaviour", add a paragraph: `A board write is also a commit, made by the binary in the main checkout, pathspec-limited to `.boards`, on whatever branch is checked out there, never pushed. A commit that cannot be made - a locked index after three retries, a checkout mid-rebase, an ignored `.boards`, `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` - leaves the file write standing and is logged by the binary to stderr, which `board_cli` captures into `hooks.log`. Look there for `commit skipped` when a card moved but `git log -- .boards` shows nothing.`

- Everywhere else in the file that says `board/tasks/` or "the memory tree", change to `.boards/tasks/` and "the repository". `grep -n 'memory tree\|board/tasks' claudecode-agents/hooks/README.md` must return nothing when done.

- [ ] **Step 8: Commit**

```bash
git add claudecode-agents/hooks evals/lib/board-hook-contract.sh
git commit -m "hooks: the binary finds the board from the hook's cwd, the focus file binds the item, every move commits"
```

---

## Phase 3: commands, agents, docs

### Task 7: the templates, the installer, and the three commands

**Files:**
- Create: `claudecode-agents/templates/board.config.yml`, `claudecode-agents/templates/board.gitignore`
- Delete: `home/board.config.yml`
- Modify: `scripts/install-home.sh:11-16` (header), `:405-410` (the exclusion comment), `:515-570` (`install_board`), `:613` (the `install_tree` exclusion)
- Modify: `claudecode-agents/commands/init.md` (new step between 2 and 3), `claudecode-agents/commands/kickoff.md:21-43`
- Create: `claudecode-agents/commands/work.md`

**Interfaces:**
- Produces: `templates/board.config.yml` with `auto_commit: true` and no `projects`, `default_port` or `project_name` placeholder the human has to edit.

- [ ] **Step 1: The templates**

Create `claudecode-agents/templates/board.config.yml`:

```yaml
# This repository's board. Created by /init; edit by hand and commit like any
# other project file. The hooks match statuses ignoring case.
project_name: "board"
task_prefix: "BD"
statuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]
default_status: "To Do"
labels: ["outcome/shipped", "outcome/abandoned", "outcome/superseded"]
priorities: ["High", "Medium", "Low"]
# The binary commits every write it makes, pathspec-limited to .boards, on the
# checked-out branch, never pushed. Set false to batch commits yourself, or
# export CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1 for one shell.
auto_commit: true
```

Create `claudecode-agents/templates/board.gitignore`:

```
# The focus file is this checkout's, not the repository's.
.focus
```

Delete `home/board.config.yml` with `git rm home/board.config.yml`.

- [ ] **Step 2: The installer**

In `scripts/install-home.sh`, replace the header lines 12-15 with:

```
#   3. Build the board binary into ~/.local/bin/board. The board itself lives
#      in each repository at .boards/ (created by /init) and is nothing the
#      installer touches.
```

Delete the comment at lines 407-408 about `board.config.yml` and remove `"board.config.yml"` from the `install_tree` call at line 613. Replace `install_board` with:

```bash
install_board() {
    local pkg="$REPO_ROOT/claudecode-agents/board"
    local log
    say ""
    say "Board binary"

    if ! command -v bun >/dev/null 2>&1; then
        warn "bun is not installed; the board binary cannot be built."
        warn "  curl -fsSL https://bun.sh/install | bash   then re-run."
    elif [ "$DRY_RUN" -eq 1 ]; then
        info "would build    ~/.local/bin/board"
    else
        # The build is quiet while it succeeds and loud when it does not: its
        # output is the only diagnosis there is, and a silent failure here leaves
        # board.sh falling back to bun or exiting 127 with nobody the wiser.
        mkdir -p "$HOME/.local/bin"
        log=$(mktemp "${TMPDIR:-/tmp}/fleet-board-build.XXXXXX") || die 'cannot create a temporary file for the board build log'
        if "$pkg/build.sh" "$HOME/.local/bin/board" >"$log" 2>&1; then
            info "built          ~/.local/bin/board"
        else
            sed 's/^/    /' "$log" >&2
            warn "the board binary could not be built; see the build output above"
            N_BOARD_FAILED=$((N_BOARD_FAILED + 1))
        fi
        rm -f "$log"
    fi
}
```

Run `bash -n scripts/install-home.sh && bash scripts/install-home.sh --dry-run 2>&1 | tail -5` and confirm the dry run prints `would build ~/.local/bin/board` and nothing about a memory tree.

- [ ] **Step 3: `/init` gains a board step**

In `claudecode-agents/commands/init.md`, after section "## 2. Skeleton" and before "## 3. Guided fill", insert:

```markdown
## 2b. Board

The board is this repository's, at `.boards/`, committed like any other project file, and the fleet's hooks and the board MCP server find it from the working directory through git. Create it here so the first `/kickoff` has one to check.

- If `.boards/config.yml` exists, say so and skip the rest of this step.
- Otherwise copy `${CLAUDE_PLUGIN_ROOT}/templates/board.config.yml` to `.boards/config.yml` and `${CLAUDE_PLUGIN_ROOT}/templates/board.gitignore` to `.boards/.gitignore`, and create `.boards/tasks/`, `.boards/docs/` and `.boards/milestones/`, each holding a `.gitkeep` so an empty directory survives a clone.
- Set `project_name` in the copied config to the repository's directory name. Then offer the prefix with AskUserQuestion: `BD` (recommended) or a short upper-case one derived from the repository name, two to four letters. Write the answer as `task_prefix`.
- Say that every write the binary makes will be committed on the checked-out branch, and that `auto_commit: false` in the config or `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` in a shell turns that off.

Renumber nothing: step 3 below stays step 3. Add `.boards/` to the reminder in step 4's report, alongside `.claude/settings.json`, as something to commit.
```

- [ ] **Step 4: `/kickoff`'s board step**

Replace the whole "## Board" section (from `## Board` to the line before `## The idea`) in `claudecode-agents/commands/kickoff.md` with:

```markdown
## Board

Run this step only when `${CLAUDE_PLUGIN_ROOT}/board/board.sh --version` succeeds. On a machine where the binary has never been built it will not, and that is a legitimate outcome: say so and move on. Read the `board` skill first; it is the contract this step is verifying. No board is a legitimate outcome throughout - most work is not board work, and the human declining any part of this is a note in the report, never a failure.

**Check.** The board is this repository's, at `.boards/` in the main checkout, so everything here is a file read:

- `.boards/config.yml` exists. If it does not, say that `/init` creates it and stop the step; do not write it yourself.
- Its `statuses` are the five the fleet uses, spelled `To Do`, `Doing`, `Blocked`, `Blocked by human`, `Done`. The hooks match them ignoring case, so a difference in case is not a failure; a different word is, and the fix is the config rather than a `BOARD_COL_*` override in `~/.config/claudecode-agents/board.env` - the override leaves every other reader seeing the odd name.
- Its `labels` carry `outcome/shipped`, `outcome/abandoned` and `outcome/superseded`.
- `.boards/.gitignore` ignores `.focus`. Without it, a focus lands in a commit and follows the branch around.
- `git check-ignore -q .boards` fails, or say that the board is gitignored here and so is per checkout and dies with the clone - allowed, and worth saying once.

**Setup.** Say what is missing and ask the human before changing anything. On a yes: add the missing `outcome/*` labels to `labels`, add the `.gitignore`, and leave the change for the binary's next commit or commit it yourself with `git add .boards && git commit -m "board: config"`. The `statuses` list is not yours to repair here - renaming a status under live items is not a kickoff-sized change.

**State the conventions.** End the board section by saying, concretely, what the fleet will use - so the session and the human agree before the first item is filed:

- that the board is `.boards/` in this repository and the items are the files under `.boards/tasks/`,
- the prefix from the config, so an item is `BD-12` and a sub-item `BD-12.1`,
- the five status names as the config spells them,
- labels: `outcome/shipped`, `outcome/abandoned` and `outcome/superseded` on an item at close, nothing else load-bearing,
- that every write the binary makes is a commit on the checked-out branch, `board: BD-12 Doing (SubagentStart)`, never pushed,
- and the binding: call `task_focus BD-12` (or the human runs `/work BD-12`) before spawning against an item, and only a task subject carrying `[board:BD-12]` closes one.

**What this step cannot do, said out loud.** It can see the shim answer, but not whether the binary that shim found is the one this plugin version expects. The binary is built into `~/.local/bin/board` by `scripts/install-home.sh` and never committed, so a plugin update reaches a machine long before a rebuild does. End with the one manual check: `~/.local/bin/board --version` against the `version` in `${CLAUDE_PLUGIN_ROOT}/board/package.json`. If they differ, re-run the installer. A `board shim missing at ...` line, a `no board here` line, or a `board <cmd> failed (exit N): ...` line in `~/.local/state/claudecode-agents/log/hooks.log` after the first real spawn is the symptom of a board the hooks cannot reach.
```

Also change kickoff's step 6 (line 17) if it says "memory tree" anywhere; it should only mention the binary answering.

- [ ] **Step 5: `/work`**

Create `claudecode-agents/commands/work.md`:

```markdown
---
description: Focus this checkout on one board item, so the hooks move that item as agents start and stop - the human's hand on what task_focus does for the lead
---

Focus this checkout on the board item given as the argument. The argument is an item id in any case (`bd-12`, `BD-12.3`), or nothing to show the current focus, or `clear` to forget it.

## Procedure

1. With an id: call the board MCP server's `task_focus` tool (`mcp__plugin_claudecode-agents_board__task_focus`) with `{id}`. It resolves the id, writes `.boards/.focus` in the main checkout, and returns `{focused}`. Print the canonical id and the item's title from `task_view`, in one line.
2. With `clear`: call `task_focus` with `{clear: true}` and say the focus is cleared.
3. With nothing: call `task_focus` with `{}` and print the focused id, or say that nothing is focused.
4. If the tool refuses the id, say the item is not on this board and stop; do not create one.
5. If the tool is not available, the board MCP server is not loaded in this session - the plugin is not enabled here, or the `board` binary is not built. Say which by checking whether `${CLAUDE_PLUGIN_ROOT}/board/board.sh --help` runs, and stop.

Never move the item's status. Focusing says which item the hooks move; the hooks do the moving.
```

- [ ] **Step 6: Verify and commit**

Run: `bash evals/lib/check-all.sh 2>&1 | grep -E '^[a-z-]+: (ok|FAILED)'`
Expected: every step `ok` except `board` under the sandbox (see Global Constraints).

```bash
git add claudecode-agents/templates claudecode-agents/commands scripts/install-home.sh
git rm -q home/board.config.yml
git commit -m "commands: /init creates the board, /kickoff checks it here, /work focuses an item; the installer stops touching the memory tree"
```

---

### Task 8: the lead, the skill, the glossary, the plan, the changelog, the release

**Files:**
- Modify: `claudecode-agents/agents/lead.md:28,30`
- Modify: `claudecode-agents/skills/board/SKILL.md` (opening, "The five columns" paragraph after the table, "Telling the hooks which item", "The CLI", plus a new "Git" section)
- Modify: `claudecode-agents/skills/glossary/SKILL.md` (Project and Board rows), then regenerate `claudecode-agents/templates/rules/glossary.md` with `scripts/gen-glossary-rule.sh`
- Modify: `docs/fleet-plan.md` (a third dated note under "Changelog since v0.3", section 7's first two paragraphs, section 12's client-material paragraph)
- Modify: `docs/2026-09-17-backlog-board.md:3` (a superseded note at the top)
- Modify: `claudecode-agents/board/NOTICE.md` (the git-layer bullet)
- Modify: `claudecode-agents/CHANGELOG.md`, `claudecode-agents/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] **Step 1: The lead**

In `claudecode-agents/agents/lead.md` step 2, after `coder` for a plan phase`, no change. In step 3, append to the end of the step: ` When the phase is against a board item, call `task_focus <id>` before the first spawn, so the hooks move that item; nothing is set at launch any more.` Keep the body under 60 lines and its four sections; check with `wc -l` and `grep -c '^## '`.

- [ ] **Step 2: The board skill**

In `claudecode-agents/skills/board/SKILL.md`:

- Opening paragraph: replace `The board is a directory of markdown files, one per item, at `board/tasks/` under the memory tree, and the board is those files grouped by status. It is written through the plugin's own `board` binary and never by hand; the memory sync agent carries it between machines.` with `The board is this repository's: a directory of markdown files, one per item, at `.boards/tasks/` in the main checkout, committed like any other project file, and the board is those files grouped by status. It is written through the plugin's own `board` binary and never by hand, and the binary commits every write it makes. There is no global board; each repository has its own.`
- "**Projects**" paragraph: replace with `**Projects** - a project is the repository. The `project` field on an item is optional and exists for a monorepo that wants to say which part; there is no list to be on.`
- "**Issues**" paragraph: replace `One tree holds everything, because a board you have to mentally join to another board is not one place to look.` with `One repository, one board: what you see is this project's state and nothing else's.`
- "The five columns" paragraph after the table: replace `The columns are the `statuses` list in `board/config.yml`` with `The columns are the `statuses` list in `.boards/config.yml``.
- "Telling the hooks which item": replace the "**The binding is the session, set at launch.**" paragraph and its `sh` block with:

```markdown
**The binding is the checkout's focus.** `SubagentStart` receives the agent's identity and nothing else - no spawn prompt under any name - so a line in the prompt cannot reach it. What it reads is `.boards/.focus` in the main checkout, one line, written by the `task_focus` tool or the human's `/work` command:

```
task_focus BD-12
```

Call it when you start a phase against an item, before the first spawn. Every spawn in that checkout then belongs to that item until the focus changes. Work on an unrelated item focuses that item first, and an unfocused checkout moves nothing - which is correct, because most spawns are not board work. `CLAUDECODE_AGENTS_BOARD_PAGE_ID` at launch still works and is read last; nothing asks anyone to set it.
```

- In the same section, replace `The `CLAUDECODE_AGENTS_BOARD_PAGE_ID=BD-12 \ claude --agent claudecode-agents:lead` example` if any remains, and the sentence `**What happens when it is absent.** `SubagentStart` logs that no board item was resolved` stays, but its list of fallbacks becomes `then to the session's last item, then to nothing`.
- "The CLI" section: replace `against the root in `CLAUDECODE_AGENTS_BOARD_ROOT` (default `$HOME/.memory`)` with `against the main checkout of the repository containing the working directory (`CLAUDECODE_AGENTS_BOARD_ROOT` overrides that when set)`. Add rows to the table: `| `board focus [id]` | `--show`, `--clear` - this checkout's focused item |` and add `--by <name>` to the `task create` and `task edit` rows' flag lists. Replace the sentence `There is no `--cwd` and no walk up from the working directory: the root comes from the environment variable alone.` with `There is no `--cwd`: the board is found from the working directory through git, to the main checkout, never to a linked worktree's copy.`
- Add a section before "The CLI":

```markdown
## Git

Every write the binary makes is a commit: `git add -- .boards` then `git commit -- .boards` in the main checkout, on whatever branch is checked out there, with a one-line subject such as `board: BD-12 Doing (SubagentStart)` or `board: BD-12 created (fleet-steward)`. The pathspec keeps the human's own staged work out. Nothing pushes; the human's next push carries it. A commit that cannot be made - a locked index after three retries, a checkout mid-rebase, an ignored `.boards` - leaves the file write standing and logs `commit skipped`. `auto_commit: false` in the config or `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1` in a shell turns commits off.

A hook fired inside a coder's worktree resolves to the main checkout, so a feature branch never carries a board change unless a person put one there. Ids are allocated above the highest id in every branch the clone knows, so two contributors do not mint the same one; a clone that has not fetched cannot know, and that is the limit.

`git log -- .boards/tasks/BD-12*` is the history of an item: who moved it and when, which a comment trail can forget and a commit cannot.
```

- [ ] **Step 3: The glossary**

In `claudecode-agents/skills/glossary/SKILL.md` change the `Project` row's third column to `the repository; the optional `project` field on an item names a part of a monorepo` and the `Board` row's third column to `the task files under `.boards/` in the repository, grouped by status; `board export` or the web UI`. Run `scripts/gen-glossary-rule.sh` (no `--check`) to regenerate `templates/rules/glossary.md`, then `scripts/gen-glossary-rule.sh --check` to confirm.

- [ ] **Step 4: The fleet plan and the earlier spec**

In `docs/fleet-plan.md`, under "## Changelog since v0.3", after the 18 September paragraph, add:

```markdown
18 September 2026, later the same day: the board is per repository, at `.boards/` in the main checkout, committed by the binary after every write, per `docs/2026-09-18-project-boards.md`. "One place to look" is reversed on purpose: other people will use this, and a board in one person's memory tree is not something a second contributor can clone. Section 7 reads accordingly. What it still decides is unchanged - the five columns, the hooks owning every move, blocked by human as the queue - except that the queue is now per repository, and a view across repositories is future work rather than a column.
```

In section 7, replace the first paragraph's opening `Two layers only. The board - one markdown file per item under `board/` in the memory tree, written only through the plugin's own `board` binary - is the human-facing backlog and the visible view;` with `Two layers only. The board - one markdown file per item under `.boards/` in the repository, written only through the plugin's own `board` binary, which commits every write - is the human-facing backlog and the visible view;`. Replace the second paragraph's `The structure is one config and one file per item. `board/config.yml` carries the `projects` list, one entry per bounded body of work, and the `statuses` list that the columns are. `board/tasks/` carries` with `The structure is one config and one file per item. `.boards/config.yml` carries the `statuses` list that the columns are; a project is the repository. `.boards/tasks/` carries`, and `One tree, everything in it: home lab, the fleet itself, rzem.guru, Deloitte and client work, personal admin. The point of one queue is that you look in one place, and a board you have to mentally join to another board is not one place.` with `One repository, one board: the queue you look at is this project's, and a view across repositories is a later piece of work.` Replace `Note that hooks can't call MCP tools - they run as shell on the host - so the status writes go through the `board` binary, reached by the shim at `${CLAUDE_PLUGIN_ROOT}/board/board.sh`, against the root in `CLAUDECODE_AGENTS_BOARD_ROOT`. No token and no network: the board is files, and section 12 has nothing to say about it.` with `Note that hooks can't call MCP tools - they run as shell on the host - so the status writes go through the `board` binary, reached by the shim at `${CLAUDE_PLUGIN_ROOT}/board/board.sh`, which finds the repository's `.boards/` from the hook's working directory through git. No token and no network: the board is files, and section 12 has one sentence to say about it.`

In section 12, replace the paragraph beginning `One consequence of section 7 worth writing down rather than discovering. The board is one tree holding everything` with: `One consequence of section 7. The board travels with the repository, so client material on a board is exactly as exposed as the repository it is in - no more, no less - and an item you would have to redact before showing a client belongs in a repository that client can see, or not on a board at all.`

At the top of `docs/2026-09-17-backlog-board.md`, after the author line, add: `Superseded in part on 18 September 2026 by `docs/2026-09-18-project-boards.md`: the board is per repository at `.boards/`, not in the memory tree. Sections 4 and 9 below describe the memory-tree layout as it was for one afternoon.`

- [ ] **Step 5: NOTICE, changelog, versions**

In `claudecode-agents/board/NOTICE.md`, change the bullet `- the git layer (`src/git/`, `src/core/cross-branch-tasks.ts`, auto-commit and remote operations)` to `- the git layer (`src/git/`, `src/core/cross-branch-tasks.ts`, auto-commit and remote operations). On 18 September 2026 `src/git/operations.ts` regained add and commit, pathspec-limited to the board directory, and `src/git/branch-ids.ts` was written fresh for cross-ref id allocation; cross-branch task loading and remote operations stay out.`

In `claudecode-agents/CHANGELOG.md`, above `## [0.18.0]`, add:

```markdown
## [0.19.0] - 2026-09-18

The board lives with the project. Each repository has its own at `.boards/`, committed by the binary after every write; the memory tree's board is retired and a script migrates what was in it.

### Added

- **`task_focus` and `/work`.** The lead calls `task_focus <id>` when it starts a phase; the human runs `/work <id>`. Either writes one line to `.boards/.focus` (ignored by git), and `SubagentStart` reads it ahead of the session's own state and the launch-time variable. Nothing is set at launch any more.
- **`--by <name>` on `task create` and `task edit`,** so a commit subject names the writer: `board: BD-12 Doing (SubagentStart)`. The hooks pass their own name.
- **`board focus [id] | --show | --clear`** on the CLI.
- **A read-only scan of task ids across every local and remote-tracking ref** before an id is allocated, so two contributors do not mint the same one.
- **`/init` creates the board** from `templates/board.config.yml` and `templates/board.gitignore`, offering a per-repository prefix.

### Changed

- **The board directory is `.boards/` in the main checkout of the repository containing the working directory,** found through `git rev-parse --git-common-dir`, never a linked worktree's committed copy. `CLAUDECODE_AGENTS_BOARD_ROOT` still overrides. Outside a repository there is no board: the binary says `no board here` and a hook logs it and exits 0.
- **The binary commits its own writes.** `git add -- .boards` then `git commit -- .boards`, on the checked-out branch, never pushed, retried three times on a locked index, skipped when `.boards` is ignored, when `auto_commit` is not `true`, or when `CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1`. The git stub regained exactly that; everything else in it stays a stub.
- **The hooks run the binary in the hook's `cwd`** and no longer export a default root. The contract suite's live case is a git repository with a linked worktree, and asserts the move, the commit and the untouched worktree copy.
- **`/kickoff` checks `.boards/` in this repository; the installer only builds the binary** and no longer writes to the memory tree or its watcher. `home/board.config.yml` is gone.
- **The board skill, the glossary, the fleet plan and the hooks README** say all of the above; the `projects` list is no longer required and a project is the repository.

### Migration

- `scripts/migrate-memory-board.sh <project> <repo>` moves one project's items from `~/.memory/board/tasks/` into that repository's `.boards/tasks/`, renumbered, with the old id kept as a reference, and commits once. Run it per project; a board not migrated starts empty.
```

Bump `"version"` to `0.19.0` in both manifests.

- [ ] **Step 6: Verify and commit**

Run: `bash evals/lib/check-all.sh 2>&1 | grep -E '^[a-z-]+: (ok|FAILED)'`, and outside the sandbox `cd claudecode-agents/board && bun test --timeout=10000`.
Expected: every check-all step `ok` (board under sandbox: loopback only), the whole board suite green.

```bash
git add claudecode-agents/agents/lead.md claudecode-agents/skills claudecode-agents/templates/rules/glossary.md docs/fleet-plan.md docs/2026-09-17-backlog-board.md claudecode-agents/board/NOTICE.md claudecode-agents/CHANGELOG.md claudecode-agents/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "v0.19.0: the board lives with the project"
```

---

## Phase 4: migration

### Task 9: the migration script, run twice

**Files:**
- Create: `scripts/migrate-memory-board.sh`

**Interfaces:**
- Produces: `scripts/migrate-memory-board.sh <project> <repo-path>`; reads `~/.memory/board/tasks/*.md` (or `$CLAUDECODE_AGENTS_OLD_BOARD/tasks`), writes into `<repo>/.boards/tasks/`, commits once in `<repo>`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# migrate-memory-board.sh PROJECT REPO
#
# One-shot: move the items filed under PROJECT in the memory tree's board into
# REPO's .boards/tasks/, renumbered from the next free id there in creation
# order, with the old id kept as a reference, and commit once. The memory
# tree is read, never written; delete its board/ by hand when satisfied.
set -euo pipefail

project="${1:?usage: migrate-memory-board.sh PROJECT REPO}"
repo="${2:?usage: migrate-memory-board.sh PROJECT REPO}"
old="${CLAUDECODE_AGENTS_OLD_BOARD:-$HOME/.memory/board}"

[ -d "$old/tasks" ] || { echo "no old board at $old/tasks" >&2; exit 1; }
[ -d "$repo/.boards/tasks" ] || { echo "$repo has no .boards/tasks; run /init there first" >&2; exit 1; }
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null

prefix="$(sed -n 's/^task_prefix: *"\{0,1\}\([A-Za-z]*\)"\{0,1\}.*/\1/p' "$repo/.boards/config.yml")"
prefix="${prefix:-BD}"

# Highest id already in the target, across the working tree and every ref.
highest=0
while IFS= read -r n; do
    [ "$n" -gt "$highest" ] && highest="$n"
done < <(
    { ls "$repo/.boards/tasks" 2>/dev/null
      git -C "$repo" for-each-ref --format='%(refname)' refs/heads refs/remotes \
        | while IFS= read -r ref; do git -C "$repo" ls-tree -r --name-only "$ref" -- .boards/tasks 2>/dev/null; done
    } | grep -oiE "(^|/)${prefix}-[0-9]+" | grep -oE '[0-9]+$' || true
)

moved=0
# Creation order: the old id's number, ascending.
while IFS= read -r file; do
    grep -qiE "^project: *[\"']?${project}[\"']?\s*$" "$file" || continue
    oldid="$(sed -n 's/^id: *//p' "$file" | head -1)"
    title="$(sed -n 's/^title: *//p' "$file" | head -1 | sed -e 's/^"//' -e 's/"$//')"
    highest=$((highest + 1))
    newid="${prefix}-${highest}"
    slug="$(printf '%s' "$title" | tr -cs 'A-Za-z0-9' '-' | sed -e 's/^-//' -e 's/-$//')"
    target="$repo/.boards/tasks/$(printf '%s' "$newid" | tr 'A-Z' 'a-z') - ${slug}.md"
    # id line rewritten; the old id kept in references (added if absent).
    if grep -q '^references:' "$file"; then
        sed -e "s/^id: .*/id: ${newid}/" -e "s/^references:.*/&\n  - memory-tree ${oldid}/" "$file" > "$target"
    else
        sed -e "s/^id: .*/id: ${newid}/" -e "s/^title: .*/&\nreferences:\n  - memory-tree ${oldid}/" "$file" > "$target"
    fi
    printf 'moved %s -> %s\n' "$oldid" "$newid"
    moved=$((moved + 1))
done < <(ls "$old/tasks"/*.md | sort -t- -k2,2n)

[ "$moved" -gt 0 ] || { echo "nothing filed under project '$project' in $old/tasks"; exit 0; }
git -C "$repo" add -- .boards
git -C "$repo" commit -q -m "board: ${moved} items migrated from the memory tree's board (project ${project})" -- .boards
printf 'committed %s items into %s\n' "$moved" "$repo"
```

`chmod +x scripts/migrate-memory-board.sh`. The `sed` `\n` in a replacement is GNU and BSD sed disagree on it; on macOS use `sed -e 's/^id: .*/id: NEW/' -e '/^title: /a\
references:\
  - memory-tree OLD' ` form instead. Test on this machine before committing.

- [ ] **Step 2: Dry-run it against a copy**

```bash
T=$(mktemp -d); cp -R ~/.memory/board "$T/old"; mkdir -p "$T/repo/.boards/tasks"; cp claudecode-agents/templates/board.config.yml "$T/repo/.boards/config.yml"; git -C "$T/repo" init -q -b main; git -C "$T/repo" add -A; git -C "$T/repo" commit -qm base
CLAUDECODE_AGENTS_OLD_BOARD="$T/old" bash scripts/migrate-memory-board.sh Fathom "$T/repo"
ls "$T/repo/.boards/tasks" | head -3; git -C "$T/repo" log -1 --format=%s; grep -c 'memory-tree BD-' "$T/repo/.boards/tasks"/*.md | tail -1
cd "$T/repo" && CLAUDECODE_AGENTS_BOARD_NO_COMMIT=1 ~/.local/bin/board task list --json | jq '.tasks | length'
```

Expected: 25 files named `bd-1 - ...` through `bd-25 - ...`, one commit, each file carrying a `memory-tree BD-n` reference, and the binary listing 25 tasks. Fix the script until it does.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/migrate-memory-board.sh
git commit -m "scripts: migrate one project's items from the memory tree's board into a repository"
```

- [ ] **Step 4: Run it for real, with the human**

Two runs, each in another repository and each a commit there, so confirm with the human first, then:

```bash
# claudecode-agents itself: run /init's board step here first (or create .boards from the templates by hand), then
bash scripts/migrate-memory-board.sh "Claude Agents" /Users/alex/Dev/Work/extensions/claudecode-agents
# Fathom: needs .boards/ there first (the human runs /init in that repo, or creates it from the templates), then
bash scripts/migrate-memory-board.sh Fathom /Users/alex/Dev/Work/fathom/fathom-rzem-ai
```

Then in the Fathom repo rename `docs/plans/BD-24.md` to the new id the migration printed for `BD-24`, update the `Plan:` line in that item's description with `board task edit <new> -d ...` or leave it and note the rename in the commit, and commit. Report both commit hashes to the human. The memory tree's `board/` is left in place for the human to delete.

---

## Self-review

**Spec coverage.** Section 3 (location, `.boards`, env override, no `projects`, template move, memory tree retired): Tasks 1, 7. Section 4 (commits, pathspec, soft-fail, retries, ignore, `NO_COMMIT`, one implementation, worktrees, ids across refs): Tasks 2, 3, 4, 6. Section 5 (which board, cwd for every caller, `no board here`): Tasks 1, 6. Section 6 (`task_focus`, `.focus`, precedence, `/work`): Tasks 5, 6, 7. Section 7 (hook library, contract cases): Task 6. Section 8 (tools, lead grant, steward): Task 5, 8. Section 9 (commands, docs, installer, changelog): Tasks 7, 8. Section 10 (migration, Fathom plan rename): Task 9. Section 12's `.mcp.json` env fallback is not built - it is the first thing to try if the cwd assumption fails, and is recorded in the changelog's wording only if it does.

**Placeholders.** None; every code step carries its content. The one platform caveat (BSD sed `\n`) is called out with the alternative form.

**Type consistency.** `resolveBoardRoot(env, cwd)` and `mainCheckoutOf(cwd)` (Task 1) are what Task 5's CLI and Task 4's tests use. `setCommitContext({by, note})` (Task 2) is what Task 3's CLI and Task 5's MCP server call. `commitBoard(note, taskId?)` is internal to the git layer. `readFocus/writeFocus/clearFocus(root)` (Task 5) match the CLI, the tool and the hooks' `board focus --show`. `BOARD_CWD`, `board_focus_id` (Task 6) match the contract cases. `--by` on create and edit (Task 3) is what Task 6's library passes.
