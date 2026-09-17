import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";

// Task 3 deleted every upstream test that drove the old CLI as a subprocess, taking with it the
// only coverage of behaviour this thin CLI still carries. This file puts that coverage back,
// driving `src/cli.ts` as a subprocess exactly as `cli-board.test.ts` does, and asserting through
// `task view --json` after each edit rather than trusting an edit's exit code alone.
//
// Cases build on tasks created earlier in this same file, in order, rather than each creating a
// fully isolated fixture: the "second create under a parent" and "dependency readiness" cases need
// an earlier task to exist, so this file relies on `it` blocks within a `describe` (and describes
// themselves) running in source order against one shared temporary root.

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
	root = mkdtempSync(join(tmpdir(), "board-cli-behaviour-"));
	mkdirSync(join(root, DEFAULT_DIRECTORIES.BACKLOG));
	writeFileSync(
		join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"),
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

describe("comment append", () => {
	it("lands an authored comment with body and date in the JSON view", () => {
		const created = JSON.parse(board("task", "create", "Rotate refresh tokens", "--json").out);
		const id = created.task.id;

		const edited = board(
			"task",
			"edit",
			id,
			"--comment",
			"Blocker: which key?",
			"--comment-author",
			"@subagent-stop",
			"--json",
		);
		expect(edited.code).toBe(0);

		const view = JSON.parse(board("task", "view", id, "--json").out);
		expect(view.task.comments).toHaveLength(1);
		expect(view.task.comments[0].author).toBe("@subagent-stop");
		expect(view.task.comments[0].body).toContain("Blocker: which key?");
		expect(view.task.comments[0].createdAt).toBeTruthy();
	});
});

describe("acceptance criteria", () => {
	it("--ac on create then --check-ac 1 flips checked and the completed count", () => {
		const created = JSON.parse(board("task", "create", "Ship the AC gate", "--ac", "Old token is refused", "--json").out);
		const id = created.task.id;
		expect(created.task.acceptanceCriteria[0].text).toBe("Old token is refused");
		expect(created.task.acceptanceCriteria[0].checked).toBe(false);
		expect(created.task.acceptanceCriteriaCompleted).toBe(0);

		const edited = board("task", "edit", id, "--check-ac", "1", "--json");
		expect(edited.code).toBe(0);

		const view = JSON.parse(board("task", "view", id, "--json").out);
		expect(view.task.acceptanceCriteria[0].checked).toBe(true);
		expect(view.task.acceptanceCriteriaCompleted).toBe(1);
	});
});

describe("implementation notes", () => {
	it("--append-notes twice yields both lines in order", () => {
		const created = JSON.parse(board("task", "create", "Track rollout notes", "--json").out);
		const id = created.task.id;

		expect(board("task", "edit", id, "--append-notes", "First note", "--json").code).toBe(0);
		expect(board("task", "edit", id, "--append-notes", "Second note", "--json").code).toBe(0);

		const view = JSON.parse(board("task", "view", id, "--json").out);
		const notes: string = view.task.implementationNotes;
		expect(notes).toContain("First note");
		expect(notes).toContain("Second note");
		expect(notes.indexOf("First note")).toBeLessThan(notes.indexOf("Second note"));
	});
});

describe("implementation plan", () => {
	it("--plan replaces, then --append-plan appends", () => {
		const created = JSON.parse(board("task", "create", "Plan a rollout", "--plan", "Step 1: prep", "--json").out);
		const id = created.task.id;
		expect(created.task.implementationPlan).toBe("Step 1: prep");

		expect(board("task", "edit", id, "--append-plan", "Step 2: ship", "--json").code).toBe(0);

		const view = JSON.parse(board("task", "view", id, "--json").out);
		const plan: string = view.task.implementationPlan;
		expect(plan).toContain("Step 1: prep");
		expect(plan).toContain("Step 2: ship");
		expect(plan.indexOf("Step 1: prep")).toBeLessThan(plan.indexOf("Step 2: ship"));
	});
});

describe("dependency readiness", () => {
	// BD-1 is the task created in "comment append" above, the first task this file creates, so it
	// is a deterministic id to depend on.
	let dependentId = "";

	it("--dep on a second task makes it blocked while the dependency is not Done", () => {
		const created = JSON.parse(board("task", "create", "Depends on the blocker", "--dep", "BD-1", "--json").out);
		dependentId = created.task.id;

		const view = JSON.parse(board("task", "view", dependentId, "--json").out);
		expect(view.task.dependencies).toEqual(["BD-1"]);
		expect(view.task.readiness.isBlocked).toBe(true);
	});

	it("clears once the dependency moves to Done", () => {
		expect(board("task", "edit", "BD-1", "-s", "Done", "--json").code).toBe(0);

		const view = JSON.parse(board("task", "view", dependentId, "--json").out);
		expect(view.task.readiness.isBlocked).toBe(false);
	});
});

describe("final summary", () => {
	// --final-summary is a `task edit` option only (there is no such flag on `task create`).
	it("--final-summary lands in finalSummary", () => {
		const created = JSON.parse(board("task", "create", "Wrap up the rollout", "--json").out);
		const id = created.task.id;

		const edited = board("task", "edit", id, "--final-summary", "Shipped clean", "--json");
		expect(edited.code).toBe(0);
		expect(JSON.parse(edited.out).task.finalSummary).toBe("Shipped clean");

		const view = JSON.parse(board("task", "view", id, "--json").out);
		expect(view.task.finalSummary).toBe("Shipped clean");
	});
});

describe("parented create", () => {
	it("a second create under -p BD-1 gets id BD-1.1 and parentTaskId BD-1", () => {
		// BD-1 is the task created in "comment append" above.
		const created = JSON.parse(board("task", "create", "Subtask of BD-1", "-p", "BD-1", "--json").out);
		expect(created.task.id).toBe("BD-1.1");
		expect(created.task.parentTaskId).toBe("BD-1");
	});
});

describe("section-marker safety", () => {
	// `assertSectionInputHasNoMarkerLines` (src/markdown/structured-sections.ts) guards
	// description, implementationPlan, implementationNotes and finalSummary; it is never called
	// against the title (src/core/backlog.ts's assertSectionInputsSafe omits it). So this case is
	// written against --description, the field the brief's example marker actually maps to
	// (SECTION:DESCRIPTION:BEGIN is the "description" key's begin marker).
	it("refuses a description containing the section's own marker line", () => {
		const r = board(
			"task",
			"create",
			"Marker guard",
			"--description",
			"<!-- SECTION:DESCRIPTION:BEGIN -->",
			"--json",
		);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("reserved marker line");
	});
});

describe("list filtered by status", () => {
	it("task list --status \"Blocked by human\" --json returns only that status", () => {
		const created = JSON.parse(board("task", "create", "Needs a human", "--status", "Blocked by human", "--json").out);
		const id = created.task.id;

		const list = JSON.parse(board("task", "list", "--status", "Blocked by human", "--json").out);
		expect(list.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
		expect(list.tasks.every((t: { status: string }) => t.status === "Blocked by human")).toBe(true);
	});
});

describe("search", () => {
	it("task search finds a task by a word from its title and reports kind search", () => {
		const created = JSON.parse(board("task", "create", "Xylophone onboarding flow", "--json").out);
		const id = created.task.id;

		const search = JSON.parse(board("task", "search", "Xylophone", "--json").out);
		expect(search.kind).toBe("search");
		const hit = search.results.find(
			(r: { type: string; data: { id: string } }) => r.type === "task" && r.data.id === id,
		);
		expect(hit).toBeTruthy();
	});
});
