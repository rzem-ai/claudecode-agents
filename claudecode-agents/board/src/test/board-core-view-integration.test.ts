import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("Board core and view integration", () => {
	let core: Core;
	let coreInitialized = false;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-board-core-view-integration");
		coreInitialized = false;
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		await $`git init`.cwd(TEST_DIR).quiet();

		core = new Core(TEST_DIR);
		coreInitialized = true;
		await initializeTestProject(core, "Test Board Integration Project");

		// Disable remote operations for tests to prevent background git fetches
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.remoteOperations = false;
			await core.filesystem.saveConfig(config);
		}

		// Create test tasks
		const tasksDir = core.filesystem.tasksDir;
		await writeFile(
			join(tasksDir, "task-1 - Board Test Task.md"),
			`---
id: task-1
title: Board Test Task
status: To Do
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

Test task for board integration.`,
		);
	});

	afterEach(async () => {
		if (coreInitialized) core.disposeContentStore();
		await safeCleanup(TEST_DIR);
	});

	it("loads board task data without crashing", async () => {
		const config = await core.filesystem.loadConfig();
		const statuses = config?.statuses || [];

		// Load the local task state used to assemble board data.
		const [localTasks, _remoteTasks] = await Promise.all([
			core.listTasksWithMetadata(),
			// Remote task loading is intentionally outside this internal integration fixture.
			Promise.resolve([]),
		]);

		// Verify basic functionality
		expect(localTasks.length).toBe(1);
		expect(localTasks[0]?.id).toBe("TASK-1");
		expect(localTasks[0]?.status).toBe("To Do");
		expect(statuses).toContain("To Do");

		// Test that we can create the task map
		const tasksById = new Map(localTasks.map((t) => [t.id, { ...t, source: "local" as const }]));
		expect(tasksById.size).toBe(1);
		expect(tasksById.get("TASK-1")?.title).toBe("Board Test Task");
	});
});
