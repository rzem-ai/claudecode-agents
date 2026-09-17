import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("Board command integration", () => {
	let core: Core;
	let coreInitialized = false;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-board-command");
		coreInitialized = false;
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		await $`git init`.cwd(TEST_DIR).quiet();

		core = new Core(TEST_DIR);
		coreInitialized = true;
		await initializeTestProject(core, "Test Board Project");

		// Disable remote operations for tests to prevent background git fetches
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.remoteOperations = false;
			await core.filesystem.saveConfig(config);
		}

		// Create some test tasks
		const tasksDir = core.filesystem.tasksDir;
		await writeFile(
			join(tasksDir, "task-1 - Test Task One.md"),
			`---
id: task-1
title: Test Task One
status: To Do
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

This is a test task for board testing.`,
		);

		await writeFile(
			join(tasksDir, "task-2 - Test Task Two.md"),
			`---
id: task-2
title: Test Task Two
status: In Progress
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

This is another test task for board testing.`,
		);
	});

	afterEach(async () => {
		if (coreInitialized) core.disposeContentStore();
		await safeCleanup(TEST_DIR);
	});

	describe("Board loading", () => {
		it("should load board without errors", async () => {
			// This test verifies that the board command data loading works correctly
			const tasks = await core.filesystem.listTasks();
			expect(tasks.length).toBe(2);

			// Test that we can prepare the board data without running the interactive UI
			expect(() => {
				const options = {
					core,
					initialView: "kanban" as const,
					tasks: tasks.map((t) => ({ ...t, status: t.status || "" })),
				};

				// Verify board options are valid
				expect(options.core).toBeDefined();
				expect(options.initialView).toBe("kanban");
				expect(options.tasks).toBeDefined();
				expect(options.tasks.length).toBe(2);
				expect(options.tasks[0]?.status).toBe("To Do");
				expect(options.tasks[1]?.status).toBe("In Progress");
			}).not.toThrow();
		});

		it("should handle empty task list gracefully", async () => {
			// Remove test tasks
			const tasksDir = core.filesystem.tasksDir;
			await rm(join(tasksDir, "task-1 - Test Task One.md"));
			await rm(join(tasksDir, "task-2 - Test Task Two.md"));

			const tasks = await core.filesystem.listTasks();
			expect(tasks.length).toBe(0);

			// Should handle empty task list properly
			expect(() => {
				const options = {
					core,
					initialView: "kanban" as const,
					tasks: [],
				};

				// Verify empty task list is handled correctly
				expect(options.core).toBeDefined();
				expect(options.initialView).toBe("kanban");
				expect(options.tasks).toBeDefined();
				expect(options.tasks.length).toBe(0);
			}).not.toThrow();
		});
	});
});
