import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import { Core } from "../core/backlog.ts";
import { initializeProject } from "../core/init.ts";

describe("the git layer is not carried", () => {
	it("never auto-commits, whatever the config or the override says", async () => {
		const root = mkdtempSync(join(tmpdir(), "board-nogit-"));
		try {
			mkdirSync(join(root, DEFAULT_DIRECTORIES.BACKLOG));
			writeFileSync(
				join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"),
				'project_name: "t"\nauto_commit: true\nstatuses: ["To Do", "Done"]\n',
			);
			const core = new Core(root);
			expect(await core.shouldAutoCommit()).toBe(false);
			expect(await core.shouldAutoCommit(true)).toBe(false);
			const { task } = await core.createTaskFromInput({ title: "x" });
			expect(task.id).toBe("TASK-1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("initialises a project that asked for auto-commit, without writing or running it", async () => {
		const root = mkdtempSync(join(tmpdir(), "board-nogit-init-"));
		try {
			const core = new Core(root);
			await core.filesystem.ensureBacklogStructure();

			// The web InitializationScreen's auto-commit checkbox reaches init exactly like this.
			const result = await initializeProject(core, {
				projectName: "No git",
				integrationMode: "cli",
				agentInstructions: ["AGENTS.md"],
				advancedConfig: { autoCommit: true },
			});

			expect(result.success).toBe(true);
			for (const value of Object.values(result.mcpResults ?? {})) {
				expect(value).not.toContain("git layer not carried");
			}

			const configText = readFileSync(join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"), "utf8");
			expect(configText).not.toContain("auto_commit: true");
			expect(configText).toContain("auto_commit: false");
			expect((await core.filesystem.loadConfig())?.autoCommit).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
