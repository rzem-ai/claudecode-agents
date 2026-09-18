import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_DIR } from "../board-root.ts";

/**
 * The item this checkout's sessions are working on. One line at
 * `.boards/.focus`, ignored by git, written by `task_focus` or `board focus`
 * and read by the SubagentStart hook ahead of everything else. Per checkout,
 * not per session: that is a known limit, the same one the launch-time
 * variable had, and the `[board:<id>]` task marker still decides completion.
 */
export const FOCUS_FILE = ".focus";

function focusPath(root: string): string {
	return join(root, BOARD_DIR, FOCUS_FILE);
}

export function readFocus(root: string): string | null {
	const path = focusPath(root);
	if (!existsSync(path)) return null;
	const line = readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "";
	return line.length > 0 ? line : null;
}

export function writeFocus(root: string, id: string): void {
	mkdirSync(join(root, BOARD_DIR), { recursive: true });
	writeFileSync(focusPath(root), `${id}\n`);
}

export function clearFocus(root: string): void {
	rmSync(focusPath(root), { force: true });
}
