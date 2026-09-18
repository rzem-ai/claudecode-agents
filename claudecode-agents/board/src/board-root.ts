import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Overrides discovery when set: the directory that contains `.boards/`. */
export const BOARD_ROOT_ENV = "CLAUDECODE_AGENTS_BOARD_ROOT";
/** The directory under the root that holds tasks, config and the rest. */
export const BOARD_DIR = ".boards";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The main checkout of the repository containing `cwd`, or null outside a
 * repository. A linked worktree's git dir is `<main>/.git/worktrees/<name>`,
 * and `--git-common-dir` answers `<main>/.git` from either, so the parent of
 * that is the main checkout in both cases. `--path-format=relative` keeps the
 * answer expressed against `cwd` rather than a realpath-resolved absolute
 * path, so a caller reached through a symlinked temp directory (macOS puts
 * `/tmp` and `/var/folders` behind one) still gets back the path it started
 * from instead of git's canonicalised equivalent. This is the one rule that
 * survives from the memory-tree design: a worktree carries a copy of
 * `.boards/` because it is committed, and nothing may write to that copy.
 */
export function mainCheckoutOf(cwd: string): string | null {
	const proc = Bun.spawnSync(
		["git", "-C", cwd, "rev-parse", "--path-format=relative", "--git-common-dir"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (proc.exitCode !== 0) return null;
	const common = proc.stdout.toString().trim();
	if (common.length === 0) return null;
	const absolute = resolve(cwd, common);
	return dirname(absolute);
}

/**
 * Where the board is. The environment variable wins when set; otherwise the
 * main checkout of the repository containing cwd, which must already hold a
 * `.boards/` directory. There is no fallback board.
 */
export function resolveBoardRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
	const fromEnv = env[BOARD_ROOT_ENV]?.trim();
	if (fromEnv && fromEnv.length > 0) {
		const root = resolve(fromEnv);
		if (!isDirectory(root)) {
			throw new Error(`board root is not a directory: ${root} (${BOARD_ROOT_ENV} names the directory that contains ${BOARD_DIR}/)`);
		}
		return root;
	}
	const main = mainCheckoutOf(cwd);
	if (main === null) {
		throw new Error(`no board here: ${cwd} is not inside a git repository, and there is no ${BOARD_DIR}/ without one`);
	}
	if (!isDirectory(join(main, BOARD_DIR))) {
		throw new Error(`no board here: ${main} has no ${BOARD_DIR}/ directory (run /init in that repository to create one)`);
	}
	return main;
}
