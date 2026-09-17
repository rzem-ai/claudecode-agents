// The git layer is not carried. Backlog.md's auto-commit, cross-branch resolution
// and remote fetches are all behind config.filesystemOnly, which
// file-system/operations.ts forces to true, so nothing below can be reached.
// The class exists so Core's type surface is unchanged; every method that would
// touch git throws, so a regression is loud rather than silent.
import type { BacklogConfig } from "../types/index.ts";

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

const NOT_CARRIED = "git layer not carried: this path must be unreachable under filesystemOnly";

export class GitOperations {
	constructor(
		public readonly projectRoot: string,
		_config: BacklogConfig | null = null,
		_configLoader?: () => Promise<BacklogConfig | null>,
	) {}

	setConfig(_config: BacklogConfig | null): void {}

	async getRepositoryRoot(_cwd?: string): Promise<string | null> {
		return null;
	}

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
		return false;
	}

	async addFile(_filePath: string): Promise<void> {
		throw new Error(NOT_CARRIED);
	}

	async addFiles(_filePaths: string[]): Promise<void> {
		throw new Error(NOT_CARRIED);
	}

	async stageFileMove(_fromPath: string, _toPath: string): Promise<string | null> {
		throw new Error(NOT_CARRIED);
	}

	async resetPaths(_filePaths: string[], _repoRoot?: string | null): Promise<void> {
		throw new Error(NOT_CARRIED);
	}

	async commitFiles(_message: string, _filePaths: string[], _repoRoot?: string | null): Promise<void> {
		throw new Error(NOT_CARRIED);
	}

	async commitTaskChange(_taskId: string, _message: string, _filePath: string): Promise<void> {
		throw new Error(NOT_CARRIED);
	}

	async addAndCommitTaskFile(
		_taskId: string,
		_filePath: string,
		_action: "create" | "update" | "archive",
		_onStaged?: (entries: GitIndexEntry[]) => void,
	): Promise<void> {
		throw new Error(NOT_CARRIED);
	}
}

export async function isGitRepository(_projectRoot: string): Promise<boolean> {
	return false;
}

export async function initializeGitRepository(_projectRoot: string): Promise<void> {
	throw new Error(NOT_CARRIED);
}
