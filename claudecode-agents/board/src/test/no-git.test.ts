import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import { Core } from "../core/backlog.ts";

describe("outside a git repository", () => {
	it("still answers the config's auto_commit, but makes no commit since there is no repository to commit to", async () => {
		const root = mkdtempSync(join(tmpdir(), "board-nogit-"));
		try {
			mkdirSync(join(root, DEFAULT_DIRECTORIES.BACKLOG));
			writeFileSync(
				join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"),
				'project_name: "t"\nauto_commit: true\nstatuses: ["To Do", "Done"]\n',
			);
			const core = new Core(root);
			expect(await core.shouldAutoCommit()).toBe(true);
			expect(await core.shouldAutoCommit(true)).toBe(true);
			const { task } = await core.createTaskFromInput({ title: "x" });
			expect(task.id).toBe("TASK-1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
