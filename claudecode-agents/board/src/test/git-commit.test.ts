import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import { Core } from "../core/backlog.ts";
import { FOCUS_FILE, writeFocus } from "../core/focus.ts";
import { resetCommitContext, setCommitContext } from "../git/commit-context.ts";
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
	resetCommitContext();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CLAUDECODE_AGENTS_BOARD_NO_COMMIT;
	resetCommitContext();
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

	it("never commits the focus file", async () => {
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		writeFocus(repo, task.id);
		await core.updateTaskFromInput(task.id, { title: "First, retitled" });
		expect(git("show", "--stat", "--format=", "HEAD")).not.toContain(FOCUS_FILE);
		expect(git("status", "--porcelain")).toContain(`?? ${BOARD_DIR}/${FOCUS_FILE}`);
	});

	// What /init produces: templates/board.gitignore ignores .focus. An exclude
	// pathspec naming an ignored file makes `git add` exit 1, so the add must
	// not carry one.
	it("commits when the focus file exists and .boards/.gitignore ignores it", async () => {
		writeFileSync(join(repo, BOARD_DIR, ".gitignore"), `${FOCUS_FILE}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		writeFocus(repo, task.id);
		await core.updateTaskFromInput(task.id, { title: "First, retitled" });
		expect(git("log", "-1", "--format=%s")).toContain(task.id);
		expect(git("show", "--stat", "--format=", "HEAD")).not.toContain(FOCUS_FILE);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("leaves nothing of .boards staged when the add fails after staging", async () => {
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		// A git on PATH whose add stages as usual and then exits 1, as the
		// ignored-exclude failure did.
		const bin = join(tmp, "bin");
		mkdirSync(bin);
		const realGit = Bun.which("git");
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\n"${realGit}" "$@"; s=$?\nfor a in "$@"; do [ "$a" = add ] && exit 1; done\nexit $s\n`,
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		const logged = spyOn(console, "error").mockImplementation(() => {});
		process.env.PATH = `${bin}:${path}`;
		try {
			await core.updateTaskFromInput(task.id, { title: "First, retitled" });
		} finally {
			process.env.PATH = path;
			logged.mockRestore();
		}
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} created`);
		expect(git("diff", "--cached", "--name-only", "--", BOARD_DIR)).toBe("");
		expect(git("status", "--porcelain")).toContain(BOARD_DIR);
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
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const core = new Core(repo);
			const { task } = await core.createTaskFromInput({ title: "First" });
			rmSync(lock, { force: true });
			expect(git("log", "-1", "--format=%s")).toBe("base");
			expect((await core.getTask(task.id))?.title).toBe("First");
		} finally {
			errors.mockRestore();
		}
	});

	it("commits from a board nested below the repository root", async () => {
		const sub = join(repo, "sub");
		mkdirSync(join(sub, BOARD_DIR, "tasks"), { recursive: true });
		writeFileSync(
			join(sub, BOARD_DIR, "config.yml"),
			`project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\ndefault_status: "To Do"\nauto_commit: true\n`,
		);
		git("add", "-A");
		git("commit", "-q", "-m", "sub base");
		const core = new Core(sub);
		const { task } = await core.createTaskFromInput({ title: "Nested" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} created`);
		expect(git("show", "--stat", "--format=", "HEAD")).toContain(`sub/${BOARD_DIR}/tasks`);
	});

	it("does not commit or log when a rewrite changes nothing", async () => {
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		const beforeLog = git("log", "--oneline");
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const loaded = await core.getTask(task.id);
			if (!loaded) throw new Error("task missing");
			// A bulk rewrite writes every task back unconditionally, so the same task
			// with nothing changed reaches the git layer with an identical file: the
			// exact no-op write findings 1 covers (a status set to what it already
			// is short-circuits before ever reaching git, so this exercises the real
			// path instead).
			await core.updateTasksBulk([loaded], undefined, true);
			expect(git("log", "--oneline")).toBe(beforeLog);
			expect(git("status", "--porcelain")).toBe("");
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});

	it("keeps the writer across commits when by is set once, MCP-style", async () => {
		setCommitContext({ by: "mcp" });
		const core = new Core(repo);
		const { task: first } = await core.createTaskFromInput({ title: "First" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${first.id} created (mcp)`);
		const { task: second } = await core.createTaskFromInput({ title: "Second" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${second.id} created (mcp)`);
	});

	it("does not leak one write's note into the next", async () => {
		setCommitContext({ by: "mcp" });
		const core = new Core(repo);
		const { task } = await core.createTaskFromInput({ title: "First" });
		setCommitContext({ note: "Doing" });
		await core.updateTaskFromInput(task.id, { status: "Doing" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} Doing (mcp)`);
		await core.updateTaskFromInput(task.id, { title: "First, retitled" });
		expect(git("log", "-1", "--format=%s")).toBe(`board: ${task.id} updated (mcp)`);
	});

	it("leaves .boards unstaged when a commit fails mid-merge", async () => {
		writeFileSync(join(repo, "conflict.txt"), "main\n");
		git("add", "conflict.txt");
		git("commit", "-q", "-m", "add conflict.txt on main");
		git("checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "conflict.txt"), "other\n");
		git("commit", "-q", "-a", "-m", "other change");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "conflict.txt"), "main change\n");
		git("commit", "-q", "-a", "-m", "main change");
		const merge = Bun.spawnSync(["git", "-C", repo, "merge", "other"], { stdout: "pipe", stderr: "pipe" });
		expect(merge.exitCode).not.toBe(0);
		expect(git("status", "--porcelain")).toContain("UU conflict.txt");

		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const core = new Core(repo);
			await core.createTaskFromInput({ title: "Mid merge" });
			expect(git("diff", "--cached", "--name-only")).not.toContain(BOARD_DIR);
		} finally {
			errors.mockRestore();
		}
	});
});
