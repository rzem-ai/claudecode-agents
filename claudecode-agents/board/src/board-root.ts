import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The one place the board's location comes from. No walk-up, no git fallback, no --cwd. */
export const BOARD_ROOT_ENV = "CLAUDECODE_AGENTS_BOARD_ROOT";
/** The directory under the root that holds tasks, config and the rest. */
export const BOARD_DIR = "board";

export function resolveBoardRoot(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env[BOARD_ROOT_ENV]?.trim();
	let root: string;
	if (fromEnv && fromEnv.length > 0) {
		root = resolve(fromEnv);
	} else {
		// No explicit root and no home to default under. resolve("") would hand
		// back the current working directory, which is exactly the cwd-derived
		// discovery this module exists to refuse: run the binary from inside a
		// worktree and it would find or create a board there.
		const home = env.HOME ?? env.USERPROFILE ?? "";
		if (home.length === 0) {
			throw new Error(
				`no home directory to default the board root under; set ${BOARD_ROOT_ENV} to the memory tree`,
			);
		}
		root = resolve(join(home, ".memory"));
	}
	let isDirectory = false;
	try {
		isDirectory = statSync(root).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) {
		throw new Error(`board root is not a directory: ${root} (set ${BOARD_ROOT_ENV} to the memory tree)`);
	}
	return root;
}
