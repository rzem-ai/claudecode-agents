import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import { Core } from "../core/backlog.ts";
import type { BacklogConfig, Task } from "../types/index.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("Board Loading with checkActiveBranches", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-board-loading");
		core = new Core(TEST_DIR);
		await core.filesystem.ensureBacklogStructure();

		// Initialize git repository for testing
		await $`git init -b main`.cwd(TEST_DIR).quiet();

		// Initialize project with default config
		await initializeTestProject(core, "Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	const createTestTask = (id: string, status = "To Do"): Task => ({
		id,
		title: `Test Task ${id}`,
		status,
		assignee: [],
		createdDate: "2025-01-08",
		labels: ["test"],
		dependencies: [],
		description: `This is test task ${id}`,
	});

	describe("Core.loadTasks()", () => {
		beforeEach(async () => {
			// Create some test tasks
			await core.createTask(createTestTask("task-1", "To Do"), false);
			await core.createTask(createTestTask("task-2", "In Progress"), false);
			await core.createTask(createTestTask("task-3", "Done"), false);

			// Commit them to have a clean state
			await $`git add .`.cwd(TEST_DIR).quiet();
			await $`git commit -m "Add test tasks"`.cwd(TEST_DIR).quiet();
		});

		it("should load tasks with default configuration", async () => {
			const tasks = await core.loadTasks();

			expect(tasks).toHaveLength(3);
			expect(tasks.find((t) => t.id === "TASK-1")).toBeDefined();
			expect(tasks.find((t) => t.id === "TASK-2")).toBeDefined();
			expect(tasks.find((t) => t.id === "TASK-3")).toBeDefined();
		});

		it("should skip cross-branch checking when checkActiveBranches is false", async () => {
			// Update config to disable cross-branch checking
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			const updatedConfig: BacklogConfig = {
				...config,
				checkActiveBranches: false,
			};
			await core.filesystem.saveConfig(updatedConfig);

			// Track progress messages
			const progressMessages: string[] = [];
			const tasks = await core.loadTasks((msg) => {
				progressMessages.push(msg);
			});

			// Verify we got tasks
			expect(tasks).toHaveLength(3);

			// Verify we didn't apply cross-branch state snapshots
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest task states from branch scans..."),
			);
			expect(applySnapshotsMessage).toBeUndefined();
		});

		it("should handle cancellation via AbortSignal", async () => {
			const controller = new AbortController();

			// Cancel immediately
			controller.abort();

			// Should throw an error
			await expect(core.loadTasks(undefined, controller.signal)).rejects.toThrow("Loading cancelled");
		});

		it("should handle empty task list gracefully", async () => {
			// Remove all tasks
			await $`rm -rf ${DEFAULT_DIRECTORIES.BACKLOG}/tasks/*`.cwd(TEST_DIR).quiet();

			const tasks = await core.loadTasks();
			expect(tasks).toEqual([]);
		});
	});

	describe("Config integration", () => {
		it("should handle config with checkActiveBranches explicitly set to false", async () => {
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			await core.filesystem.saveConfig({
				...config,
				checkActiveBranches: false,
			});

			const progressMessages: string[] = [];
			await core.loadTasks((msg) => {
				progressMessages.push(msg);
			});

			// Should not apply cross-branch state snapshots
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest task states from branch scans..."),
			);
			expect(applySnapshotsMessage).toBeUndefined();
		});

		it("should not load tasks from other branches when checkActiveBranches is false", async () => {
			// 0. Ensure main has at least one commit so it exists
			await core.createTask(createTestTask("task-main"), false);
			await $`git add .`.cwd(TEST_DIR).quiet();
			await $`git commit -m "Initial commit on main"`.cwd(TEST_DIR).quiet();

			// 1. Create a task on a different branch
			await $`git checkout -b other-branch`.cwd(TEST_DIR).quiet();
			const otherTask = createTestTask("task-other", "To Do");
			await core.createTask(otherTask, false);
			await $`git add .`.cwd(TEST_DIR).quiet();
			await $`git commit -m "Add task on other branch"`.cwd(TEST_DIR).quiet();

			// 2. Go back to main
			await $`git checkout main`.cwd(TEST_DIR).quiet();

			// 3. Disable checkActiveBranches
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			await core.filesystem.saveConfig({
				...config,
				checkActiveBranches: false,
			});

			// 4. Load tasks
			const tasks = await core.loadTasks();

			// 5. Verify task from other branch is NOT loaded
			expect(tasks.find((t) => t.id === "TASK-OTHER")).toBeUndefined();
			// Only the 1 task from main should be there
			expect(tasks).toHaveLength(1);
		});
	});
});
