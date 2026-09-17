import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_ROOT_ENV, resolveBoardRoot } from "../board-root.ts";

describe("resolveBoardRoot", () => {
	it("uses the environment variable when it names a directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "board-root-"));
		try {
			expect(resolveBoardRoot({ [BOARD_ROOT_ENV]: dir })).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults to ~/.memory when the variable is unset or blank", () => {
		const home = mkdtempSync(join(tmpdir(), "board-home-"));
		try {
			const expected = join(home, ".memory");
			require("node:fs").mkdirSync(expected);
			expect(resolveBoardRoot({ HOME: home })).toBe(expected);
			expect(resolveBoardRoot({ HOME: home, [BOARD_ROOT_ENV]: "  " })).toBe(expected);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws a message naming the variable when the root is not a directory", () => {
		expect(() => resolveBoardRoot({ [BOARD_ROOT_ENV]: "/nonexistent/board-root" })).toThrow(BOARD_ROOT_ENV);
	});

	// With no variable and no home, the old code resolved ".memory" against the
	// process's cwd - the cwd-derived discovery the design forbids, and the one
	// way a board could appear inside a worktree.
	it("throws rather than resolving against the cwd when there is no home either", () => {
		expect(() => resolveBoardRoot({})).toThrow(BOARD_ROOT_ENV);
	});
});
