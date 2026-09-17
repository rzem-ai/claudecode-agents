import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { GitOperations } from "../git/operations.ts";
import type { BacklogConfig } from "../types/index.ts";

describe("Missing git remote preflight", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "backlog-noremote-"));
		await $`git init`.cwd(tempDir).quiet();
		await writeFile(join(tempDir, "README.md"), "# Test");
		await $`git add README.md`.cwd(tempDir).quiet();
		await $`git commit -m "init"`.cwd(tempDir).quiet();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("GitOperations.fetch() silently skips when no remotes exist", async () => {
		const gitOps = new GitOperations(tempDir, {
			projectName: "Test",
			statuses: ["To Do", "Done"],
			labels: [],
			milestones: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: true,
		} as BacklogConfig);

		// Capture console.warn to ensure no warning is printed during fetch
		const originalWarn = console.warn;
		const warns: string[] = [];
		console.warn = (msg: string) => {
			warns.push(msg);
		};

		await expect(async () => {
			await gitOps.fetch();
		}).not.toThrow();

		// Should not warn during fetch when no remotes
		expect(warns.length).toBe(0);

		console.warn = originalWarn;
	});

	it("Core cross-branch loading handles remoteOperations=true without a remote", async () => {
		const config: BacklogConfig = {
			projectName: "Test",
			statuses: ["To Do", "Done"],
			labels: [],
			milestones: [],
			dateFormat: "YYYY-MM-DD",
			checkActiveBranches: true,
			remoteOperations: true,
		};

		await mkdir(join(tempDir, "backlog", "tasks"), { recursive: true });
		await mkdir(join(tempDir, "backlog", "completed"), { recursive: true });
		const core = new Core(tempDir, { enableWatchers: false });
		await core.filesystem.saveConfig(config);

		await expect(core.loadTasks()).resolves.toEqual([]);
	});

});
