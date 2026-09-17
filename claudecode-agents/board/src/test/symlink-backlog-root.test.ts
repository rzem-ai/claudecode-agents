import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, isWindows, safeCleanup } from "./test-utils.ts";

describe("Symlinked backlog root", () => {
	const itIfSymlinks = isWindows() ? it.skip : it;
	let repoDir: string;
	let backlogDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-symlink-root-repo");
		backlogDir = createUniqueTestDir("test-symlink-root-backlog");
		await mkdir(repoDir, { recursive: true });
		await mkdir(backlogDir, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
		await safeCleanup(backlogDir);
	});

	itIfSymlinks("creates tasks when backlog root is a symlink and autoCommit is false", async () => {
		await mkdir(join(backlogDir, "tasks"), { recursive: true });
		await mkdir(join(backlogDir, "drafts"), { recursive: true });
		await writeFile(
			join(backlogDir, "config.yml"),
			`project_name: "Symlink Root"
statuses: ["To Do", "In Progress", "Done"]
auto_commit: false
`,
		);

		await symlink(backlogDir, join(repoDir, "backlog"));

		const core = new Core(repoDir);
		const { task } = await core.createTaskFromInput({ title: "Symlink root task" });

		const files = await Array.fromAsync(new Bun.Glob("task-*.md").scan({ cwd: join(backlogDir, "tasks") }));
		expect(files.length).toBe(1);
		expect(task.id).toBe("TASK-1");

		const tasks = await core.listTasksWithMetadata();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe("TASK-1");
	});
});
