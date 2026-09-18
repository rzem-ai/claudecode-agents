import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("treats a regex-special prefix literally instead of throwing or over-matching", () => {
		expect(listTaskIdsAcrossRefs(repo, BOARD_DIR, "B.D")).toEqual([]);
	});
});

describe("generateNextId", () => {
	it("skips an id that only exists on another branch", async () => {
		const { task } = await new Core(repo).createTaskFromInput({ title: "three" });
		expect(task.id).toBe("BD-3");
	});
});

// The realpath fix in Core.getActiveAndCompletedTaskIds only fires when
// getRepositoryRoot()'s canonicalised answer differs from the path Core was
// built with. On macOS that happens for free because tmpdir() sits under a
// symlink (/tmp -> /private/tmp); on other platforms it does not. Building
// an explicit symlink to the repository pins the behaviour on any platform.
describe("generateNextId through a symlinked root", () => {
	let symTmp = "";
	let symRealRepo = "";
	let symLinkedRepo = "";

	function symGit(...args: string[]) {
		const p = Bun.spawnSync(["git", "-C", symRealRepo, ...args], { stdout: "pipe", stderr: "pipe" });
		if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
		return p.stdout.toString().trim();
	}

	beforeAll(async () => {
		symTmp = mkdtempSync(join(tmpdir(), "branch-ids-sym-"));
		symRealRepo = join(symTmp, "real-repo");
		symLinkedRepo = join(symTmp, "linked-repo");
		mkdirSync(join(symRealRepo, BOARD_DIR, "tasks"), { recursive: true });
		writeFileSync(
			join(symRealRepo, BOARD_DIR, "config.yml"),
			'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Done"]\ndefault_status: "To Do"\nauto_commit: true\n',
		);
		symGit("init", "-q", "-b", "main");
		symGit("config", "user.email", "t@t");
		symGit("config", "user.name", "t");
		symGit("add", "-A");
		symGit("commit", "-q", "-m", "base");
		await new Core(symRealRepo).createTaskFromInput({ title: "one" }); // BD-1 on main, committed
		symGit("switch", "-q", "-c", "other");
		await new Core(symRealRepo).createTaskFromInput({ title: "two" }); // BD-2 on other, committed
		symGit("switch", "-q", "main"); // BD-2's file is gone from the working tree
		symlinkSync(symRealRepo, symLinkedRepo);
	});

	afterAll(() => rmSync(symTmp, { recursive: true, force: true }));

	it("skips an id that only exists on another branch, reached through a symlink", async () => {
		const { task } = await new Core(symLinkedRepo).createTaskFromInput({ title: "three" });
		expect(task.id).toBe("BD-3");
	});
});
