import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";

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
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.email", "t@t"],
		["config", "user.name", "t"],
		["add", "-A"],
		["commit", "-q", "-m", "base"],
	]) {
		const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	}
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("board task", () => {
	it("creates a task with the BD prefix and returns JSON", () => {
		const r = board(
			"task",
			"create",
			"Rotate refresh tokens",
			"--project",
			"fleet",
			"--ac",
			"Old token is refused",
			"--json",
		);
		expect(r.code).toBe(0);
		const json = JSON.parse(r.out);
		expect(json.task.id).toBe("BD-1");
		expect(json.task.status).toBe("To Do");
		expect(json.task.acceptanceCriteria[0].text).toBe("Old token is refused");
	});

	it("moves status and appends an authored comment", () => {
		const r = board(
			"task",
			"edit",
			"BD-1",
			"-s",
			"Blocked by human",
			"--comment",
			"Blocker: which key?",
			"--comment-author",
			"@subagent-stop",
			"--json",
		);
		expect(r.code).toBe(0);
		const view = JSON.parse(board("task", "view", "BD-1", "--json").out);
		expect(view.task.status).toBe("Blocked by human");
		expect(view.task.comments[0].author).toBe("@subagent-stop");
		expect(view.task.comments[0].body).toContain("Blocker: which key?");
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

function lastLog(format: string): string {
	return Bun.spawnSync(["git", "-C", root, "log", "-1", `--format=${format}`], { stdout: "pipe" })
		.stdout.toString()
		.trim();
}
const lastSubject = () => lastLog("%s");
const lastWriter = () => lastLog("%(trailers:key=Board-Writer,valueonly)");

describe("board task commits with --by", () => {
	it("a status move commits naming the status, with the writer as a trailer", () => {
		const created = JSON.parse(board("task", "create", "Move me", "--project", "fleet", "--json").out);
		const id = created.task.id as string;
		expect(lastSubject()).toBe(`Create ${id} on the board`);
		const r = board("task", "edit", id, "-s", "doing", "--by", "SubagentStart");
		expect(r.code).toBe(0);
		expect(lastSubject()).toBe(`Move ${id} to Doing on the board`);
		expect(lastWriter()).toBe("SubagentStart");
	});

	it("a comment commits as a comment", () => {
		const created = JSON.parse(board("task", "create", "Comment me", "--project", "fleet", "--json").out);
		const id = created.task.id as string;
		board("task", "edit", id, "--comment", "hello", "--comment-author", "@SubagentStop", "--by", "SubagentStop");
		expect(lastSubject()).toBe(`Add a comment to ${id} on the board`);
		expect(lastWriter()).toBe("SubagentStop");
	});

	it("a create with --by names the writer", () => {
		const created = JSON.parse(
			board("task", "create", "Filed", "--project", "fleet", "--by", "fleet-steward", "--json").out,
		);
		expect(lastSubject()).toBe(`Create ${created.task.id} on the board`);
		expect(lastWriter()).toBe("fleet-steward");
	});
});
