// The git layer, carried in part from upstream Backlog.md.
//
// Only what a board that commits its own writes needs: add and commit,
// pathspec-limited to the board directory, an index-lock retry, and the
// repository root. Cross-branch task loading, remote fetches and everything
// else upstream's layer did stay out; the methods Core still calls for those
// return empty rather than throwing, so filesystem-only reads are unchanged.
import { BOARD_DIR } from "../board-root.ts";
import { FOCUS_FILE } from "../core/focus.ts";
import type { BacklogConfig } from "../types/index.ts";
import { escapeRegExp } from "./branch-ids.ts";
import { clearCommitNote, getCommitContext } from "./commit-context.ts";

/** The focus file is never part of a board commit; see `src/core/focus.ts`. */
const EXCLUDE_FOCUS = `:(exclude)${BOARD_DIR}/${FOCUS_FILE}`;

export interface GitBranchTip {
	name: string;
	commit: string;
	current: boolean;
}

export interface GitIndexEntry {
	mode: string;
	objectId: string;
	stage: number;
}

export const NO_COMMIT_ENV = "CLAUDECODE_AGENTS_BOARD_NO_COMMIT";
const LOCK_RETRIES = 3;
const LOCK_RETRY_MS = 300;

export function formatCommitSubject(id: string | undefined, note: string, by?: string): string {
	const head = id ? `board: ${id} ${note}` : `board: ${note}`;
	return by ? `${head} (${by})` : head;
}

function run(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitOperations {
	constructor(
		public readonly projectRoot: string,
		_config: BacklogConfig | null = null,
		_configLoader?: () => Promise<BacklogConfig | null>,
	) {}

	setConfig(_config: BacklogConfig | null): void {}

	async getRepositoryRoot(cwd?: string): Promise<string | null> {
		const r = run(cwd ?? this.projectRoot, ["rev-parse", "--show-toplevel"]);
		return r.code === 0 && r.out.length > 0 ? r.out : null;
	}

	/** Worktree copies of the board are never consulted, so there are none to list. */
	async listWorktreePaths(): Promise<string[]> {
		return [];
	}

	async getIndexEntries(_filePath: string): Promise<GitIndexEntry[]> {
		return [];
	}

	async restoreIndexEntriesIfMatches(
		_filePath: string,
		_expectedEntries: readonly GitIndexEntry[],
		_restoreEntries: readonly GitIndexEntry[],
	): Promise<boolean> {
		return true;
	}

	/**
	 * The one commit routine. `git add -- .boards` then `git commit -- .boards`,
	 * so the human's own staged work stays out of it, with `.boards/.focus`
	 * excluded from every one of those pathspecs (add, diff --cached, commit,
	 * reset): it is a per-checkout binding, never a thing to commit, and a
	 * repository that has not run init has no `.gitignore` entry to protect it,
	 * so the binary excludes it itself. Skipped, quietly, when the
	 * env var says so, .boards is ignored, or the add produced no staged change
	 * (decided from the index with `git diff --cached`, never by matching git's
	 * prose, which varies with untracked files present); retried on a locked
	 * index; logged and false on anything else. Every branch that leaves the
	 * loop after a successful `add` first runs `git reset -- .boards`, so a
	 * commit that cannot be made never leaves .boards sitting in the human's
	 * index (a mid-merge commit is the case that matters: git refuses a partial
	 * commit there, and the add must not survive that refusal). The file write
	 * has already happened either way. The commit note is always cleared here,
	 * win or lose, so a later write in the same process is never labelled with
	 * this one's note; `by` is left alone, since a long-lived caller such as the
	 * MCP server sets it once and every commit it makes should still carry it.
	 */
	async commitBoard(note: string, taskId?: string): Promise<boolean> {
		try {
			if (process.env[NO_COMMIT_ENV] === "1") return false;
			const root = await this.getRepositoryRoot();
			if (!root) return false;
			if (run(this.projectRoot, ["check-ignore", "-q", BOARD_DIR]).code === 0) return false;
			const ctx = getCommitContext();
			const subject = formatCommitSubject(taskId, ctx.note ?? note, ctx.by);
			for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
				const add = run(this.projectRoot, ["add", "--", BOARD_DIR, EXCLUDE_FOCUS]);
				if (add.code !== 0 && /index\.lock/.test(add.err)) {
					await sleep(LOCK_RETRY_MS);
					continue;
				}
				if (add.code !== 0) {
					console.error(`board: commit skipped (git add): ${add.err}`);
					return false;
				}
				// A no-op write (a status set to what it already was, the second
				// commitFiles of a multi-step archive) stages nothing to commit.
				// Decide that from the index, not from git's commit-failure prose.
				const diff = run(this.projectRoot, ["diff", "--cached", "--quiet", "--", BOARD_DIR, EXCLUDE_FOCUS]);
				if (diff.code === 0) return false;
				const commit = run(this.projectRoot, ["commit", "-q", "-m", subject, "--", BOARD_DIR, EXCLUDE_FOCUS]);
				if (commit.code === 0) return true;
				// Returns the .boards index to HEAD, so a human who had deliberately
				// staged a .boards change of their own finds it unstaged again but
				// intact in the working tree, not swallowed by the failed commit.
				run(this.projectRoot, ["reset", "-q", "--", BOARD_DIR, EXCLUDE_FOCUS]);
				if (/index\.lock/.test(commit.err)) {
					await sleep(LOCK_RETRY_MS);
					continue;
				}
				console.error(`board: commit skipped (git commit): ${commit.err || commit.out}`);
				return false;
			}
			console.error(`board: commit skipped: the index stayed locked for ${LOCK_RETRIES} attempts`);
			return false;
		} finally {
			clearCommitNote();
		}
	}

	async addFile(_filePath: string): Promise<void> {}

	async addFiles(_filePaths: string[]): Promise<void> {}

	async stageFileMove(_fromPath: string, _toPath: string): Promise<string | null> {
		return this.getRepositoryRoot();
	}

	async resetPaths(_filePaths: string[], _repoRoot?: string | null): Promise<void> {}

	async commitFiles(message: string, _filePaths: string[], _repoRoot?: string | null): Promise<void> {
		await this.commitBoard(message.replace(/^backlog:\s*/i, ""));
	}

	async commitTaskChange(taskId: string, message: string, _filePath: string): Promise<void> {
		const note = message.replace(new RegExp(`^(Create|Update) (draft )?${escapeRegExp(taskId)}$`), (_m, verb) =>
			verb === "Create" ? "created" : "updated",
		);
		await this.commitBoard(note, taskId);
	}

	async addAndCommitTaskFile(
		taskId: string,
		_filePath: string,
		action: "create" | "update" | "archive",
		_onStaged?: (entries: GitIndexEntry[]) => void,
	): Promise<void> {
		const note = action === "create" ? "created" : action === "update" ? "updated" : "archived";
		await this.commitBoard(note, taskId);
	}
}

export async function isGitRepository(projectRoot: string): Promise<boolean> {
	return run(projectRoot, ["rev-parse", "--is-inside-work-tree"]).code === 0;
}

export async function initializeGitRepository(_projectRoot: string): Promise<void> {
	throw new Error("the board never initialises a repository; /init does");
}
