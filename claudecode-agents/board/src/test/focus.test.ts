import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";
import { clearFocus, readFocus, writeFocus } from "../core/focus.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let root = "";

function board(...args: string[]) {
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		env: { ...process.env, CLAUDECODE_AGENTS_BOARD_ROOT: root, CLAUDECODE_AGENTS_BOARD_NO_COMMIT: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "focus-"));
	mkdirSync(join(root, BOARD_DIR, "tasks"), { recursive: true });
	writeFileSync(
		join(root, BOARD_DIR, "config.yml"),
		'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Done"]\ndefault_status: "To Do"\n',
	);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("focus file", () => {
	it("round-trips one id and clears", () => {
		expect(readFocus(root)).toBeNull();
		writeFocus(root, "BD-7");
		expect(readFileSync(join(root, BOARD_DIR, ".focus"), "utf8")).toBe("BD-7\n");
		expect(readFocus(root)).toBe("BD-7");
		clearFocus(root);
		expect(existsSync(join(root, BOARD_DIR, ".focus"))).toBe(false);
	});
});

describe("board focus", () => {
	it("refuses an id that is not on the board", () => {
		const r = board("focus", "BD-99");
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("BD-99");
	});

	it("sets, shows and clears", () => {
		const id = JSON.parse(board("task", "create", "Focus me", "--json").out).task.id as string;
		expect(board("focus", id.toLowerCase()).out).toBe(id);
		expect(board("focus", "--show").out).toBe(id);
		expect(board("focus", "--clear").code).toBe(0);
		expect(board("focus", "--show").out).toBe("");
	});
});
