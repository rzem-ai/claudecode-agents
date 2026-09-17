/**
 * Task state vocabulary shared by the identity index, the content store and Core.
 *
 * Upstream this module also carried BranchTaskLoader, which indexed and hydrated tasks
 * from other local branches and from remote refs. The git layer is not carried, so the
 * loader is gone and only the record shape it produced remains: Core still builds these
 * entries from the local working copy.
 */

import type { Task } from "../types/index.ts";

export type TaskDirectoryType = "task" | "draft" | "archived" | "completed";

export interface BranchTaskStateEntry {
	id: string;
	type: TaskDirectoryType;
	lastModified: Date;
	branch: string;
	path: string;
	task?: Task;
}
