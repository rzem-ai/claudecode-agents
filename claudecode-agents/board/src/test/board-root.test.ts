import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR, BOARD_ROOT_ENV, resolveBoardRoot } from "../board-root.ts";

describe("resolveBoardRoot with the environment variable", () => {
	it("uses the variable when it names a directory, without asking git", () => {
		const dir = mkdtempSync(join(tmpdir(), "board-root-"));
		try {
			expect(resolveBoardRoot({ [BOARD_ROOT_ENV]: dir }, "/")).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws a message naming the variable when the root is not a directory", () => {
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "/nonexistent/board-root" }, "/")).toThrow(BOARD_ROOT_ENV);
	});

	it("ignores a blank variable and falls through to discovery", () => {
		// "/" is not a repository, so discovery must say so rather than
		// resolving against the process cwd or a home directory.
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "  " }, "/")).toThrow("no board here");
	});

	it("names the directory constant in the no-board message", () => {
		const bare = mkdtempSync(join(tmpdir(), "no-board-"));
		mkdirSync(join(bare, "x"));
		try {
			expect(() => resolveBoardRoot({}, join(bare, "x"))).toThrow(BOARD_DIR);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});
