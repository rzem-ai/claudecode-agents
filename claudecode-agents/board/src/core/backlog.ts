import { rename as moveFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { resolveBoardRoot } from "../board-root.ts";
import { DEFAULT_DIRECTORIES, DEFAULT_STATUSES, FALLBACK_STATUS } from "../constants/index.ts";
import {
	type DraftFileReference,
	FileSystem,
	isConfigValueError,
	isCreateLockError,
} from "../file-system/operations.ts";
import { type GitIndexEntry, GitOperations } from "../git/operations.ts";
import { parseFrontmatter } from "../markdown/frontmatter.ts";
import { assertSectionInputHasNoMarkerLines } from "../markdown/structured-sections.ts";
import {
	type AcceptanceCriterion,
	type BacklogConfig,
	type Decision,
	DOCUMENT_TYPE_VALUES,
	type Document,
	type DocumentCreateInput,
	type DocumentType,
	type DocumentUpdateInput,
	EntityType,
	isLocalEditableTask,
	type Milestone,
	type SearchFilters,
	type Task,
	type TaskCommentInput,
	type TaskCreateInput,
	type TaskListFilter,
	type TaskUpdateInput,
} from "../types/index.ts";
import { normalizeAssignee } from "../utils/assignee.ts";
import { findDocumentById, normalizeDocumentId } from "../utils/document-id.ts";
import {
	getDocumentSubPathFromRelativePath,
	normalizeDocumentRelativePath,
	normalizeDocumentSubPath,
} from "../utils/document-path.ts";
import { normalizeDueDate } from "../utils/due-date.ts";
import { generateNextDecisionId, generateNextDocId } from "../utils/id-generators.ts";
import { createMilestoneFilterValueResolver } from "../utils/milestone-filter.ts";
import {
	buildGlobPattern,
	buildIdRegex,
	generateNextId as generateNextPrefixedId,
	generateNextSubtaskId,
	getPrefixForType,
	normalizeId,
} from "../utils/prefix-config.ts";
import { formatValidPriorityValues, resolvePriorityValue } from "../utils/priority-config.ts";
import {
	formatValidProjectValues,
	getProjectValues,
	noProjectsConfiguredMessage,
	resolveProjectValue,
} from "../utils/project-config.ts";
import {
	getCanonicalStatus as resolveCanonicalStatus,
	getValidStatuses as resolveValidStatuses,
} from "../utils/status.ts";
import { executeStatusCallback } from "../utils/status-callback.ts";
import {
	buildDefinitionOfDoneItems,
	normalizeStringList,
	parseDelimitedStringList,
	stringArraysEqual,
	validateDependencies,
} from "../utils/task-builders.ts";
import { withoutVacatedTaskLinks } from "../utils/task-links.ts";
import {
	AmbiguousTaskIdError,
	canonicalTaskId,
	extractDraftIdFromFilename,
	getTaskPath,
	LOCAL_TASK_LOOKUP_HINT,
	normalizeTaskId,
	taskIdsEqual,
} from "../utils/task-path.ts";
import { applyTaskFilters, createTaskSearchIndex } from "../utils/task-search.ts";
import { sortByOrdinal } from "../utils/task-sorting.ts";
import { attachSubtaskSummaries } from "../utils/task-subtasks.ts";
import { formatValidTaskTypeValues, resolveTaskTypeValue } from "../utils/task-type-config.ts";
import { isTerminalStatus } from "../utils/terminal-status.ts";
import { ContentStore, type TaskCorpusSnapshot } from "./content-store.ts";
import {
	calculateBlockOrdinals,
	calculateNewOrdinal,
	DEFAULT_ORDINAL_STEP,
	resolveOrdinalConflicts,
} from "./reorder.ts";
import { SearchService } from "./search-service.ts";
import { TaskIdentityIndex, type TaskIdentityRecord } from "./task-identity-index.ts";
import type { BranchTaskStateEntry } from "./task-loader.ts";

interface CreatedTaskWrite {
	filePath: string;
	createdContent: Buffer;
	previousPath: string | null;
	previousContent: Buffer | null;
	previousIndexEntries?: GitIndexEntry[];
	generatedIndexEntries?: GitIndexEntry[];
}

interface CreatedTaskRollbackResult {
	indexRestored: boolean;
	workingPathRestored: boolean;
}

interface TaskCorpusLoadOptions {
	progressCallback?: (msg: string) => void;
	abortSignal?: AbortSignal;
	includeCompleted?: boolean;
	visibleCompleted?: boolean;
	/** Set only by the ContentStore corpus loader, whose result becomes the shared task state. */
	publishSharedState?: boolean;
}

/**
 * `includeCrossBranch` no longer selects between branches - the git layer is not carried, so
 * every task is local. It still selects between two readers: the shared ContentStore corpus
 * (true, the default) and a throwaway index built straight off the working copy (false).
 */
interface TaskQueryOptions {
	filters?: TaskListFilter;
	query?: string;
	limit?: number;
	includeCrossBranch?: boolean;
	refreshCrossBranch?: boolean;
}

interface TaskReadOptions {
	includeCrossBranch?: boolean;
	refreshCrossBranch?: boolean;
}

/** Sanitized copies of the records that referenced a task ID being vacated, by corpus. */
type VacatedIdCleanup = {
	active: Task[];
	completed: Task[];
};

function vacatedIdCleanupTargets(cleanup: VacatedIdCleanup): Task[] {
	return [...cleanup.active, ...cleanup.completed];
}

function sanitizeVacatedTaskLinks(tasks: Task[], vacatedTaskId: string): Task[] {
	return tasks
		.map((task) => withoutVacatedTaskLinks(task, vacatedTaskId))
		.filter((task): task is Task => task !== null);
}

/** How many times a vacating operation re-takes its locks before giving up on a stable set. */
const VACATED_ID_CLEANUP_LOCK_ATTEMPTS = 5;

/**
 * Tag a failure that happened after the record had already been moved, so callers report the state
 * the project is actually in instead of an error that reads as "nothing happened" and invites a
 * retry of a mutation that already ran.
 */
function markRecordAlreadyMoved(
	error: unknown,
	state: "archiveState" | "demotionState",
	demotionFailureCause?: "cleanup" | "commit",
): Error {
	const failure = error instanceof Error ? error : new Error(String(error));
	(failure as Error & Record<string, unknown>)[state] = "moved";
	if (state === "demotionState" && demotionFailureCause) {
		(failure as Error & Record<string, unknown>).demotionFailureCause = demotionFailureCause;
	}
	return failure;
}

/**
 * Outcome of an operation that vacates a task ID. `cleanedTaskIds` names the records that lost a
 * stored reference to it, so every surface can report the change instead of making it silently.
 */
export interface VacatedTaskResult {
	success: boolean;
	cleanedTaskIds: string[];
}

interface TaskEditResult {
	task: Task;
	cleanedTaskIds: string[];
}

function buildUpdatedDateComparableTask(task: Task): Record<string, unknown> {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		assignee: task.assignee ?? [],
		reporter: task.reporter,
		createdDate: task.createdDate,
		dueDate: task.dueDate,
		labels: task.labels ?? [],
		milestone: task.milestone,
		dependencies: task.dependencies ?? [],
		references: task.references ?? [],
		documentation: task.documentation ?? [],
		modifiedFiles: task.modifiedFiles ?? [],
		rawContent: task.rawContent ?? "",
		description: task.description,
		implementationPlan: task.implementationPlan,
		implementationNotes: task.implementationNotes,
		comments: task.comments ?? [],
		finalSummary: task.finalSummary,
		acceptanceCriteriaItems: task.acceptanceCriteriaItems ?? [],
		definitionOfDoneItems: task.definitionOfDoneItems ?? [],
		parentTaskId: task.parentTaskId,
		subtasks: task.subtasks ?? [],
		priority: task.priority,
		type: task.type,
		project: task.project,
		onStatusChange: task.onStatusChange,
	};
}

function hasUpdatedDateRelevantChanges(originalTask: Task | null, nextTask: Task): boolean {
	if (!originalTask) {
		return true;
	}

	return (
		JSON.stringify(buildUpdatedDateComparableTask(originalTask)) !==
		JSON.stringify(buildUpdatedDateComparableTask(nextTask))
	);
}

function normalizeDocumentTypeInput(type: unknown): DocumentType | undefined {
	if (type === undefined) {
		return undefined;
	}
	if (typeof type === "string" && (DOCUMENT_TYPE_VALUES as readonly string[]).includes(type)) {
		return type as DocumentType;
	}
	throw new Error(`Document type must be one of: ${DOCUMENT_TYPE_VALUES.join(", ")}.`);
}

function formatAvailableIndexHint(items: AcceptanceCriterion[], emptyMessage: string): string {
	if (items.length === 0) {
		return emptyMessage;
	}
	const indexes = items.map((item) => item.index).sort((a, b) => a - b);
	const first = indexes[0] ?? 1;
	const last = indexes[indexes.length - 1] ?? first;
	const range = first === last ? `#${first}` : `#${first}-#${last}`;
	return `Available indexes: ${range}.`;
}

/** Dependencies are validated against the working copy on both the create and the edit path. */
function formatMissingDependenciesError(invalid: string[]): Error {
	return new Error(
		`The following dependencies do not exist: ${invalid.join(", ")}. Please create these tasks first or verify the IDs. ${LOCAL_TASK_LOOKUP_HINT}`,
	);
}

/**
 * A board move rewrites the task file, so a task that belongs to another branch can only be moved
 * from that branch. Returns the reason to report, or null when the task is local and writable.
 */
function crossBranchMoveReason(task: Task, verb: "reordered" | "moved"): string | null {
	if (!task.branch) return null;
	return `Task ${task.id} exists in branch "${task.branch}" and cannot be ${verb} from the current branch. Switch to that branch to modify it.`;
}

/**
 * Normalize the milestone a board move targets. A named lane stores its trimmed name, while the
 * board's no-milestone lane arrives as null or a blank string and clears the field.
 */
function normalizeTargetMilestone(targetMilestone: string | null | undefined): string | undefined {
	if (typeof targetMilestone !== "string") return undefined;
	const trimmed = targetMilestone.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Structured-section input that contains its own sentinel marker as a whole
 * line is rejected before any write: wrapping it would nest markers and hide
 * the stored content from every reader (GitHub issue #932).
 */
function assertSectionInputsSafe(input: {
	description?: string;
	implementationPlan?: string;
	implementationNotes?: string;
	finalSummary?: string;
	appendImplementationPlan?: string[];
	appendImplementationNotes?: string[];
	appendFinalSummary?: string[];
}): void {
	assertSectionInputHasNoMarkerLines(input.description, "description");
	assertSectionInputHasNoMarkerLines(input.implementationPlan, "implementationPlan");
	assertSectionInputHasNoMarkerLines(input.implementationNotes, "implementationNotes");
	assertSectionInputHasNoMarkerLines(input.finalSummary, "finalSummary");
	for (const value of input.appendImplementationPlan ?? []) {
		assertSectionInputHasNoMarkerLines(value, "implementationPlan");
	}
	for (const value of input.appendImplementationNotes ?? []) {
		assertSectionInputHasNoMarkerLines(value, "implementationNotes");
	}
	for (const value of input.appendFinalSummary ?? []) {
		assertSectionInputHasNoMarkerLines(value, "finalSummary");
	}
}

export class Core {
	public fs: FileSystem;
	public git: GitOperations;
	private contentStore?: ContentStore;
	private searchService?: SearchService;
	private readonly enableWatchers: boolean;
	private projectGeneration = 0;
	/** Settings key of the corpus a load last installed as the ContentStore's shared state. */
	private sharedTaskStateKey: string | null = null;
	private sharedTaskStateRefreshPromise: Promise<void> | null = null;

	constructor(projectRoot: string, options?: { enableWatchers?: boolean }) {
		this.fs = new FileSystem(projectRoot);
		this.git = new GitOperations(projectRoot, null, () => this.fs.loadConfig());
		// Disable watchers by default for CLI commands (non-interactive)
		// Interactive modes (TUI, browser, MCP) should explicitly pass enableWatchers: true
		this.enableWatchers = options?.enableWatchers ?? false;
		// Note: Config is loaded lazily when needed since constructor can't be async
	}

	private async buildTaskIdentityIndex(
		localTasks: Array<Task & { lastModified?: Date }>,
		completedTasks: Task[],
		branchRecords: BranchTaskStateEntry[],
		statuses: string[],
		resolutionStrategy: "most_recent" | "most_progressed",
		repositoryRoot?: string | null,
		filesystem = this.fs,
		git = this.git,
	): Promise<TaskIdentityIndex> {
		const records: TaskIdentityRecord[] = [];
		for (const task of localTasks) {
			records.push({
				id: task.id,
				type: "task",
				branch: "local",
				path: task.filePath ?? join(filesystem.tasksDir, task.id),
				lastModified: task.lastModified ?? (task.updatedDate ? new Date(task.updatedDate) : new Date(0)),
				task: { ...task, source: "local" },
				workingCopy: true,
			});
		}
		for (const task of completedTasks) {
			records.push({
				id: task.id,
				type: "completed",
				branch: "local",
				path: task.filePath ?? join(filesystem.completedDir, task.id),
				lastModified: task.lastModified ?? (task.updatedDate ? new Date(task.updatedDate) : new Date(0)),
				task: { ...task, source: "completed" },
				workingCopy: true,
			});
		}
		records.push(...branchRecords);

		return new TaskIdentityIndex(
			records,
			{
				repositoryRoot: repositoryRoot === undefined ? await git.getRepositoryRoot() : repositoryRoot,
				projectRoot: filesystem.rootDir,
				backlogDirectory: filesystem.backlogDirName,
			},
			statuses,
			resolutionStrategy,
		);
	}

	async withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
		return await this.fs.withCreateLock(fn);
	}

	private async resolveCreateOrdinal(inputOrdinal: number | undefined, isDraft: boolean): Promise<number | undefined> {
		if (typeof inputOrdinal === "number") {
			return inputOrdinal;
		}
		if (isDraft) {
			return undefined;
		}

		const tasks = await this.fs.listTasks();
		const ordinals = tasks
			.map((task) => task.ordinal)
			.filter((ordinal): ordinal is number => typeof ordinal === "number" && Number.isFinite(ordinal));

		if (ordinals.length === 0) {
			return tasks.length === 0 ? DEFAULT_ORDINAL_STEP : undefined;
		}

		return Math.max(...ordinals) + DEFAULT_ORDINAL_STEP;
	}

	async getContentStore(progressCallback?: (message: string) => void): Promise<ContentStore> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			let store = this.contentStore;
			if (!store) {
				// Use loadTasks as the task loader to include cross-branch tasks
				store = new ContentStore(
					filesystem,
					(callback, options) => this.loadContentStoreCorpus(callback, options),
					this.enableWatchers,
				);
				this.contentStore = store;
			}

			try {
				await store.ensureInitialized(progressCallback);
			} catch (error) {
				if (
					generation !== this.projectGeneration ||
					filesystem !== this.fs ||
					backlogRoot !== filesystem.backlogDir ||
					store !== this.contentStore
				) {
					continue;
				}
				throw error;
			}
			if (
				generation === this.projectGeneration &&
				filesystem === this.fs &&
				backlogRoot === filesystem.backlogDir &&
				store === this.contentStore
			) {
				return store;
			}
		}
	}

	async getSearchService(): Promise<SearchService> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const store = await this.getContentStore();
			if (
				generation !== this.projectGeneration ||
				filesystem !== this.fs ||
				backlogRoot !== filesystem.backlogDir ||
				store !== this.contentStore
			) {
				continue;
			}
			let searchService = this.searchService;
			if (!searchService) {
				searchService = new SearchService(store);
				this.searchService = searchService;
			}
			try {
				await searchService.ensureInitialized();
			} catch (error) {
				if (
					generation !== this.projectGeneration ||
					filesystem !== this.fs ||
					backlogRoot !== filesystem.backlogDir ||
					store !== this.contentStore ||
					searchService !== this.searchService
				) {
					continue;
				}
				throw error;
			}
			if (
				generation === this.projectGeneration &&
				filesystem === this.fs &&
				backlogRoot === filesystem.backlogDir &&
				store === this.contentStore &&
				searchService === this.searchService
			) {
				return searchService;
			}
		}
	}

	private async refreshCachedTasksForStoreRead(useSharedStore: boolean, storeAlreadyExisted: boolean): Promise<void> {
		const store = this.contentStore;
		if (!storeAlreadyExisted || !this.enableWatchers || !useSharedStore || !store) {
			return;
		}

		await this.refreshTasksForTaskRead();
	}

	/**
	 * The settings a shared corpus is built under. Upstream this also carried the branch-scan
	 * knobs and the active branch tips; the git layer is not carried, so what remains is the
	 * config a read can be stale against - the task prefix, resolution strategy, status set and
	 * backlog directory.
	 */
	private getTaskCorpusSettingsKey(config: BacklogConfig | null, filesystem = this.fs): string {
		return JSON.stringify({
			taskPrefix: config?.prefixes?.task ?? "task",
			taskResolutionStrategy: config?.taskResolutionStrategy ?? "most_progressed",
			statuses: config?.statuses ?? DEFAULT_STATUSES,
			backlogDir: filesystem.backlogDirName,
		});
	}

	/**
	 * Refresh the shared task corpus for a read. Upstream this compared a fingerprint of the
	 * active branch tips as well; with the git layer gone a read can only be stale against the
	 * local working copy and the config, so an unchanged settings key means a local refresh and
	 * "nothing new".
	 */
	async refreshTasksForTaskRead(): Promise<boolean> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const projectChanged = () =>
				generation !== this.projectGeneration || filesystem !== this.fs || backlogRoot !== filesystem.backlogDir;
			const config = await filesystem.loadConfig();
			if (projectChanged()) continue;
			const settingsKey = this.getTaskCorpusSettingsKey(config, filesystem);
			if (settingsKey === this.sharedTaskStateKey) {
				const store = this.contentStore;
				if (store?.isInitialized()) await store.refreshLocalTaskCorpus();
				if (projectChanged()) continue;
				return false;
			}

			const joinedExistingRefresh = this.sharedTaskStateRefreshPromise !== null;
			if (!this.sharedTaskStateRefreshPromise) {
				const refreshExistingStore = this.contentStore !== undefined;
				const refreshPromise = (async () => {
					const store = await this.getContentStore();
					if (refreshExistingStore) await store.refreshTasks();
				})();
				this.sharedTaskStateRefreshPromise = refreshPromise;
				const clearRefreshPromise = () => {
					if (this.sharedTaskStateRefreshPromise === refreshPromise) {
						this.sharedTaskStateRefreshPromise = null;
					}
				};
				void refreshPromise.then(clearRefreshPromise, clearRefreshPromise);
			}

			const refreshPromise = this.sharedTaskStateRefreshPromise;
			await refreshPromise;
			if (projectChanged()) continue;
			if (joinedExistingRefresh && this.sharedTaskStateKey !== settingsKey) continue;
			return true;
		}
	}

	private filterLocalEditableTasks(tasks: Task[]): Task[] {
		return tasks.filter(isLocalEditableTask);
	}

	private async requireCanonicalStatus(status: string): Promise<string> {
		const canonical = await resolveCanonicalStatus(status, this);
		if (canonical) {
			return canonical;
		}
		const validStatuses = await resolveValidStatuses(this);
		throw new Error(`Invalid status: ${status}. Valid statuses are: ${validStatuses.join(", ")}`);
	}

	private async normalizePriority(value: string | undefined): Promise<string | undefined> {
		if (value === undefined || value.trim() === "") {
			return undefined;
		}
		const config = await this.fs.loadConfig();
		const normalized = resolvePriorityValue(value, config);
		if (!normalized) {
			throw new Error(`Invalid priority: ${value}. Valid values are: ${formatValidPriorityValues(config)}`);
		}
		return normalized;
	}

	private async normalizeTaskType(value: string | undefined): Promise<string | undefined> {
		if (value === undefined || value === "") {
			return undefined;
		}
		const config = await this.fs.loadConfig();
		const canonical = resolveTaskTypeValue(value, config);
		if (!canonical) {
			throw new Error(`Invalid type: ${value}. Valid types are: ${formatValidTaskTypeValues(config)}`);
		}
		return canonical;
	}

	private async normalizeProject(value: string | undefined): Promise<string | undefined> {
		if (value === undefined || value === "") {
			return undefined;
		}
		const config = await this.fs.loadConfig();
		const configuredProjects = getProjectValues(config);
		if (configuredProjects.length === 0) {
			throw new Error(noProjectsConfiguredMessage(this.fs.configFilePath));
		}
		const canonical = resolveProjectValue(value, config);
		if (!canonical) {
			throw new Error(`Invalid project: ${value}. Valid projects are: ${formatValidProjectValues(config)}`);
		}
		return canonical;
	}

	/**
	 * Collect the records that name a task ID which archiving or demoting is about to vacate.
	 *
	 * Both operations free the numeric slot for the allocator, so a reference left behind stops
	 * meaning what it said: once the ID is handed to the next created task, the stale reference
	 * silently resolves to an unrelated task instead of failing closed. The scan covers the active
	 * working copy and the completed corpus, because a completed record is still read by the
	 * dependency graph. Drafts keep their references: they are not part of either corpus, and
	 * archive has never touched them.
	 */
	private async collectVacatedIdCleanup(vacatedTaskId: string): Promise<VacatedIdCleanup> {
		const [activeTasks, completedTasks] = await Promise.all([this.fs.listTasks(), this.fs.listCompletedTasks()]);
		const others = (tasks: Task[]) => tasks.filter((task) => !taskIdsEqual(task.id, vacatedTaskId));
		return {
			active: sanitizeVacatedTaskLinks(others(activeTasks), vacatedTaskId),
			completed: sanitizeVacatedTaskLinks(others(completedTasks), vacatedTaskId),
		};
	}

	/**
	 * Run a vacating operation while holding the record's lock and the lock of every task that
	 * references the ID it is about to free.
	 *
	 * The set cannot be known without reading the corpus, and a set read before the locks are held
	 * is only a guess: a dependent edited in that window would be rewritten from the pre-edit
	 * snapshot, losing that edit, and a task that started referencing the ID in that window would
	 * not be locked and would keep the reference the operation exists to remove. So the scan is
	 * repeated inside the locks, and a scan naming a task the held locks do not cover releases
	 * them and runs again over the wider set. Widening only ever adds tasks, and the locks are
	 * always taken through {@link FileSystem.withTaskLocks}, which sorts them, so retrying
	 * cannot deadlock against another operation. `run` therefore only ever sees a set that was
	 * read, and is locked, as one consistent state.
	 *
	 * What this does not close: a task that starts referencing the ID after that final in-lock
	 * scan cannot be locked, because it was not yet a dependent when the set was fixed, so it
	 * keeps its reference. Locking cannot close that on its own without a corpus-wide write lock,
	 * and vacating before the scan does not close it either: an archived ID still resolves as a
	 * dependency target by design, so the write that adds it is still accepted after the move.
	 * The stale reference that results is not silent - it renders as an unknown task ID until the
	 * allocator hands the number out again.
	 */
	private async withVacatedIdCleanup<T>(
		target: Pick<Task, "id" | "filePath">,
		vacatedTaskId: string,
		run: (cleanup: VacatedIdCleanup) => Promise<T>,
	): Promise<T> {
		let candidates = vacatedIdCleanupTargets(await this.collectVacatedIdCleanup(vacatedTaskId));

		for (let attempt = 0; attempt < VACATED_ID_CLEANUP_LOCK_ATTEMPTS; attempt++) {
			// Use the same identity relation as the corpus scan. In particular, a bare ID and the
			// configured-prefix spelling it resolves against must not cause pointless widening.
			const coversLock = (task: Task) => candidates.some((candidate) => taskIdsEqual(candidate.id, task.id));
			const outcome = await this.fs.withTaskLocks(
				[target, ...candidates],
				async (): Promise<{ value: T } | { widened: Task[] }> => {
					const cleanup = await this.collectVacatedIdCleanup(vacatedTaskId);
					const targets = vacatedIdCleanupTargets(cleanup);
					if (targets.some((task) => !coversLock(task))) {
						return { widened: targets };
					}
					return { value: await run(cleanup) };
				},
			);
			if ("value" in outcome) return outcome.value;
			candidates = outcome.widened;
		}

		throw new Error(
			`Could not take a stable set of task locks to clean references to ${vacatedTaskId}. Retry once the tasks referencing it stop changing.`,
		);
	}

	/**
	 * Write the sanitized records. Callers hold the task locks for every one of them, taken with
	 * the operation's own lock so the mutation is one span.
	 *
	 * Every record is written to the path it was selected from, never through {@link updateTask}:
	 * that path re-resolves the record by ID, which throws on a contested identity and would fail
	 * the cleanup after the target had already been vacated. The scan already chose the exact files,
	 * and a completed record must not go through {@link updateTask} anyway - it would not be found
	 * in the active corpus and the write would look like a brand-new task whose status just changed.
	 */
	private async writeVacatedIdCleanup(cleanup: VacatedIdCleanup): Promise<{
		cleanedTaskIds: string[];
		filePaths: string[];
	}> {
		const filePaths: string[] = [];
		const updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");
		const writeAll = async () => {
			for (const task of cleanup.active) {
				const updated = { ...task, updatedDate };
				const savedPath = await this.fs.saveTask(updated);
				filePaths.push(savedPath);
				this.contentStore?.upsertTask({ ...updated, filePath: savedPath });
			}
			for (const task of cleanup.completed) {
				const updated = { ...task, updatedDate };
				const savedPath = await this.fs.saveTask(updated);
				filePaths.push(savedPath);
				// The record stays completed, with the reference gone. Refresh exactly this file in any
				// in-process ContentStore: a record elsewhere claiming the same ID is a conflict this
				// cleanup has no business dissolving.
				this.contentStore?.refreshCompletedTask({ ...updated, filePath: savedPath });
			}
		};
		// One notification for the whole cleanup, as the bulk writer does for a batch of edits.
		if (this.contentStore) await this.contentStore.batchTaskUpdates(writeAll);
		else await writeAll();
		return { cleanedTaskIds: vacatedIdCleanupTargets(cleanup).map((task) => task.id), filePaths };
	}

	async queryTasks(options: TaskQueryOptions = {}): Promise<Task[]> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const projectChanged = () =>
				generation !== this.projectGeneration || filesystem !== this.fs || backlogRoot !== filesystem.backlogDir;
			const { filters, query, limit } = options;
			const trimmedQuery = query?.trim();
			const includeCrossBranch = options.includeCrossBranch ?? true;
			const milestoneResolverPromise = filters?.milestone
				? Promise.all([filesystem.listMilestones(), filesystem.listArchivedMilestones()]).then(
						([activeMilestones, archivedMilestones]) =>
							createMilestoneFilterValueResolver([...activeMilestones, ...archivedMilestones]),
					)
				: undefined;

			const applyFiltersAndLimit = async (collection: Task[]): Promise<Task[]> => {
				const resolveMilestoneLabel = milestoneResolverPromise ? await milestoneResolverPromise : undefined;
				let filtered = filters ? applyTaskFilters(collection, { ...filters, resolveMilestoneLabel }) : [...collection];
				if (!includeCrossBranch) {
					filtered = this.filterLocalEditableTasks(filtered);
				}
				if (typeof limit === "number" && limit >= 0) {
					return filtered.slice(0, limit);
				}
				return filtered;
			};

			if (!includeCrossBranch) {
				const localTasks = await filesystem.listTasks();
				if (projectChanged()) continue;
				const tasks = trimmedQuery ? createTaskSearchIndex(localTasks).search({ query: trimmedQuery }) : localTasks;
				const filteredTasks = await applyFiltersAndLimit(tasks);
				if (projectChanged()) continue;
				return filteredTasks;
			}

			const storeAlreadyReady = this.contentStore?.isInitialized() ?? false;
			const store = await this.getContentStore();
			if (projectChanged() || store !== this.contentStore) continue;
			await this.refreshCachedTasksForStoreRead(
				includeCrossBranch,
				storeAlreadyReady && options.refreshCrossBranch !== false,
			);
			if (projectChanged() || store !== this.contentStore) continue;

			if (!trimmedQuery) {
				const filteredTasks = await applyFiltersAndLimit(store.getTasks());
				if (projectChanged() || store !== this.contentStore) continue;
				return filteredTasks;
			}

			const searchService = await this.getSearchService();
			if (projectChanged() || store !== this.contentStore) continue;
			const searchFilters: SearchFilters = {};
			if (filters?.status) {
				searchFilters.status = filters.status;
			}
			if (filters?.excludeStatus) {
				searchFilters.excludeStatus = filters.excludeStatus;
			}
			if (filters?.type) {
				searchFilters.type = filters.type;
			}
			if (filters?.project) {
				searchFilters.project = filters.project;
			}
			if (filters?.priority) {
				searchFilters.priority = filters.priority;
			}
			if (filters?.assignee) {
				searchFilters.assignee = filters.assignee;
			}
			if (filters?.labels) {
				searchFilters.labels = filters.labels;
				searchFilters.labelMatch = filters.labelMatch;
			}

			const searchResults = searchService.search({
				query: trimmedQuery,
				limit,
				types: ["task"],
				filters: Object.keys(searchFilters).length > 0 ? searchFilters : undefined,
			});

			const seen = new Set<string>();
			const tasks: Task[] = [];
			for (const result of searchResults) {
				if (result.type !== "task") continue;
				const task = result.task;
				if (seen.has(task.id)) continue;
				seen.add(task.id);
				tasks.push(task);
			}

			const filteredTasks = await applyFiltersAndLimit(tasks);
			if (projectChanged() || store !== this.contentStore) continue;
			return filteredTasks;
		}
	}

	async getTask(taskId: string, options: TaskReadOptions = {}): Promise<Task | null> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const projectChanged = () =>
				generation !== this.projectGeneration || filesystem !== this.fs || backlogRoot !== filesystem.backlogDir;
			const storeAlreadyReady = this.contentStore?.isInitialized() ?? false;
			const store = await this.getContentStore();
			if (projectChanged() || store !== this.contentStore) continue;
			if (storeAlreadyReady && options.refreshCrossBranch !== false) {
				await this.refreshTasksForTaskRead();
			}
			if (projectChanged() || store !== this.contentStore) continue;
			const identityResolution = store.resolveTaskForRead(taskId);
			if (identityResolution.status === "ambiguous") {
				throw new AmbiguousTaskIdError(taskId, identityResolution.candidates);
			}
			return identityResolution.status === "found" ? identityResolution.task : null;
		}
	}

	async getTaskWithSubtasks(taskId: string, localTasks?: Task[], options: TaskReadOptions = {}): Promise<Task | null> {
		while (true) {
			const generation = this.projectGeneration;
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const task =
				options.includeCrossBranch === false
					? await this.loadWorkingCopyTask(taskId, false, localTasks)
					: await this.getTask(taskId, options);
			if (generation !== this.projectGeneration || filesystem !== this.fs || backlogRoot !== filesystem.backlogDir)
				continue;
			if (!task) return null;

			const tasks = localTasks ?? (await filesystem.listTasks());
			if (generation !== this.projectGeneration || filesystem !== this.fs || backlogRoot !== filesystem.backlogDir)
				continue;
			return attachSubtaskSummaries(task, tasks);
		}
	}

	async loadTaskById(taskId: string, options: TaskReadOptions = {}): Promise<Task | null> {
		return options.includeCrossBranch === false
			? await this.loadWorkingCopyTask(taskId, false)
			: await this.getTask(taskId, options);
	}

	private async buildWorkingCopyTaskIndex(activeTasks?: Task[]): Promise<TaskIdentityIndex> {
		let suppliedActiveTasks = activeTasks;
		while (true) {
			const filesystem = this.fs;
			const backlogRoot = filesystem.backlogDir;
			const [localTasks, completedTasks, config] = await Promise.all([
				suppliedActiveTasks ? Promise.resolve(suppliedActiveTasks) : filesystem.listTasks(),
				filesystem.listCompletedTasks(),
				filesystem.loadConfig(),
			]);
			if (this.fs !== filesystem || backlogRoot !== filesystem.backlogDir) {
				suppliedActiveTasks = undefined;
				continue;
			}
			const index = await this.buildTaskIdentityIndex(
				localTasks,
				completedTasks,
				[],
				config?.statuses ?? [...DEFAULT_STATUSES],
				config?.taskResolutionStrategy ?? "most_progressed",
				null,
				filesystem,
			);
			if (this.fs === filesystem && backlogRoot === filesystem.backlogDir) return index;
			suppliedActiveTasks = undefined;
		}
	}

	async loadWorkingCopyTasks(includeCompleted = false): Promise<Task[]> {
		return (await this.buildWorkingCopyTaskIndex()).getTasks(includeCompleted);
	}

	private async loadWorkingCopyTask(taskId: string, forMutation: boolean, activeTasks?: Task[]): Promise<Task | null> {
		const index = await this.buildWorkingCopyTaskIndex(activeTasks);
		const resolution = forMutation ? index.resolveForMutation(taskId) : index.resolveForRead(taskId);
		if (resolution.status === "ambiguous") throw new AmbiguousTaskIdError(taskId, resolution.candidates);
		return resolution.status === "found" ? { ...resolution.task } : null;
	}

	private async loadTaskForMutation(taskId: string, options: TaskReadOptions = {}): Promise<Task | null> {
		if (options.includeCrossBranch === false) {
			return await this.loadWorkingCopyTask(taskId, true);
		}
		const store = await this.getContentStore();
		await store.refreshTasks();
		const resolution = store.resolveTaskForMutation(taskId);
		if (resolution.status === "ambiguous") throw new AmbiguousTaskIdError(taskId, resolution.candidates);
		return resolution.status === "found" ? { ...resolution.task } : null;
	}

	async getTaskContent(taskId: string): Promise<string | null> {
		const task = await this.fs.loadTask(taskId);
		const filePath = task?.filePath ?? null;
		if (!filePath) return null;
		return await Bun.file(filePath).text();
	}

	async getDocument(documentId: string): Promise<Document | null> {
		return findDocumentById(await this.fs.listDocuments(), documentId);
	}

	async getDocumentContent(documentId: string): Promise<string | null> {
		const document = await this.getDocument(documentId);
		if (!document) return null;

		const relativePath = normalizeDocumentRelativePath(document.path ?? `${document.id}.md`);
		const filePath = join(this.fs.docsDir, ...relativePath.split("/"));
		try {
			return await Bun.file(filePath).text();
		} catch {
			return null;
		}
	}

	/**
	 * Re-point this Core instance to a different project root.
	 * Disposes caches and re-creates FileSystem / GitOperations.
	 */
	reinitializeProjectRoot(projectRoot: string): void {
		this.projectGeneration += 1;
		this.disposeSearchService();
		this.disposeContentStore();
		this.fs = new FileSystem(projectRoot);
		this.git = new GitOperations(projectRoot, null, () => this.fs.loadConfig());
	}

	disposeSearchService(): void {
		if (this.searchService) {
			this.searchService.dispose();
			this.searchService = undefined;
		}
	}

	disposeContentStore(): void {
		if (this.contentStore) {
			this.contentStore.dispose();
			this.contentStore = undefined;
		}
		this.sharedTaskStateKey = null;
		this.sharedTaskStateRefreshPromise = null;
	}

	// Backward compatibility aliases
	get filesystem() {
		return this.fs;
	}

	get gitOps() {
		return this.git;
	}

	async ensureConfigLoaded(): Promise<void> {
		try {
			const config = await this.fs.loadConfig();
			this.git.setConfig(config);
		} catch (error) {
			// A config value Backlog refuses to read is the user's to fix and must reach the command;
			// only the recoverable git-configuration failures this guard exists for are suppressed.
			if (isConfigValueError(error)) {
				throw error;
			}
			// Config loading failed, git operations will work with null config
			if (process.env.DEBUG) {
				console.warn("Failed to load config for git operations:", error);
			}
		}
	}

	private async getBacklogDirectoryName(): Promise<string> {
		return this.fs.backlogDirName;
	}

	/**
	 * The git layer is not carried, so nothing auto-commits - not on the config's say-so
	 * and not on a caller's `--auto-commit` override. Every git call site in this file is
	 * guarded by this, which is why the stub in git/operations.ts can throw.
	 */
	async shouldAutoCommit(_overrideValue?: boolean): Promise<boolean> {
		return false;
	}

	async getGitOps() {
		await this.ensureConfigLoaded();
		return this.git;
	}

	// ID generation
	/**
	 * Generates the next ID for a given entity type.
	 *
	 * @param type - The entity type (Task, Draft, Document, Decision). Defaults to Task.
	 * @param parent - Optional parent ID for subtask generation (only applicable for tasks).
	 * @returns The next available ID (e.g., "task-42", "draft-5", "doc-3")
	 *
	 * Folder scanning by type:
	 * - Task: /tasks, /completed, cross-branch (if enabled), remote (if enabled)
	 * - Draft: /drafts only
	 * - Document: /documents only
	 * - Decision: /decisions only
	 */
	async generateNextId(type: EntityType = EntityType.Task, parent?: string): Promise<string> {
		const config = await this.fs.loadConfig();
		const prefix = getPrefixForType(type, config ?? undefined);

		// Collect existing IDs based on entity type
		const allIds = await this.getExistingIdsForType(type);

		if (parent) {
			// Subtask generation (only applicable for tasks)
			const normalizedParent = allIds.find((id) => taskIdsEqual(parent, id)) ?? normalizeTaskId(parent);
			return generateNextSubtaskId(allIds, normalizedParent, prefix, config?.zeroPaddedIds);
		}

		return generateNextPrefixedId(allIds, prefix, config?.zeroPaddedIds);
	}

	/**
	 * Gets all task IDs that are in use (active or completed) across all branches.
	 * Respects cross-branch config settings. Archived IDs are excluded (can be reused).
	 *
	 * This is used for ID generation to determine the next available ID.
	 */
	private async loadWorktreeTaskStateEntries(taskPrefix: string): Promise<BranchTaskStateEntry[]> {
		const [repoRoot, worktreeRoots] = await Promise.all([this.git.getRepositoryRoot(), this.git.listWorktreePaths()]);
		if (!repoRoot || worktreeRoots.length === 0) {
			return [];
		}

		const projectRelativePath = relative(repoRoot, this.fs.rootDir);
		if (projectRelativePath.startsWith("..") || isAbsolute(projectRelativePath)) {
			return [];
		}

		const backlogDir = await this.getBacklogDirectoryName();
		const entries: BranchTaskStateEntry[] = [];
		for (const worktreeRoot of worktreeRoots) {
			const projectRoot = projectRelativePath ? join(worktreeRoot, projectRelativePath) : worktreeRoot;
			entries.push(...(await this.loadTaskStateEntriesFromWorktree(projectRoot, backlogDir, taskPrefix, worktreeRoot)));
		}

		return entries;
	}

	private async loadTaskStateEntriesFromWorktree(
		projectRoot: string,
		backlogDir: string,
		taskPrefix: string,
		worktreeRoot: string,
	): Promise<BranchTaskStateEntry[]> {
		const idRegex = buildIdRegex(taskPrefix);
		const globPattern = buildGlobPattern(taskPrefix.toLowerCase());
		const directories: Array<{ path: string; type: "task" | "completed" }> = [
			{ path: join(projectRoot, backlogDir, DEFAULT_DIRECTORIES.TASKS), type: "task" },
			{ path: join(projectRoot, backlogDir, DEFAULT_DIRECTORIES.COMPLETED), type: "completed" },
		];
		const entries: BranchTaskStateEntry[] = [];

		for (const { path, type } of directories) {
			let files: string[];
			try {
				files = await Array.fromAsync(new Bun.Glob(globPattern).scan({ cwd: path, followSymlinks: true }));
			} catch {
				continue;
			}

			for (const file of files) {
				const match = file.match(idRegex);
				if (!match?.[1]) continue;

				const filePath = join(path, file);
				const stats = await stat(filePath).catch(() => null);
				entries.push({
					id: normalizeId(match[1], taskPrefix),
					type,
					branch: `worktree:${worktreeRoot}`,
					path: filePath,
					lastModified: stats?.mtime ?? new Date(0),
				});
			}
		}

		return entries;
	}

	private async getActiveAndCompletedTaskIds(): Promise<string[]> {
		const snapshot = await this.buildTaskCorpusSnapshot({
			includeCompleted: false,
			visibleCompleted: false,
		});
		const completedTasks = snapshot.completedTasks;
		const config = snapshot.config;
		const taskPrefix = config?.prefixes?.task ?? "task";
		if (!snapshot.identityIndex) throw new Error("Task corpus identity index was not initialized");

		// Same-repository worktrees share the task ID namespace even before their
		// task files are committed, so include their filesystem state for allocation.
		const worktreeEntries = await this.loadWorktreeTaskStateEntries(taskPrefix);
		const occupiedIds = new Set(snapshot.identityIndex.getOccupiedIds());
		for (const task of completedTasks) occupiedIds.add(task.id);
		for (const entry of worktreeEntries) {
			if (entry.type === "task" || entry.type === "completed") occupiedIds.add(entry.id);
		}
		return [...occupiedIds];
	}

	/**
	 * Gets all existing IDs for a given entity type.
	 * Used internally by generateNextId to determine the next available ID.
	 *
	 * Note: Archived tasks are intentionally excluded - archived IDs can be reused.
	 * This makes archive act as a soft delete for ID purposes.
	 */
	private async getExistingIdsForType(type: EntityType): Promise<string[]> {
		switch (type) {
			case EntityType.Task: {
				// Get active + completed task IDs from all branches (respects config)
				// Archived IDs are excluded - they can be reused (soft delete behavior)
				return this.getActiveAndCompletedTaskIds();
			}
			case EntityType.Draft: {
				// Occupancy includes filename-derived ids: an unparsable file still reserves its
				// numeric id, so allocation can never reuse what it cannot parse.
				const [drafts, occupiedFileIds] = await Promise.all([this.fs.listDrafts(), this.fs.listOccupiedDraftFileIds()]);
				return [...drafts.map((d) => d.id), ...occupiedFileIds];
			}
			case EntityType.Document: {
				const documents = await this.fs.listDocuments();
				return documents.map((d) => d.id);
			}
			case EntityType.Decision: {
				const decisions = await this.fs.listDecisions();
				return decisions.map((d) => d.id);
			}
			default:
				return [];
		}
	}

	private async writePreparedTask(task: Task, isDraft: boolean): Promise<string> {
		if (isDraft) {
			task.status = "Draft";
			normalizeAssignee(task);
			return await this.fs.saveDraft(task);
		}

		normalizeAssignee(task);
		return await this.fs.saveTask(task);
	}

	private async finalizeCreatedTask(
		task: Task,
		filepath: string,
		isDraft: boolean,
		autoCommit: boolean,
		write?: CreatedTaskWrite,
	): Promise<Task | null> {
		const savedTask = isDraft ? await this.fs.loadDraft(task.id) : await this.fs.loadTask(task.id);

		if (!isDraft && this.contentStore && savedTask) {
			this.contentStore.upsertTask(savedTask);
		}

		if (autoCommit) {
			if (isDraft) {
				await this.git.addFile(filepath);
				if (write) write.generatedIndexEntries = await this.git.getIndexEntries(filepath);
				await this.git.commitTaskChange(task.id, `Create draft ${task.id}`, filepath);
			} else {
				await this.git.addAndCommitTaskFile(task.id, filepath, "create", (entries) => {
					if (write) write.generatedIndexEntries = entries;
				});
			}
		}

		return savedTask;
	}

	private async readFileIfPresent(filePath: string | null): Promise<Buffer | null> {
		if (!filePath) return null;
		try {
			return await readFile(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async rollbackCreatedTask(write: CreatedTaskWrite): Promise<CreatedTaskRollbackResult> {
		let indexRestored = true;
		if (write.generatedIndexEntries) {
			indexRestored = await this.git.restoreIndexEntriesIfMatches(
				write.filePath,
				write.generatedIndexEntries,
				write.previousIndexEntries ?? [],
			);
		}

		const currentContent = await this.readFileIfPresent(write.filePath);
		const stillOwnsCreatedPath = currentContent?.equals(write.createdContent) ?? false;
		let workingPathRestored = false;
		if (currentContent === null) {
			if (write.previousPath === write.filePath && write.previousContent) {
				try {
					await writeFile(write.filePath, write.previousContent, { flag: "wx" });
					workingPathRestored = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			} else {
				workingPathRestored = true;
			}
		} else if (stillOwnsCreatedPath && indexRestored) {
			if (write.previousPath === write.filePath && write.previousContent) {
				await writeFile(write.filePath, write.previousContent);
			} else {
				await unlink(write.filePath);
			}
			workingPathRestored = true;
		}

		if (write.previousPath && write.previousPath !== write.filePath && write.previousContent) {
			const currentPreviousContent = await this.readFileIfPresent(write.previousPath);
			if (currentPreviousContent === null) {
				await writeFile(write.previousPath, write.previousContent);
			}
		}

		if (this.contentStore) {
			await this.contentStore.refreshTasks();
		}

		return { indexRestored, workingPathRestored };
	}

	async createTaskFromInput(input: TaskCreateInput, autoCommit?: boolean): Promise<{ task: Task; filePath?: string }> {
		if (!input.title || input.title.trim().length === 0) {
			throw new Error("Title is required to create a task.");
		}
		assertSectionInputsSafe(input);

		// Determine if this is a draft BEFORE generating the ID
		const requestedStatus = input.status?.trim();
		const isDraft = requestedStatus?.toLowerCase() === "draft";
		const requestedParentTaskId = input.parentTaskId?.trim();

		// Generate ID with appropriate entity type - drafts get DRAFT-X, tasks get TASK-X
		const entityType = isDraft ? EntityType.Draft : EntityType.Task;

		const normalizedLabels = normalizeStringList(input.labels) ?? [];
		const normalizedAssignees = normalizeStringList(input.assignee) ?? [];
		const normalizedDependencies = parseDelimitedStringList(input.dependencies) ?? [];
		const normalizedReferences = normalizeStringList(input.references) ?? [];
		const normalizedDocumentation = normalizeStringList(input.documentation) ?? [];
		const normalizedModifiedFiles = normalizeStringList(input.modifiedFiles) ?? [];
		const dueDate = normalizeDueDate(input.dueDate, "Due date");

		let status = "";
		if (requestedStatus) {
			if (isDraft) {
				status = "Draft";
			} else {
				status = await this.requireCanonicalStatus(requestedStatus);
			}
		}

		const priority = await this.normalizePriority(input.priority);
		const type = await this.normalizeTaskType(input.type);
		const project = await this.normalizeProject(input.project);
		const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");
		if (
			input.ordinal !== undefined &&
			(typeof input.ordinal !== "number" || !Number.isFinite(input.ordinal) || input.ordinal < 0)
		) {
			throw new Error("Ordinal must be a non-negative number.");
		}

		const acceptanceCriteriaItems = Array.isArray(input.acceptanceCriteria)
			? input.acceptanceCriteria
					.map((criterion, index) => ({
						index: index + 1,
						text: String(criterion.text ?? "").trim(),
						checked: Boolean(criterion.checked),
					}))
					.filter((criterion) => criterion.text.length > 0)
			: [];
		const config = await this.fs.loadConfig();
		const definitionOfDoneItems = buildDefinitionOfDoneItems({
			defaults: config?.definitionOfDone,
			add: input.definitionOfDoneAdd,
			disableDefaults: input.disableDefinitionOfDoneDefaults,
		});
		const resolvedStatus = isDraft ? "Draft" : status || config?.defaultStatus || FALLBACK_STATUS;
		// An absent assignee means "no opinion" and takes the configured default; an explicit
		// assignee replaces it entirely, and an explicit empty list means "unassigned".
		const resolvedAssignees =
			input.assignee === undefined ? (normalizeStringList(config?.defaultAssignee) ?? []) : normalizedAssignees;
		const autoCommitEnabled = await this.shouldAutoCommit(autoCommit);

		const { task, write } = await this.withCreateLock(async () => {
			const parentTaskId = requestedParentTaskId
				? await this.resolveParentTaskIdForCreate(requestedParentTaskId)
				: undefined;
			const id = await this.generateNextId(entityType, isDraft ? undefined : parentTaskId);
			// Validated inside the create lock, against the allocated identity: a record can hold a
			// dangling dependency on exactly this not-yet-existing ID, so materializing it with a
			// dependency pointing back would store a cycle that no later edit could have created.
			const { valid: validDependencies, invalid: invalidDependencies } = await validateDependencies(
				normalizedDependencies,
				this,
				{
					id,
					title: input.title.trim(),
					status: resolvedStatus,
					assignee: [],
					createdDate,
					labels: [],
					dependencies: [],
				},
			);
			if (invalidDependencies.length > 0) {
				throw formatMissingDependenciesError(invalidDependencies);
			}
			const ordinal = await this.resolveCreateOrdinal(input.ordinal, isDraft);
			const task: Task = {
				id,
				title: input.title.trim(),
				status: resolvedStatus,
				assignee: resolvedAssignees,
				labels: normalizedLabels,
				dependencies: validDependencies,
				references: normalizedReferences,
				documentation: normalizedDocumentation,
				modifiedFiles: normalizedModifiedFiles,
				rawContent: input.rawContent ?? "",
				createdDate,
				...(dueDate && { dueDate }),
				...(parentTaskId && { parentTaskId }),
				...(priority && { priority }),
				...(type && { type }),
				...(project && { project }),
				...(typeof ordinal === "number" && { ordinal }),
				...(typeof input.milestone === "string" &&
					input.milestone.trim().length > 0 && {
						milestone: input.milestone.trim(),
					}),
				...(typeof input.description === "string" && { description: input.description }),
				...(typeof input.implementationPlan === "string" && { implementationPlan: input.implementationPlan }),
				...(typeof input.implementationNotes === "string" && { implementationNotes: input.implementationNotes }),
				...(typeof input.finalSummary === "string" && { finalSummary: input.finalSummary }),
				...(acceptanceCriteriaItems.length > 0 && { acceptanceCriteriaItems }),
				...(definitionOfDoneItems && definitionOfDoneItems.length > 0 && { definitionOfDoneItems }),
			};

			const resolvedPreviousPath = isDraft
				? await this.fs.resolveDraftFilePath(task.id)
				: await getTaskPath(task.id, this);
			const targetPath = await this.fs.getTaskWritePath(task, isDraft);
			const targetContent = await this.readFileIfPresent(targetPath);
			const previousPath = targetContent ? targetPath : resolvedPreviousPath;
			const previousContent = targetContent ?? (await this.readFileIfPresent(resolvedPreviousPath));
			const previousIndexEntries = autoCommitEnabled ? await this.git.getIndexEntries(targetPath) : undefined;
			const filePath = await this.writePreparedTask(task, isDraft);
			const createdContent = await readFile(filePath);
			const write: CreatedTaskWrite = {
				filePath,
				createdContent,
				previousPath,
				previousContent,
				previousIndexEntries,
			};
			return {
				task,
				write,
			};
		});

		try {
			const savedTask = await this.finalizeCreatedTask(task, write.filePath, isDraft, autoCommitEnabled, write);
			return { task: savedTask ?? task, filePath: write.filePath };
		} catch (error) {
			let rollback: CreatedTaskRollbackResult;
			try {
				rollback = await this.rollbackCreatedTask(write);
			} catch (rollbackError) {
				const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
				throw new Error(`Task creation failed and cleanup also failed: ${message}`, { cause: error });
			}
			if (!rollback.workingPathRestored || !rollback.indexRestored) {
				if (!rollback.indexRestored) {
					throw new Error(
						`Task creation failed, and Backlog no longer owned the staged entry for ${write.filePath}. The task file and staged Git state were preserved, ${task.id} remains in use, and manual Git review is required before retrying.`,
						{ cause: error },
					);
				}
				throw new Error(
					`Task creation failed, and cleanup could not safely remove the changed file at ${write.filePath}. Your changes were preserved. Review or remove the preserved file before retrying because ${task.id} remains in use.`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	/**
	 * Resolve `--parent` against the working copy, the same corpus the parent filter and task reads
	 * use, so one ID cannot be an acceptable parent for a child that no task command can then show.
	 */
	private async resolveParentTaskIdForCreate(parentTaskId: string): Promise<string> {
		const parentTask = await this.loadTaskById(parentTaskId, { includeCrossBranch: false });
		if (!parentTask) {
			const config = await this.fs.loadConfig();
			const canonicalParent = canonicalTaskId(parentTaskId, config?.prefixes?.task ?? "task");
			throw new Error(
				`Parent task ${canonicalParent} not found. ${LOCAL_TASK_LOOKUP_HINT} Use an existing task ID with --parent; use --milestone to assign a task to a milestone.`,
			);
		}
		return parentTask.id;
	}

	async createTask(task: Task, autoCommit?: boolean): Promise<string> {
		if (!task.status) {
			const config = await this.fs.loadConfig();
			task.status = config?.defaultStatus || FALLBACK_STATUS;
		}

		const autoCommitEnabled = await this.shouldAutoCommit(autoCommit);
		const filepath = await this.writePreparedTask(task, false);
		await this.finalizeCreatedTask(task, filepath, false, autoCommitEnabled);

		return filepath;
	}

	async updateTask(task: Task, autoCommit?: boolean): Promise<string> {
		normalizeAssignee(task);

		// Load original task to detect status changes for callbacks
		const cachedResolution = this.contentStore?.isInitialized()
			? this.contentStore.resolveTaskForMutation(task.id)
			: undefined;
		const originalTask = cachedResolution?.status === "found" ? cachedResolution.task : await this.fs.loadTask(task.id);
		const oldStatus = originalTask?.status ?? "";
		const newStatus = task.status ?? "";
		const statusChanged = oldStatus !== newStatus;

		if (hasUpdatedDateRelevantChanges(originalTask, task)) {
			task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");
		} else if (originalTask?.updatedDate) {
			task.updatedDate = originalTask.updatedDate;
		} else {
			delete task.updatedDate;
		}

		const filePath = await this.fs.saveTask(task);
		// Keep any in-process ContentStore in sync for immediate UI/search freshness.

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addAndCommitTaskFile(task.id, filePath, "update");
		}

		// Fire status change callback if status changed
		if (statusChanged) {
			await this.executeStatusChangeCallback(task, oldStatus, newStatus);
		}

		return filePath;
	}

	private async applyTaskUpdateInput(
		task: Task,
		input: TaskUpdateInput,
		statusResolver: (status: string) => Promise<string>,
	): Promise<{ task: Task; mutated: boolean }> {
		assertSectionInputsSafe(input);
		let mutated = false;

		const applyStringField = (
			value: string | undefined,
			current: string | undefined,
			assign: (next: string) => void,
		) => {
			if (typeof value === "string") {
				const next = value;
				if ((current ?? "") !== next) {
					assign(next);
					mutated = true;
				}
			}
		};

		if (input.title !== undefined) {
			const trimmed = input.title.trim();
			if (trimmed.length === 0) {
				throw new Error("Title cannot be empty.");
			}
			if (task.title !== trimmed) {
				task.title = trimmed;
				mutated = true;
			}
		}

		applyStringField(input.description, task.description, (next) => {
			task.description = next;
		});

		if (input.dueDate !== undefined) {
			const dueDate = input.dueDate === null ? undefined : normalizeDueDate(input.dueDate, "Due date");
			if (task.dueDate !== dueDate) {
				if (dueDate) task.dueDate = dueDate;
				else delete task.dueDate;
				mutated = true;
			}
		}

		if (input.status !== undefined) {
			const canonicalStatus = await statusResolver(input.status);
			if ((task.status ?? "") !== canonicalStatus) {
				task.status = canonicalStatus;
				mutated = true;
			}
		}

		if (input.priority !== undefined) {
			const normalizedPriority = await this.normalizePriority(String(input.priority));
			if (task.priority !== normalizedPriority) {
				task.priority = normalizedPriority;
				mutated = true;
			}
		}

		if (input.type !== undefined) {
			const normalizedType = await this.normalizeTaskType(String(input.type));
			if (task.type !== normalizedType) {
				task.type = normalizedType;
				mutated = true;
			}
		}

		if (input.project !== undefined) {
			const normalizedProject = input.project === null ? undefined : await this.normalizeProject(input.project);
			if ((task.project ?? undefined) !== normalizedProject) {
				if (normalizedProject === undefined) {
					delete task.project;
				} else {
					task.project = normalizedProject;
				}
				mutated = true;
			}
		}

		if (input.milestone !== undefined) {
			const normalizedMilestone =
				input.milestone === null ? undefined : input.milestone.trim().length > 0 ? input.milestone.trim() : undefined;
			if ((task.milestone ?? undefined) !== normalizedMilestone) {
				if (normalizedMilestone === undefined) {
					delete task.milestone;
				} else {
					task.milestone = normalizedMilestone;
				}
				mutated = true;
			}
		}

		if (input.ordinal !== undefined) {
			if (typeof input.ordinal !== "number" || !Number.isFinite(input.ordinal) || input.ordinal < 0) {
				throw new Error("Ordinal must be a non-negative number.");
			}
			if (task.ordinal !== input.ordinal) {
				task.ordinal = input.ordinal;
				mutated = true;
			}
		}

		if (input.assignee !== undefined) {
			const sanitizedAssignee = normalizeStringList(input.assignee) ?? [];
			if (!stringArraysEqual(sanitizedAssignee, task.assignee ?? [])) {
				task.assignee = sanitizedAssignee;
				mutated = true;
			}
		}

		const resolveLabelChanges = (): void => {
			let currentLabels = [...(task.labels ?? [])];
			if (input.labels !== undefined) {
				const sanitizedLabels = normalizeStringList(input.labels) ?? [];
				if (!stringArraysEqual(sanitizedLabels, currentLabels)) {
					task.labels = sanitizedLabels;
					mutated = true;
				}
				currentLabels = sanitizedLabels;
			}

			const labelsToAdd = normalizeStringList(input.addLabels) ?? [];
			if (labelsToAdd.length > 0) {
				const labelSet = new Set(currentLabels.map((label) => label.toLowerCase()));
				for (const label of labelsToAdd) {
					if (!labelSet.has(label.toLowerCase())) {
						currentLabels.push(label);
						labelSet.add(label.toLowerCase());
						mutated = true;
					}
				}
				task.labels = currentLabels;
			}

			const labelsToRemove = normalizeStringList(input.removeLabels) ?? [];
			if (labelsToRemove.length > 0) {
				const removalSet = new Set(labelsToRemove.map((label) => label.toLowerCase()));
				const filtered = currentLabels.filter((label) => !removalSet.has(label.toLowerCase()));
				if (!stringArraysEqual(filtered, currentLabels)) {
					task.labels = filtered;
					mutated = true;
				}
			}
		};

		resolveLabelChanges();

		const resolveDependencies = async (): Promise<void> => {
			let currentDependencies = [...(task.dependencies ?? [])];

			if (input.dependencies !== undefined) {
				const normalized = parseDelimitedStringList(input.dependencies) ?? [];
				const { valid, invalid } = await validateDependencies(normalized, this, task);
				if (invalid.length > 0) {
					throw formatMissingDependenciesError(invalid);
				}
				if (!stringArraysEqual(valid, currentDependencies)) {
					currentDependencies = valid;
					mutated = true;
				}
			}

			if (input.addDependencies && input.addDependencies.length > 0) {
				const additions = parseDelimitedStringList(input.addDependencies) ?? [];
				const { valid, invalid } = await validateDependencies(additions, this, task);
				if (invalid.length > 0) {
					throw formatMissingDependenciesError(invalid);
				}
				const depSet = new Set(currentDependencies);
				for (const dep of valid) {
					if (!depSet.has(dep)) {
						currentDependencies.push(dep);
						depSet.add(dep);
						mutated = true;
					}
				}
			}

			if (input.removeDependencies && input.removeDependencies.length > 0) {
				const removals = parseDelimitedStringList(input.removeDependencies) ?? [];
				const filtered = currentDependencies.filter((dep) => !removals.some((removal) => taskIdsEqual(removal, dep)));
				if (!stringArraysEqual(filtered, currentDependencies)) {
					currentDependencies = filtered;
					mutated = true;
				}
			}

			task.dependencies = currentDependencies;
		};

		await resolveDependencies();

		const resolveReferences = (): void => {
			let currentReferences = [...(task.references ?? [])];
			if (input.references !== undefined) {
				const sanitizedReferences = normalizeStringList(input.references) ?? [];
				if (!stringArraysEqual(sanitizedReferences, currentReferences)) {
					task.references = sanitizedReferences;
					mutated = true;
				}
				currentReferences = sanitizedReferences;
			}

			const referencesToAdd = normalizeStringList(input.addReferences) ?? [];
			if (referencesToAdd.length > 0) {
				const refSet = new Set(currentReferences);
				for (const ref of referencesToAdd) {
					if (!refSet.has(ref)) {
						currentReferences.push(ref);
						refSet.add(ref);
						mutated = true;
					}
				}
				task.references = currentReferences;
			}

			const referencesToRemove = normalizeStringList(input.removeReferences) ?? [];
			if (referencesToRemove.length > 0) {
				const removalSet = new Set(referencesToRemove);
				const filtered = currentReferences.filter((ref) => !removalSet.has(ref));
				if (!stringArraysEqual(filtered, currentReferences)) {
					task.references = filtered;
					mutated = true;
				}
			}
		};

		resolveReferences();

		const resolveDocumentation = (): void => {
			let currentDocumentation = [...(task.documentation ?? [])];
			if (input.documentation !== undefined) {
				const sanitizedDocumentation = normalizeStringList(input.documentation) ?? [];
				if (!stringArraysEqual(sanitizedDocumentation, currentDocumentation)) {
					task.documentation = sanitizedDocumentation;
					mutated = true;
				}
				currentDocumentation = sanitizedDocumentation;
			}

			const documentationToAdd = normalizeStringList(input.addDocumentation) ?? [];
			if (documentationToAdd.length > 0) {
				const docSet = new Set(currentDocumentation);
				for (const doc of documentationToAdd) {
					if (!docSet.has(doc)) {
						currentDocumentation.push(doc);
						docSet.add(doc);
						mutated = true;
					}
				}
				task.documentation = currentDocumentation;
			}

			const documentationToRemove = normalizeStringList(input.removeDocumentation) ?? [];
			if (documentationToRemove.length > 0) {
				const removalSet = new Set(documentationToRemove);
				const filtered = currentDocumentation.filter((doc) => !removalSet.has(doc));
				if (!stringArraysEqual(filtered, currentDocumentation)) {
					task.documentation = filtered;
					mutated = true;
				}
			}
		};

		resolveDocumentation();

		const resolveModifiedFiles = (): void => {
			if (input.modifiedFiles === undefined) {
				return;
			}
			const sanitizedModifiedFiles = normalizeStringList(input.modifiedFiles) ?? [];
			if (!stringArraysEqual(sanitizedModifiedFiles, task.modifiedFiles ?? [])) {
				task.modifiedFiles = sanitizedModifiedFiles;
				mutated = true;
			}
		};

		resolveModifiedFiles();

		const sanitizeAppendInput = (values: string[] | undefined): string[] => {
			if (!values) return [];
			return values.map((value) => String(value).trim()).filter((value) => value.length > 0);
		};

		const appendBlock = (
			existing: string | undefined,
			additions: string[] | undefined,
		): { value?: string; changed: boolean } => {
			const sanitizedAdditions = (additions ?? [])
				.map((value) => String(value).trim())
				.filter((value) => value.length > 0);
			if (sanitizedAdditions.length === 0) {
				return { value: existing, changed: false };
			}
			const current = (existing ?? "").trim();
			const additionBlock = sanitizedAdditions.join("\n\n");
			if (current.length === 0) {
				return { value: additionBlock, changed: true };
			}
			return { value: `${current}\n\n${additionBlock}`, changed: true };
		};

		const containsCommentMarker = (inputValue: string): boolean => /<!--\s*COMMENTS?:/i.test(inputValue);
		const containsCommentDelimiter = (inputValue: string): boolean =>
			/^\s*---\s*$/m.test(inputValue.replace(/\r\n/g, "\n"));

		const sanitizeCommentInput = (value: TaskCommentInput | string): TaskCommentInput | undefined => {
			const rawBody = typeof value === "string" ? value : value.body;
			const body = String(rawBody ?? "")
				.replace(/\r\n/g, "\n")
				.trim();
			if (body.length === 0) return undefined;
			if (containsCommentMarker(body)) {
				throw new Error("Comment body cannot contain Backlog comment markers.");
			}
			if (containsCommentDelimiter(body)) {
				throw new Error("Comment body cannot contain standalone '---' delimiter lines.");
			}
			const author =
				typeof value === "string"
					? undefined
					: String(value.author ?? "")
							.replace(/\s+/g, " ")
							.trim();
			const createdDate = typeof value === "string" ? undefined : String(value.createdDate ?? "").trim();
			if (author && containsCommentMarker(author)) {
				throw new Error("Comment author cannot contain Backlog comment markers.");
			}
			if (author && containsCommentDelimiter(author)) {
				throw new Error("Comment author cannot contain standalone '---' delimiter lines.");
			}
			if (createdDate && containsCommentMarker(createdDate)) {
				throw new Error("Comment created date cannot contain Backlog comment markers.");
			}
			if (createdDate && containsCommentDelimiter(createdDate)) {
				throw new Error("Comment created date cannot contain standalone '---' delimiter lines.");
			}
			return {
				body,
				...(author && { author }),
				...(createdDate && { createdDate }),
			};
		};

		if (input.clearImplementationPlan) {
			if (task.implementationPlan !== undefined) {
				delete task.implementationPlan;
				mutated = true;
			}
		}

		applyStringField(input.implementationPlan, task.implementationPlan, (next) => {
			task.implementationPlan = next;
		});

		const planAppends = sanitizeAppendInput(input.appendImplementationPlan);
		if (planAppends.length > 0) {
			const { value, changed } = appendBlock(task.implementationPlan, planAppends);
			if (changed) {
				task.implementationPlan = value;
				mutated = true;
			}
		}

		if (input.clearImplementationNotes) {
			if (task.implementationNotes !== undefined) {
				delete task.implementationNotes;
				mutated = true;
			}
		}

		applyStringField(input.implementationNotes, task.implementationNotes, (next) => {
			task.implementationNotes = next;
		});

		const notesAppends = sanitizeAppendInput(input.appendImplementationNotes);
		if (notesAppends.length > 0) {
			const { value, changed } = appendBlock(task.implementationNotes, notesAppends);
			if (changed) {
				task.implementationNotes = value;
				mutated = true;
			}
		}

		if (input.appendComments && input.appendComments.length > 0) {
			const currentComments = Array.isArray(task.comments) ? task.comments.map((comment) => ({ ...comment })) : [];
			let nextIndex = currentComments.length > 0 ? Math.max(...currentComments.map((comment) => comment.index)) + 1 : 1;
			const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");
			for (const value of input.appendComments) {
				const sanitized = sanitizeCommentInput(value);
				if (!sanitized) continue;
				currentComments.push({
					index: nextIndex++,
					body: sanitized.body,
					createdDate: sanitized.createdDate ?? createdDate,
					...(sanitized.author && { author: sanitized.author }),
				});
				mutated = true;
			}
			if (mutated) {
				task.comments = currentComments;
			}
		}

		if (input.clearFinalSummary) {
			if (task.finalSummary !== undefined) {
				task.finalSummary = "";
				mutated = true;
			}
		}

		applyStringField(input.finalSummary, task.finalSummary, (next) => {
			task.finalSummary = next;
		});

		const finalSummaryAppends = sanitizeAppendInput(input.appendFinalSummary);
		if (finalSummaryAppends.length > 0) {
			const { value, changed } = appendBlock(task.finalSummary, finalSummaryAppends);
			if (changed) {
				task.finalSummary = value;
				mutated = true;
			}
		}

		let acceptanceCriteria = Array.isArray(task.acceptanceCriteriaItems)
			? task.acceptanceCriteriaItems.map((criterion) => ({ ...criterion }))
			: [];

		const rebuildIndices = () => {
			acceptanceCriteria = acceptanceCriteria.map((criterion, index) => ({
				...criterion,
				index: index + 1,
			}));
		};

		if (input.acceptanceCriteria !== undefined) {
			const sanitized = input.acceptanceCriteria
				.map((criterion) => ({
					text: String(criterion.text ?? "").trim(),
					checked: Boolean(criterion.checked),
				}))
				.filter((criterion) => criterion.text.length > 0)
				.map((criterion, index) => ({
					index: index + 1,
					text: criterion.text,
					checked: criterion.checked,
				}));
			acceptanceCriteria = sanitized;
			mutated = true;
		}

		if (input.addAcceptanceCriteria && input.addAcceptanceCriteria.length > 0) {
			const additions = input.addAcceptanceCriteria
				.map((criterion) => (typeof criterion === "string" ? criterion.trim() : String(criterion.text ?? "").trim()))
				.filter((text) => text.length > 0);
			let index =
				acceptanceCriteria.length > 0 ? Math.max(...acceptanceCriteria.map((criterion) => criterion.index)) + 1 : 1;
			for (const text of additions) {
				acceptanceCriteria.push({ index: index++, text, checked: false });
				mutated = true;
			}
		}

		if (input.removeAcceptanceCriteria && input.removeAcceptanceCriteria.length > 0) {
			const removalSet = new Set(input.removeAcceptanceCriteria);
			const beforeLength = acceptanceCriteria.length;
			acceptanceCriteria = acceptanceCriteria.filter((criterion) => !removalSet.has(criterion.index));
			if (acceptanceCriteria.length === beforeLength) {
				throw new Error(
					`Acceptance criterion ${Array.from(removalSet)
						.map((index) => `#${index}`)
						.join(", ")} not found. ${formatAvailableIndexHint(
						acceptanceCriteria,
						"No acceptance criteria are defined.",
					)}`,
				);
			}
			mutated = true;
			rebuildIndices();
		}

		const toggleCriteria = (indices: number[] | undefined, checked: boolean) => {
			if (!indices || indices.length === 0) return;
			const missing: number[] = [];
			for (const index of indices) {
				const criterion = acceptanceCriteria.find((item) => item.index === index);
				if (!criterion) {
					missing.push(index);
					continue;
				}
				if (criterion.checked !== checked) {
					criterion.checked = checked;
					mutated = true;
				}
			}
			if (missing.length > 0) {
				const label = missing.map((index) => `#${index}`).join(", ");
				throw new Error(
					`Acceptance criterion ${label} not found. ${formatAvailableIndexHint(
						acceptanceCriteria,
						"No acceptance criteria are defined.",
					)}`,
				);
			}
		};

		toggleCriteria(input.checkAcceptanceCriteria, true);
		toggleCriteria(input.uncheckAcceptanceCriteria, false);

		task.acceptanceCriteriaItems = acceptanceCriteria;

		let definitionOfDone = Array.isArray(task.definitionOfDoneItems)
			? task.definitionOfDoneItems.map((criterion) => ({ ...criterion }))
			: [];

		const rebuildDefinitionIndices = () => {
			definitionOfDone = definitionOfDone.map((criterion, index) => ({
				...criterion,
				index: index + 1,
			}));
		};

		if (input.addDefinitionOfDone && input.addDefinitionOfDone.length > 0) {
			const additions = input.addDefinitionOfDone
				.map((criterion) => (typeof criterion === "string" ? criterion.trim() : String(criterion.text ?? "").trim()))
				.filter((text) => text.length > 0);
			let index =
				definitionOfDone.length > 0 ? Math.max(...definitionOfDone.map((criterion) => criterion.index)) + 1 : 1;
			for (const text of additions) {
				definitionOfDone.push({ index: index++, text, checked: false });
				mutated = true;
			}
		}

		const toggleDefinitionItems = (indices: number[] | undefined, checked: boolean) => {
			if (!indices || indices.length === 0) return;
			const missing: number[] = [];
			for (const index of indices) {
				const criterion = definitionOfDone.find((item) => item.index === index);
				if (!criterion) {
					missing.push(index);
					continue;
				}
				if (criterion.checked !== checked) {
					criterion.checked = checked;
					mutated = true;
				}
			}
			if (missing.length > 0) {
				const label = missing.map((index) => `#${index}`).join(", ");
				throw new Error(
					`Definition of Done item ${label} not found. ${formatAvailableIndexHint(
						definitionOfDone,
						"No Definition of Done items are defined.",
					)}`,
				);
			}
		};

		toggleDefinitionItems(input.checkDefinitionOfDone, true);
		toggleDefinitionItems(input.uncheckDefinitionOfDone, false);

		if (input.removeDefinitionOfDone && input.removeDefinitionOfDone.length > 0) {
			const removalSet = new Set(input.removeDefinitionOfDone);
			const beforeLength = definitionOfDone.length;
			definitionOfDone = definitionOfDone.filter((criterion) => !removalSet.has(criterion.index));
			if (definitionOfDone.length === beforeLength) {
				throw new Error(
					`Definition of Done item ${Array.from(removalSet)
						.map((index) => `#${index}`)
						.join(", ")} not found. ${formatAvailableIndexHint(
						definitionOfDone,
						"No Definition of Done items are defined.",
					)}`,
				);
			}
			mutated = true;
			rebuildDefinitionIndices();
		}

		task.definitionOfDoneItems = definitionOfDone;

		return { task, mutated };
	}

	async updateTaskFromInput(
		taskId: string,
		input: TaskUpdateInput,
		autoCommit?: boolean,
		options: TaskReadOptions = {},
	): Promise<Task> {
		const task = await this.loadTaskForMutation(taskId, options);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const requestedStatus = input.status?.trim().toLowerCase();
		if (requestedStatus === "draft") {
			// demoteTaskWithUpdates takes the task lock itself, so it must not be nested here.
			return (await this.demoteTaskWithUpdates(task, input, autoCommit, options)).task;
		}

		// Fail fast when another process is mid-edit, and re-read inside the lock so the whole
		// read-modify-write is protected. Locking only the write would still lose an update
		// whenever one writer releases before the next acquires: the second would then apply
		// its changes to a snapshot taken before the first wrote.
		return await this.fs.withTaskLock(task, async () => {
			const current = await this.loadTaskForMutation(taskId, options);
			if (!current) {
				throw new Error(`Task not found: ${taskId}`);
			}

			const { mutated } = await this.applyTaskUpdateInput(current, input, async (status) =>
				this.requireCanonicalStatus(status),
			);

			if (!mutated) {
				return current;
			}

			await this.updateTask(current, autoCommit);
			return current;
		});
	}

	async updateDraft(task: Task, autoCommit?: boolean): Promise<string> {
		// Drafts always keep status Draft
		task.status = "Draft";
		normalizeAssignee(task);
		task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");

		const previousPath = task.filePath;
		const filepath = await this.fs.saveDraft(task);

		if (await this.shouldAutoCommit(autoCommit)) {
			if (previousPath && previousPath !== filepath) {
				// A title rename moved the file: stage the deletion of the old path together with
				// the addition of the new one, mirroring how task moves stage their renames.
				const repoRoot = await this.git.stageFileMove(previousPath, filepath);
				await this.git.commitFiles(`Update draft ${task.id}`, [previousPath, filepath], repoRoot ?? undefined);
			} else {
				await this.git.addFile(filepath);
				await this.git.commitTaskChange(task.id, `Update draft ${task.id}`, filepath);
			}
		}

		return filepath;
	}

	async updateDraftFromInput(
		reference: DraftFileReference,
		input: TaskUpdateInput,
		autoCommit?: boolean,
	): Promise<Task> {
		// Same discipline as task edits: acquire the namespaced per-file lock before the
		// read-modify-write and re-read inside it, so a concurrent editor fails fast instead of
		// losing its update. The reference's own file is the only thing touched; no id is ever
		// re-resolved to a different path.
		return await this.fs.withDraftLock(reference, async () => {
			const current = await this.fs.draftReferenceFromPath(reference.filePath);
			// Bind the mutated record to the selected file's own identity: a padded filename whose
			// frontmatter carries an unpadded id must keep converging onto that one file instead of
			// minting a second spelling of the same numeric id.
			current.task.id = reference.canonicalId;

			const { mutated } = await this.applyTaskUpdateInput(current.task, input, async (status) => {
				if (status.trim().toLowerCase() !== "draft") {
					throw new Error("Drafts must use status Draft.");
				}
				return "Draft";
			});

			if (!mutated) {
				return current.task;
			}

			const savedPath = await this.updateDraft(current.task, autoCommit);
			const refreshed = await this.fs.draftReferenceFromPath(savedPath);
			return refreshed.task;
		});
	}

	async editTaskOrDraft(
		taskId: string,
		input: TaskUpdateInput,
		autoCommit?: boolean,
		options: TaskReadOptions = {},
	): Promise<TaskEditResult> {
		const resolvedDraft = await this.fs.resolveDraftReference(taskId);
		if (resolvedDraft) {
			const requestedStatus = input.status?.trim();
			const wantsDraft = requestedStatus?.toLowerCase() === "draft";
			if (requestedStatus && !wantsDraft) {
				return {
					task: await this.promoteDraftWithUpdates(resolvedDraft, input, autoCommit),
					cleanedTaskIds: [],
				};
			}
			return { task: await this.updateDraftFromInput(resolvedDraft, input, autoCommit), cleanedTaskIds: [] };
		}

		if (input.status?.trim().toLowerCase() === "draft") {
			const task = await this.loadTaskForMutation(taskId, options);
			if (!task) throw new Error(`Task not found: ${taskId}`);
			return await this.demoteTaskWithUpdates(task, input, autoCommit, options);
		}

		return { task: await this.updateTaskFromInput(taskId, input, autoCommit, options), cleanedTaskIds: [] };
	}

	private async promoteDraftWithUpdates(
		reference: DraftFileReference,
		input: TaskUpdateInput,
		autoCommit?: boolean,
	): Promise<Task> {
		const targetStatus = input.status?.trim();
		if (!targetStatus || targetStatus.toLowerCase() === "draft") {
			throw new Error("Promoting a draft requires a non-draft status.");
		}

		const canonicalStatus = await this.requireCanonicalStatus(targetStatus);

		// Same locked read-apply-promote discipline as edit/promote: hold the draft lock across
		// the whole span and re-read inside it, so a concurrent editor cannot be omitted from the
		// promoted task or left behind as a second record.
		return await this.fs.withDraftLock(reference, async () => {
			const current = await this.fs.draftReferenceFromPath(reference.filePath);
			const draft = current.task;
			draft.id = reference.canonicalId;

			const { mutated } = await this.applyTaskUpdateInput(draft, { ...input, status: undefined }, async (status) => {
				if (status.trim().toLowerCase() !== "draft") {
					throw new Error("Drafts must use status Draft.");
				}
				return "Draft";
			});

			const { promotedTask, savedPath } = await this.withCreateLock(async () => {
				const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId);
				// Same guard as creation: a stored dangling reference can name exactly this allocated
				// ID, so the record's dependencies are re-validated against its final identity. Only
				// the self/cycle guard matters here; stored entries that no longer resolve are legacy
				// defects doctor reports, so the stored list itself is written unchanged.
				await validateDependencies(draft.dependencies ?? [], this, { ...draft, id: newTaskId });
				const draftPath = current.filePath;

				const promotedTask: Task = {
					...draft,
					id: newTaskId,
					status: canonicalStatus,
					filePath: undefined,
					...(mutated || draft.status !== canonicalStatus
						? { updatedDate: new Date().toISOString().slice(0, 16).replace("T", " ") }
						: {}),
				};

				normalizeAssignee(promotedTask);
				const savedPath = await this.fs.saveTask(promotedTask);

				if (draftPath) {
					await unlink(draftPath);
				}

				return { promotedTask, savedPath };
			});

			const savedTask = await this.fs.loadTask(promotedTask.id);
			if (this.contentStore && savedTask) {
				this.contentStore.upsertTask(savedTask);
			}

			if (await this.shouldAutoCommit(autoCommit)) {
				await this.commitWrittenFile(
					`backlog: Promote draft ${normalizeId(reference.canonicalId, "draft")}`,
					[reference.filePath],
					savedPath,
				);
			}

			return savedTask ?? { ...promotedTask, filePath: savedPath };
		});
	}

	// Demotion is a read-modify-write of the task file too, reached from both updateTaskFromInput
	// and editTaskOrDraft, so it takes the task lock here rather than at each caller. Waiting on
	// the create lock below happens while the task lock is held; the order is always task lock
	// then create lock, never the reverse, so the two cannot deadlock.
	private async demoteTaskWithUpdates(
		task: Task,
		input: TaskUpdateInput,
		autoCommit?: boolean,
		options: TaskReadOptions = {},
	): Promise<TaskEditResult> {
		// Editing a task into the Draft status vacates its ID just as `task demote` does, so it
		// runs the same cleanup rather than leaving dependents pointing at the freed ID.
		return await this.withVacatedIdCleanup(task, task.id, async (cleanup) => {
			const current = await this.loadTaskForMutation(task.id, options);
			if (!current) {
				throw new Error(`Task not found: ${task.id}`);
			}

			const { mutated } = await this.applyTaskUpdateInput(current, { ...input, status: undefined }, async (status) => {
				if (status.trim().toLowerCase() === "draft") {
					return "Draft";
				}
				return this.requireCanonicalStatus(status);
			});

			// The record keeps its own links under the new draft identity, so a link naming the task
			// ID it is vacating would rebind to whatever task is allocated that ID next.
			const vacating = withoutVacatedTaskLinks(current, current.id) ?? current;

			const { demotedDraft, savedPath } = await this.withCreateLock(async () => {
				const newDraftId = await this.generateNextId(EntityType.Draft);
				// Mirrors promotion: the allocated draft ID can be named by a stored dangling
				// reference, so the demoted record must not materialize a cycle through it.
				await validateDependencies(vacating.dependencies ?? [], this, { ...vacating, id: newDraftId });
				const taskPath = current.filePath;

				const demotedDraft: Task = {
					...vacating,
					id: newDraftId,
					status: "Draft",
					filePath: undefined,
					...(mutated || current.status !== "Draft"
						? { updatedDate: new Date().toISOString().slice(0, 16).replace("T", " ") }
						: {}),
				};

				normalizeAssignee(demotedDraft);
				const savedPath = await this.fs.saveDraft(demotedDraft);

				if (taskPath) {
					await unlink(taskPath);
				}

				return { demotedDraft, savedPath };
			});

			// The draft is written and the task file is gone, so anything failing from here reports
			// the demotion as done, the way the dedicated demote command does.
			let cleanedTaskIds: string[] = [];
			let cleanedPaths: string[] = [];
			try {
				const written = await this.writeVacatedIdCleanup(cleanup);
				cleanedTaskIds = written.cleanedTaskIds;
				cleanedPaths = written.filePaths;
			} catch (error) {
				throw markRecordAlreadyMoved(error, "demotionState", "cleanup");
			}

			try {
				if (await this.shouldAutoCommit(autoCommit)) {
					const previousPaths = current.filePath ? [current.filePath] : [];
					await this.commitWrittenFile(
						`backlog: Demote task ${normalizeTaskId(current.id)}`,
						previousPaths,
						savedPath,
						cleanedPaths,
					);
				}
			} catch (error) {
				throw markRecordAlreadyMoved(error, "demotionState", "commit");
			}

			return {
				task: (await this.fs.loadDraft(demotedDraft.id)) ?? { ...demotedDraft, filePath: savedPath },
				cleanedTaskIds,
			};
		});
	}

	/**
	 * Execute the onStatusChange callback if configured.
	 * Per-task callback takes precedence over global config.
	 * Failures are logged but don't block the status change.
	 */
	private async executeStatusChangeCallback(task: Task, oldStatus: string, newStatus: string): Promise<void> {
		const config = await this.fs.loadConfig();

		// Per-task callback takes precedence over global config
		const callbackCommand = task.onStatusChange ?? config?.onStatusChange;
		if (!callbackCommand) {
			return;
		}

		try {
			const result = await executeStatusCallback({
				command: callbackCommand,
				taskId: task.id,
				oldStatus,
				newStatus,
				taskTitle: task.title,
				cwd: this.fs.rootDir,
			});

			if (!result.success) {
				console.error(`Status change callback failed for ${task.id}: ${result.error ?? "Unknown error"}`);
				if (result.output) {
					console.error(`Callback output: ${result.output}`);
				}
			} else if (process.env.DEBUG && result.output) {
				console.log(`Status change callback output for ${task.id}: ${result.output}`);
			}
		} catch (error) {
			console.error(`Failed to execute status change callback for ${task.id}:`, error);
		}
	}

	async editTask(
		taskId: string,
		input: TaskUpdateInput,
		autoCommit?: boolean,
		options: TaskReadOptions = {},
	): Promise<Task> {
		return await this.updateTaskFromInput(taskId, input, autoCommit, options);
	}

	private async writeTasksBulk(tasks: Task[]): Promise<string[]> {
		const filePaths: string[] = [];
		const updateAll = async () => {
			for (const task of tasks) {
				const filePath = await this.updateTask(task, false);
				filePaths.push(filePath);
				// Keep an in-process ContentStore serving what was just written: without this the
				// server, MCP and TUI keep reading the pre-write copy until a watcher refresh lands.
				this.contentStore?.upsertTask({ ...task, filePath });
			}
		};
		if (this.contentStore) await this.contentStore.batchTaskUpdates(updateAll);
		else await updateAll();
		return filePaths;
	}

	async updateTasksBulk(tasks: Task[], commitMessage?: string, autoCommit?: boolean): Promise<void> {
		const filePaths = await this.fs.withTaskLocks(tasks, async () => await this.writeTasksBulk(tasks));

		// Commit all changes at once if auto-commit is enabled
		if (await this.shouldAutoCommit(autoCommit)) {
			if (filePaths.length > 0) {
				await this.git.addFiles(filePaths);
				await this.git.commitFiles(commitMessage || `Update ${tasks.length} tasks`, filePaths);
			}
		}
	}

	/**
	 * Resolve the task ids of a board move against a freshly refreshed content store.
	 *
	 * Ids are trimmed and de-duplicated by normalized identity while keeping the caller's spelling so
	 * messages echo what was asked for. An identity that matches more than one file fails closed with
	 * the ambiguity error instead of picking a winner. An id the store does not know comes back as
	 * `task: null` with no error, because a gap means different things to different callers.
	 *
	 * The failure semantics stay with the callers on purpose: {@link reorderTask} raises the first
	 * problem and writes all or nothing, while {@link moveTasksToStatus} reports problems per task and
	 * moves the tasks that did resolve.
	 */
	private async resolveTasksForBoardMove(taskIds: readonly string[]): Promise<{
		store: ContentStore;
		resolutions: Array<{ taskId: string; task: Task | null; ambiguity: AmbiguousTaskIdError | null }>;
	}> {
		const requestedIds: string[] = [];
		const seen = new Set<string>();
		for (const rawId of taskIds) {
			const trimmed = String(rawId || "").trim();
			if (!trimmed) continue;
			// Canonical identity collapses cosmetic spellings such as leading zeros, so TASK-1 and
			// TASK-01 cannot both survive and write the same task twice.
			const key = canonicalTaskId(trimmed);
			if (seen.has(key)) continue;
			seen.add(key);
			requestedIds.push(trimmed);
		}

		const store = await this.getContentStore();
		await store.refreshTasks();

		const resolutions = requestedIds.map((taskId) => {
			const resolution = store.resolveTaskForMutation(normalizeTaskId(taskId));
			if (resolution.status === "ambiguous") {
				return { taskId, task: null, ambiguity: new AmbiguousTaskIdError(taskId, resolution.candidates) };
			}
			return { taskId, task: resolution.status === "found" ? resolution.task : null, ambiguity: null };
		});

		return { store, resolutions };
	}

	async reorderTask(params: {
		taskId: string;
		targetStatus: string;
		orderedTaskIds: string[];
		targetMilestone?: string | null;
		commitMessage?: string;
		autoCommit?: boolean;
		defaultStep?: number;
	}): Promise<{ updatedTask: Task; changedTasks: Task[] }> {
		const taskId = normalizeTaskId(String(params.taskId || "").trim());
		const targetStatus = String(params.targetStatus || "").trim();
		const orderedTaskIds = params.orderedTaskIds.map((id) => normalizeTaskId(String(id || "").trim())).filter(Boolean);
		const defaultStep = params.defaultStep ?? DEFAULT_ORDINAL_STEP;

		if (!taskId) throw new Error("taskId is required");
		if (!targetStatus) throw new Error("targetStatus is required");
		if (orderedTaskIds.length === 0) throw new Error("orderedTaskIds must include at least one task");
		if (!orderedTaskIds.includes(taskId)) {
			throw new Error("orderedTaskIds must include the task being moved");
		}

		// A repeated id means the caller sent a corrupt ordering, so reject it rather than let the
		// shared resolver quietly drop it and reorder the column into an order nobody asked for.
		const seen = new Set<string>();
		for (const id of orderedTaskIds) {
			if (seen.has(id)) {
				throw new Error(`Duplicate task id ${id} in orderedTaskIds`);
			}
			seen.add(id);
		}

		const { resolutions } = await this.resolveTasksForBoardMove(orderedTaskIds);
		for (const resolution of resolutions) {
			if (resolution.ambiguity) throw resolution.ambiguity;
		}

		// Tasks that couldn't be loaded (may have been moved/deleted) drop out of the ordering
		const validTasks = resolutions.map((resolution) => resolution.task).filter((t): t is Task => t !== null);

		// Verify the moved task itself exists
		const movedTask = validTasks.find((t) => t.id === taskId);
		if (!movedTask) {
			throw new Error(`Task ${taskId} not found while reordering`);
		}

		// Reject reordering tasks from other branches - they can only be modified in their source branch
		const crossBranchReason = crossBranchMoveReason(movedTask, "reordered");
		if (crossBranchReason) {
			throw new Error(crossBranchReason);
		}

		const hasTargetMilestone = params.targetMilestone !== undefined;
		const normalizedTargetMilestone = normalizeTargetMilestone(params.targetMilestone);

		// Calculate target index within the valid tasks list
		const validOrderedIds = orderedTaskIds.filter((id) => validTasks.some((t) => t.id === id));
		const targetIndex = validOrderedIds.indexOf(taskId);

		if (targetIndex === -1) {
			throw new Error("Implementation error: Task found in validTasks but index missing");
		}

		const previousTask = targetIndex > 0 ? validTasks[targetIndex - 1] : null;
		const nextTask = targetIndex < validTasks.length - 1 ? validTasks[targetIndex + 1] : null;

		const { ordinal: newOrdinal, requiresRebalance } = calculateNewOrdinal({
			previous: previousTask,
			next: nextTask,
			defaultStep,
		});

		const updatedMoved: Task = {
			...movedTask,
			status: targetStatus,
			...(hasTargetMilestone ? { milestone: normalizedTargetMilestone } : {}),
			ordinal: newOrdinal,
		};

		const tasksInOrder: Task[] = validTasks.map((task, index) => (index === targetIndex ? updatedMoved : task));
		const resolutionUpdates = resolveOrdinalConflicts(tasksInOrder, {
			defaultStep,
			startOrdinal: defaultStep,
			forceSequential: requiresRebalance,
		});

		const updatesMap = new Map<string, Task>();
		for (const update of resolutionUpdates) {
			updatesMap.set(update.id, update);
		}
		if (!updatesMap.has(updatedMoved.id)) {
			updatesMap.set(updatedMoved.id, updatedMoved);
		}

		const originalMap = new Map(validTasks.map((task) => [task.id, task]));
		const changedTasks = Array.from(updatesMap.values()).filter((task) => {
			const original = originalMap.get(task.id);
			if (!original) return true;
			return (
				(original.ordinal ?? null) !== (task.ordinal ?? null) ||
				(original.status ?? "") !== (task.status ?? "") ||
				(original.milestone ?? "") !== (task.milestone ?? "")
			);
		});

		if (changedTasks.length > 0) {
			await this.updateTasksBulk(
				changedTasks,
				params.commitMessage ?? `Reorder tasks in ${targetStatus}`,
				params.autoCommit,
			);
		}

		const updatedTask = updatesMap.get(taskId) ?? updatedMoved;
		return { updatedTask, changedTasks };
	}

	/**
	 * Move a set of tasks into a status column, reporting problems per task instead of aborting the
	 * batch. Without `orderedTaskIds` the moved tasks append to the end of the column. With it, the
	 * caller names the column's final order and the moved tasks land exactly there, seeded with
	 * block ordinals the way {@link reorderTask} places a single task.
	 */
	async moveTasksToStatus(params: {
		taskIds: string[];
		targetStatus: string;
		orderedTaskIds?: string[];
		targetMilestone?: string | null;
		commitMessage?: string;
		autoCommit?: boolean;
		defaultStep?: number;
	}): Promise<{ movedTasks: Task[]; changedTasks: Task[]; failures: Array<{ taskId: string; reason: string }> }> {
		const targetStatus = String(params.targetStatus || "").trim();
		if (!targetStatus) throw new Error("targetStatus is required");
		const defaultStep = params.defaultStep ?? DEFAULT_ORDINAL_STEP;

		const { store, resolutions } = await this.resolveTasksForBoardMove(params.taskIds);
		if (resolutions.length === 0) throw new Error("taskIds must include at least one task");

		const failures: Array<{ taskId: string; reason: string }> = [];
		const tasksToMove: Task[] = [];
		for (const { taskId, task, ambiguity } of resolutions) {
			if (ambiguity) {
				failures.push({ taskId, reason: ambiguity.message });
				continue;
			}
			if (!task) {
				failures.push({ taskId, reason: `Task ${taskId} not found.` });
				continue;
			}
			const crossBranchReason = crossBranchMoveReason(task, "moved");
			if (crossBranchReason) {
				failures.push({ taskId, reason: crossBranchReason });
				continue;
			}
			tasksToMove.push(task);
		}

		if (tasksToMove.length === 0) {
			return { movedTasks: [], changedTasks: [], failures };
		}

		// A drop into a milestone lane means the lane as much as the column, so the batch carries the
		// same milestone semantics as a single-task reorder: the field is only touched when the caller
		// names a lane, and the board's no-milestone lane clears it.
		const hasTargetMilestone = params.targetMilestone !== undefined;
		const normalizedTargetMilestone = normalizeTargetMilestone(params.targetMilestone);

		const movedIds = new Set(tasksToMove.map((task) => task.id));
		const applyMove = (task: Task): Task => ({
			...task,
			status: targetStatus,
			...(hasTargetMilestone ? { milestone: normalizedTargetMilestone } : {}),
		});

		let movedTasks: Task[];
		let changedTasks: Task[];

		if (params.orderedTaskIds) {
			// The caller names the target column's final order, so the moved tasks land exactly where
			// the board previewed them instead of appending to the end.
			const seenOrdered = new Set<string>();
			for (const id of params.orderedTaskIds) {
				const key = canonicalTaskId(id);
				if (seenOrdered.has(key)) throw new Error(`Duplicate task ID in orderedTaskIds: ${id}`);
				seenOrdered.add(key);
			}
			for (const task of tasksToMove) {
				if (!seenOrdered.has(canonicalTaskId(task.id))) {
					throw new Error("orderedTaskIds must include every task being moved");
				}
			}

			const movedByKey = new Map(tasksToMove.map((task) => [canonicalTaskId(task.id), task]));
			// A task that failed to resolve is not moving, so it keeps its place and stays out of the
			// target column's ordering.
			const failedKeys = new Set(failures.map((failure) => canonicalTaskId(failure.taskId)));
			const rows: Array<{ task: Task; moved: boolean }> = [];
			for (const id of params.orderedTaskIds) {
				const key = canonicalTaskId(id);
				if (failedKeys.has(key)) continue;
				const movedTask = movedByKey.get(key);
				if (movedTask) {
					rows.push({ task: movedTask, moved: true });
					continue;
				}
				const resolution = store.resolveTaskForMutation(key);
				if (resolution.status === "ambiguous") throw new AmbiguousTaskIdError(id, resolution.candidates);
				// Tasks that couldn't be loaded (may have been moved/deleted) drop out of the ordering
				if (resolution.status === "found") rows.push({ task: resolution.task, moved: false });
			}

			// Seed each run of moved tasks with block ordinals between its unmoved neighbors, exactly
			// as a single-task reorder seeds its midpoint, then let conflict resolution settle the rest.
			let requiresRebalance = false;
			const tasksInOrder: Task[] = [];
			for (let index = 0; index < rows.length; ) {
				const row = rows[index];
				if (!row) break;
				if (!row.moved) {
					tasksInOrder.push(row.task);
					index += 1;
					continue;
				}
				let runEnd = index;
				while (runEnd < rows.length && rows[runEnd]?.moved) runEnd += 1;
				const block = calculateBlockOrdinals({
					previous: index > 0 ? (rows[index - 1]?.task ?? null) : null,
					next: rows[runEnd]?.task ?? null,
					count: runEnd - index,
					defaultStep,
				});
				requiresRebalance = requiresRebalance || block.requiresRebalance;
				for (let offset = index; offset < runEnd; offset += 1) {
					const movedRow = rows[offset];
					if (!movedRow) continue;
					tasksInOrder.push({ ...applyMove(movedRow.task), ordinal: block.ordinals[offset - index] });
				}
				index = runEnd;
			}

			const resolutionUpdates = resolveOrdinalConflicts(tasksInOrder, {
				defaultStep,
				startOrdinal: defaultStep,
				forceSequential: requiresRebalance,
			});
			const updatesMap = new Map(tasksInOrder.map((task) => [task.id, task]));
			for (const update of resolutionUpdates) {
				updatesMap.set(update.id, update);
			}

			const originalMap = new Map([
				...rows.map(({ task }) => [task.id, task] as const),
				...tasksToMove.map((task) => [task.id, task] as const),
			]);
			movedTasks = tasksToMove.map((task) => updatesMap.get(task.id) ?? applyMove(task));
			changedTasks = Array.from(updatesMap.values()).filter((task) => {
				const original = originalMap.get(task.id);
				if (!original) return true;
				return (
					(original.status ?? "") !== (task.status ?? "") ||
					(original.ordinal ?? null) !== (task.ordinal ?? null) ||
					(original.milestone ?? "") !== (task.milestone ?? "")
				);
			});
		} else {
			// A task already in the target column is not moving, so it keeps its place and ordinal;
			// only a named lane still applies to it. Everything else appends after the column as
			// rendered.
			const stayingIds = new Set(tasksToMove.filter((task) => task.status === targetStatus).map((task) => task.id));
			const arriving = tasksToMove.filter((task) => !stayingIds.has(task.id));

			if (arriving.length === 0) {
				movedTasks = tasksToMove.map((task) => applyMove(task));
				changedTasks = movedTasks.filter((task, index) => {
					const original = tasksToMove[index];
					if (!original) return true;
					return original.status !== task.status || (original.milestone ?? "") !== (task.milestone ?? "");
				});
			} else {
				// Ordinal-less column tasks render after ordinal-bearing ones, so they get materialized
				// ordinals rather than letting the appended tasks slot in above them, and a non-finite
				// ordinal from a corrupt file counts as missing instead of poisoning the column.
				// A named lane scopes the ordering to that lane: a drop into Milestone A must not
				// renumber cards that only share the status in other lanes. Staying tasks remain in
				// scope regardless, because a named lane still has to be applied to them.
				const sanitizeOrdinal = (task: Task): Task =>
					task.ordinal === undefined || Number.isFinite(task.ordinal) ? task : { ...task, ordinal: undefined };
				const inTargetLane = (task: Task): boolean =>
					!hasTargetMilestone || (task.milestone?.trim() || "") === (normalizedTargetMilestone ?? "");
				const columnTasks = sortByOrdinal(
					store
						.getTasks({ status: targetStatus })
						.filter((task) => (stayingIds.has(task.id) ? true : !movedIds.has(task.id) && inTargetLane(task)))
						.map(sanitizeOrdinal),
				);
				const tasksInOrder: Task[] = [
					...columnTasks.map((task) => (stayingIds.has(task.id) ? applyMove(task) : task)),
					...arriving.map((task) => ({ ...applyMove(task), ordinal: undefined })),
				];
				const resolutionUpdates = resolveOrdinalConflicts(tasksInOrder, { defaultStep, startOrdinal: defaultStep });
				const updatesMap = new Map(tasksInOrder.map((task) => [task.id, task]));
				for (const update of resolutionUpdates) {
					updatesMap.set(update.id, update);
				}

				const originalMap = new Map([
					...store.getTasks({ status: targetStatus }).map((task) => [task.id, task] as const),
					...tasksToMove.map((task) => [task.id, task] as const),
				]);
				movedTasks = tasksToMove.map((task) => updatesMap.get(task.id) ?? applyMove(task));
				changedTasks = Array.from(updatesMap.values()).filter((task) => {
					const original = originalMap.get(task.id);
					if (!original) return true;
					return (
						(original.status ?? "") !== (task.status ?? "") ||
						(original.ordinal ?? null) !== (task.ordinal ?? null) ||
						(original.milestone ?? "") !== (task.milestone ?? "")
					);
				});
			}
		}

		// A cross-branch card can constrain the ordering, but writing it here would create a local
		// copy of a task the board treats as read-only. It keeps its file untouched on its own branch.
		changedTasks = changedTasks.filter((task) => !task.branch);

		if (changedTasks.length > 0) {
			await this.updateTasksBulk(
				changedTasks,
				params.commitMessage ?? `Move ${changedTasks.length} tasks to ${targetStatus}`,
				params.autoCommit,
			);
		}

		return { movedTasks, changedTasks, failures };
	}

	async archiveTask(taskId: string, autoCommit?: boolean, options: TaskReadOptions = {}): Promise<VacatedTaskResult> {
		const taskToArchive = await this.loadTaskForMutation(taskId, options);
		if (!taskToArchive) {
			return { success: false, cleanedTaskIds: [] };
		}
		const normalizedTaskId = taskToArchive.id;

		// Get paths before moving the file
		const taskPath = taskToArchive.filePath ?? (await getTaskPath(normalizedTaskId, this));
		const taskFilename = taskPath ? basename(taskPath) : null;

		if (!taskPath || !taskFilename) return { success: false, cleanedTaskIds: [] };

		const fromPath = taskPath;
		const toPath = join(await this.fs.getArchiveTasksDir(), taskFilename);

		return await this.withVacatedIdCleanup(taskToArchive, normalizedTaskId, async (cleanup) => {
			try {
				await moveFile(fromPath, toPath);
			} catch {
				return { success: false, cleanedTaskIds: [] };
			}
			this.contentStore?.transitionTask(normalizedTaskId);

			// The file is in the archive from here on. A cleanup write or a commit that fails after
			// this point says so, rather than letting a caller retry an archive that already ran.
			try {
				const { cleanedTaskIds, filePaths } = await this.writeVacatedIdCleanup(cleanup);

				if (await this.shouldAutoCommit(autoCommit)) {
					// Stage the file move for proper Git tracking
					const repoRoot = await this.git.stageFileMove(fromPath, toPath);
					const commitPaths = [fromPath, toPath, ...filePaths];
					for (const cleanedPath of filePaths) {
						await this.git.addFile(cleanedPath);
					}
					await this.git.commitFiles(`backlog: Archive task ${normalizedTaskId}`, commitPaths, repoRoot);
				}

				return { success: true, cleanedTaskIds };
			} catch (error) {
				throw markRecordAlreadyMoved(error, "archiveState");
			}
		});
	}

	async archiveMilestone(
		identifier: string,
		autoCommit?: boolean,
	): Promise<{ success: boolean; sourcePath?: string; targetPath?: string; milestone?: Milestone }> {
		// Read the config before the move, so a config Backlog refuses to read aborts the command
		// while the milestone is still active rather than after it has been archived.
		const autoCommitEnabled = await this.shouldAutoCommit(autoCommit);
		const result = await this.fs.archiveMilestone(identifier);

		if (result.success && result.sourcePath && result.targetPath && autoCommitEnabled) {
			const repoRoot = await this.git.stageFileMove(result.sourcePath, result.targetPath);
			const label = result.milestone?.id ? ` ${result.milestone.id}` : "";
			const commitPaths = [result.sourcePath, result.targetPath];
			try {
				await this.git.commitFiles(`backlog: Archive milestone${label}`, commitPaths, repoRoot);
			} catch (error) {
				await this.git.resetPaths(commitPaths, repoRoot);
				try {
					await moveFile(result.targetPath, result.sourcePath);
				} catch {
					// Ignore rollback failure and propagate original commit error.
				}
				throw error;
			}
		}

		return {
			success: result.success,
			sourcePath: result.sourcePath,
			targetPath: result.targetPath,
			milestone: result.milestone,
		};
	}

	async renameMilestone(
		identifier: string,
		title: string,
		autoCommit?: boolean,
		dueDate?: string | null,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		milestone?: Milestone;
		previousTitle?: string;
		previousDueDate?: string;
	}> {
		const result = await this.fs.renameMilestone(identifier, title, dueDate);
		if (!result.success) {
			return result;
		}

		if (result.sourcePath && result.targetPath && (await this.shouldAutoCommit(autoCommit))) {
			const repoRoot = await this.git.stageFileMove(result.sourcePath, result.targetPath);
			const label = result.milestone?.id ? ` ${result.milestone.id}` : "";
			const commitPaths = [result.sourcePath, result.targetPath];
			try {
				await this.git.commitFiles(`backlog: Rename milestone${label}`, commitPaths, repoRoot);
			} catch (error) {
				await this.git.resetPaths(commitPaths, repoRoot);
				const rollbackTitle = result.previousTitle ?? title;
				try {
					await this.fs.renameMilestone(
						result.milestone?.id ?? identifier,
						rollbackTitle,
						result.previousDueDate ?? null,
					);
				} catch {
					// Ignore rollback failure and propagate original commit error.
				}
				throw error;
			}
		}

		return result;
	}

	async completeTask(taskId: string, autoCommit?: boolean, options: TaskReadOptions = {}): Promise<boolean> {
		const task = await this.loadTaskForMutation(taskId, options);
		if (!task) return false;
		// Get paths before moving the file
		const completedDir = this.fs.completedDir;
		const taskPath = task.filePath ?? (await getTaskPath(task.id, this));
		const taskFilename = taskPath ? basename(taskPath) : null;

		if (!taskPath || !taskFilename) return false;

		const fromPath = taskPath;
		const toPath = join(completedDir, taskFilename);

		try {
			await moveFile(fromPath, toPath);
		} catch {
			return false;
		}
		this.contentStore?.transitionTask(task.id, { ...task, filePath: toPath, source: "completed" });

		if (await this.shouldAutoCommit(autoCommit)) {
			// Stage the file move for proper Git tracking
			const repoRoot = await this.git.stageFileMove(fromPath, toPath);
			await this.git.commitFiles(`backlog: Complete task ${task.id}`, [fromPath, toPath], repoRoot);
		}

		return true;
	}

	async getTerminalStatusTasksByAge(olderThanDays: number): Promise<Task[]> {
		const tasks = await this.fs.listTasks();
		const config = await this.fs.loadConfig();
		const statuses = config?.statuses ?? [...DEFAULT_STATUSES];
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

		return tasks.filter((task) => {
			if (!isTerminalStatus(task.status, statuses)) return false;

			// Check updatedDate first, then createdDate as fallback
			const taskDate = task.updatedDate || task.createdDate;
			if (!taskDate) return false;

			const date = new Date(taskDate);
			return date < cutoffDate;
		});
	}

	async archiveDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		// Read the config before the move: a config Backlog refuses to read must abort the command
		// while the draft is still where the user left it, not after it has been half-archived.
		const autoCommitEnabled = await this.shouldAutoCommit(autoCommit);
		const moved = await this.fs.archiveDraft(draftId);

		if (moved && autoCommitEnabled) {
			await this.commitWrittenFile(
				`backlog: Archive draft ${normalizeId(draftId, "draft")}`,
				[moved.sourcePath],
				moved.targetPath,
			);
		}

		return moved !== null;
	}

	async promoteDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		// Whole-file operation: filename binding decides which file is promoted, so resolution
		// goes through the file resolver and frontmatter equivalence is not required.
		const sourcePath = await this.fs.resolveDraftFilePath(draftId);
		if (!sourcePath) return false;
		const canonicalId = extractDraftIdFromFilename(basename(sourcePath));
		if (!canonicalId) return false;

		// Hold the draft lock across the read-unlink span so a concurrent edit cannot be omitted
		// from the promoted task or leave both records on disk. Draft lock first, create lock
		// second: nothing acquires them in the opposite order, so this cannot deadlock.
		return await this.fs.withDraftLock({ filePath: sourcePath, canonicalId }, async () => {
			let moved: { previousPath: string; savedPath: string } | null = null;
			try {
				moved = await this.withCreateLock(async () => {
					const draft = await this.fs.loadDraftFromFile(sourcePath);
					if (!draft) return null;

					const config = await this.fs.loadConfig();
					const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId);
					const promotedStatus =
						!draft.status || draft.status.trim().toLowerCase() === "draft"
							? config?.defaultStatus || FALLBACK_STATUS
							: draft.status;

					const promotedTask: Task = {
						...draft,
						id: newTaskId,
						status: promotedStatus,
						filePath: undefined,
					};

					normalizeAssignee(promotedTask);
					const savedPath = await this.fs.saveTask(promotedTask);
					await unlink(sourcePath);

					const savedTask = await this.fs.loadTask(promotedTask.id);
					if (this.contentStore && savedTask) {
						this.contentStore.upsertTask(savedTask);
					}

					return { previousPath: sourcePath, savedPath };
				});
			} catch (error) {
				// A missing draft is the only thing "false" may mean here; a config value Backlog refuses to
				// read must not be reported as a draft that does not exist.
				if (isCreateLockError(error) || isConfigValueError(error)) {
					throw error;
				}
				return false;
			}

			if (moved && (await this.shouldAutoCommit(autoCommit))) {
				await this.commitWrittenFile(
					`backlog: Promote draft ${normalizeId(draftId, "draft")}`,
					[moved.previousPath],
					moved.savedPath,
				);
			}

			return moved !== null;
		});
	}

	async demoteTask(taskId: string, autoCommit?: boolean, options: TaskReadOptions = {}): Promise<VacatedTaskResult> {
		const task = await this.loadTaskForMutation(taskId, options);
		if (!task) return { success: false, cleanedTaskIds: [] };
		// Direct demotion is a read-modify-write too. Hold the task lock across the
		// filesystem read and move so an in-flight task update cannot recreate the
		// active file after this operation has written the draft. The record demoted here also
		// vacates its task ID, so the dependents are locked and cleaned in the same span.
		const demotion = {
			success: false,
			moved: undefined as { previousPath: string; savedPath: string } | undefined,
			cleanedTaskIds: [] as string[],
			cleanedPaths: [] as string[],
		};
		let result: typeof demotion;
		try {
			result = await this.withVacatedIdCleanup(task, task.id, async (cleanup) => {
				const movedPaths: Array<{ previousPath: string; savedPath: string }> = [];
				const success = await this.fs.demoteTask(task.id, (previousPath, savedPath) => {
					movedPaths.push({ previousPath, savedPath });
				});
				// Record the move before anything that can fail after it. A cleanup write that
				// throws must still report the demotion as "moved", or a client is told the task
				// is untouched and retries a demotion that already happened.
				demotion.success = success;
				demotion.moved = movedPaths[0];
				if (success) {
					this.contentStore?.transitionTask(task.id);
					try {
						const written = await this.writeVacatedIdCleanup(cleanup);
						demotion.cleanedTaskIds = written.cleanedTaskIds;
						demotion.cleanedPaths = written.filePaths;
					} catch (error) {
						throw markRecordAlreadyMoved(error, "demotionState", "cleanup");
					}
				}
				return demotion;
			});
		} catch (error) {
			// The lock wrapper can fail while releasing after the move completed. Keep
			// the mutation outcome visible to the Web API and other clients.
			if (demotion.success && demotion.moved) {
				throw markRecordAlreadyMoved(error, "demotionState");
			}
			throw error;
		}
		const { success, moved, cleanedTaskIds, cleanedPaths } = result;

		if (success && moved) {
			try {
				if (await this.shouldAutoCommit(autoCommit)) {
					await this.commitWrittenFile(
						`backlog: Demote task ${task.id}`,
						[moved.previousPath],
						moved.savedPath,
						cleanedPaths,
					);
				}
			} catch (error) {
				throw markRecordAlreadyMoved(error, "demotionState", "commit");
			}
		}

		return { success, cleanedTaskIds };
	}

	/**
	 * Add acceptance criteria to a task
	 */
	async addAcceptanceCriteria(taskId: string, criteria: string[], autoCommit?: boolean): Promise<void> {
		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Get existing criteria or initialize empty array
		const current = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];

		// Calculate next index (1-based)
		let nextIndex = current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;

		// Append new criteria
		const newCriteria = criteria.map((text) => ({ index: nextIndex++, text, checked: false }));
		task.acceptanceCriteriaItems = [...current, ...newCriteria];

		// Save the task
		await this.updateTask(task, autoCommit);
	}

	/**
	 * Remove acceptance criteria by indices (supports batch operations)
	 * @returns Array of removed indices
	 */
	async removeAcceptanceCriteria(taskId: string, indices: number[], autoCommit?: boolean): Promise<number[]> {
		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		let list = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];
		const removed: number[] = [];

		// Sort indices in descending order to avoid index shifting issues
		const sortedIndices = [...indices].sort((a, b) => b - a);

		for (const idx of sortedIndices) {
			const before = list.length;
			list = list.filter((c) => c.index !== idx);
			if (list.length < before) {
				removed.push(idx);
			}
		}

		if (removed.length === 0) {
			throw new Error("No criteria were removed. Check that the specified indices exist.");
		}

		// Re-index remaining items (1-based)
		list = list.map((c, i) => ({ ...c, index: i + 1 }));
		task.acceptanceCriteriaItems = list;

		// Save the task
		await this.updateTask(task, autoCommit);

		return removed.sort((a, b) => a - b); // Return in ascending order
	}

	/**
	 * Check or uncheck acceptance criteria by indices (supports batch operations)
	 * Silently ignores invalid indices and only updates valid ones.
	 * @returns Array of updated indices
	 */
	async checkAcceptanceCriteria(
		taskId: string,
		indices: number[],
		checked: boolean,
		autoCommit?: boolean,
	): Promise<number[]> {
		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		let list = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];
		const updated: number[] = [];

		// Filter to only valid indices and update them
		for (const idx of indices) {
			if (list.some((c) => c.index === idx)) {
				list = list.map((c) => {
					if (c.index === idx) {
						updated.push(idx);
						return { ...c, checked };
					}
					return c;
				});
			}
		}

		if (updated.length === 0) {
			throw new Error("No criteria were updated.");
		}

		task.acceptanceCriteriaItems = list;

		// Save the task
		await this.updateTask(task, autoCommit);

		return updated.sort((a, b) => a - b);
	}

	/**
	 * List all acceptance criteria for a task
	 */
	async listAcceptanceCriteria(taskId: string): Promise<AcceptanceCriterion[]> {
		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		return task.acceptanceCriteriaItems || [];
	}

	/**
	 * Stage and commit a single written file, scoped to exactly the paths this write touched
	 * (the new file, plus any previous paths it replaced). Never sweeps in unrelated dirty state.
	 */
	private async commitWrittenFile(
		message: string,
		previousPaths: string[],
		newPath: string,
		alsoWrittenPaths: string[] = [],
	): Promise<void> {
		for (const writtenPath of alsoWrittenPaths) {
			await this.git.addFile(writtenPath);
		}
		if (previousPaths.length > 0) {
			let repoRoot: string | null = null;
			for (const previousPath of previousPaths) {
				repoRoot = await this.git.stageFileMove(previousPath, newPath);
			}
			await this.git.commitFiles(message, [...previousPaths, newPath, ...alsoWrittenPaths], repoRoot);
		} else {
			await this.git.addFile(newPath);
			await this.git.commitFiles(message, [newPath, ...alsoWrittenPaths]);
		}
	}

	async createDecision(decision: Decision, autoCommit?: boolean): Promise<void> {
		const { filepath, removedFilepaths } = await this.fs.saveDecision(decision);

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.commitWrittenFile(`backlog: Add decision ${decision.id}`, removedFilepaths, filepath);
		}
	}

	async updateDecisionFromContent(decisionId: string, content: string, autoCommit?: boolean): Promise<void> {
		const existingDecision = await this.fs.loadDecision(decisionId);
		if (!existingDecision) {
			throw new Error(`Decision ${decisionId} not found`);
		}

		// Parse the markdown content to extract the decision data
		const frontmatter = parseFrontmatter(content).data as Partial<Pick<Decision, "title" | "status" | "date">>;

		const extractSection = (content: string, sectionName: string): string | undefined => {
			const regex = new RegExp(`## ${sectionName}\\s*([\\s\\S]*?)(?=## |$)`, "i");
			const match = content.match(regex);
			return match ? match[1]?.trim() : undefined;
		};

		const updatedDecision = {
			...existingDecision,
			title: frontmatter.title || existingDecision.title,
			status: frontmatter.status || existingDecision.status,
			date: frontmatter.date || existingDecision.date,
			context: extractSection(content, "Context") || existingDecision.context,
			decision: extractSection(content, "Decision") || existingDecision.decision,
			consequences: extractSection(content, "Consequences") || existingDecision.consequences,
			alternatives: extractSection(content, "Alternatives") || existingDecision.alternatives,
		};

		await this.createDecision(updatedDecision, autoCommit);
	}

	async createDecisionWithTitle(title: string, autoCommit?: boolean): Promise<Decision> {
		const id = await generateNextDecisionId(this);

		const decision: Decision = {
			id,
			title,
			date: new Date().toISOString().slice(0, 16).replace("T", " "),
			status: "proposed",
			context: "[Describe the context and problem that needs to be addressed]",
			decision: "[Describe the decision that was made]",
			consequences: "[Describe the consequences of this decision]",
			rawContent: "",
		};

		await this.createDecision(decision, autoCommit);
		return decision;
	}

	async createDocument(doc: Document, autoCommit?: boolean, subPath = ""): Promise<void> {
		const { relativePath, removedFilepaths } = await this.fs.saveDocument(doc, normalizeDocumentSubPath(subPath));
		doc.path = relativePath;

		if (await this.shouldAutoCommit(autoCommit)) {
			const docsDir = this.fs.docsDir;
			const absolutePath = join(docsDir, ...relativePath.split("/"));
			await this.commitWrittenFile(`backlog: Add document ${doc.id}`, removedFilepaths, absolutePath);
		}
	}

	async updateDocument(existingDoc: Document, content: string, autoCommit?: boolean): Promise<void> {
		await this.updateDocumentFromInput(
			{
				id: existingDoc.id,
				title: existingDoc.title,
				type: existingDoc.type,
				tags: existingDoc.tags,
				content,
				...(existingDoc.path !== undefined && { path: getDocumentSubPathFromRelativePath(existingDoc.path) }),
			},
			autoCommit,
		);
	}

	async createDocumentWithId(title: string, content: string, autoCommit?: boolean): Promise<Document> {
		return await this.createDocumentFromInput({ title, content }, autoCommit);
	}

	async createDocumentFromInput(input: DocumentCreateInput, autoCommit?: boolean): Promise<Document> {
		const title = input.title.trim();
		if (!title) {
			throw new Error("Title is required to create a document.");
		}

		const subPath = normalizeDocumentSubPath(input.path);
		const tags = normalizeStringList(input.tags);
		const type = normalizeDocumentTypeInput(input.type) ?? "other";
		const document = await this.withCreateLock(async () => {
			const id = normalizeDocumentId(await generateNextDocId(this));
			const document: Document = {
				id,
				title,
				type,
				createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
				rawContent: input.content ?? "",
				...(tags && tags.length > 0 && { tags }),
			};

			await this.createDocument(document, autoCommit, subPath);
			return document;
		});

		return (await this.getDocument(document.id)) ?? document;
	}

	async updateDocumentFromInput(input: DocumentUpdateInput, autoCommit?: boolean): Promise<Document> {
		const existingDoc = await this.getDocument(input.id);
		if (!existingDoc) {
			throw new Error(`Document not found: ${input.id}`);
		}

		const normalizedTitle = input.title?.trim();
		if (input.title !== undefined && !normalizedTitle) {
			throw new Error("Document title cannot be empty.");
		}

		const tags = input.tags !== undefined ? normalizeStringList(input.tags) : existingDoc.tags;
		const type = normalizeDocumentTypeInput(input.type) ?? existingDoc.type;
		const subPath =
			input.path === undefined
				? getDocumentSubPathFromRelativePath(existingDoc.path)
				: normalizeDocumentSubPath(input.path);
		const updatedDoc: Document = {
			...existingDoc,
			id: normalizeDocumentId(existingDoc.id),
			title: normalizedTitle ?? existingDoc.title,
			type,
			rawContent: input.content,
			updatedDate: new Date().toISOString().slice(0, 16).replace("T", " "),
			tags: tags && tags.length > 0 ? tags : undefined,
		};

		await this.createDocument(updatedDoc, autoCommit, subPath);
		return (await this.getDocument(existingDoc.id)) ?? updatedDoc;
	}

	async listTasksWithMetadata(filesystem = this.fs): Promise<Array<Task & { lastModified?: Date }>> {
		const tasks = await filesystem.listTasks();
		return await Promise.all(
			tasks.map(async (task) => {
				const filePath = task.filePath ?? (await getTaskPath(task.id, { filesystem }));

				if (filePath) {
					const bunFile = Bun.file(filePath);
					const stats = await bunFile.stat();
					return {
						...task,
						lastModified: new Date(stats.mtime),
					};
				}
				return task;
			}),
		);
	}

	/**
	 * Load and process all tasks with the same logic as CLI overview
	 * This method extracts the common task loading logic for reuse
	 */
	async loadAllTasksForStatistics(
		progressCallback?: (msg: string) => void,
	): Promise<{ tasks: Task[]; drafts: Task[]; statuses: string[]; priorities: string[] }> {
		const snapshot = await this.loadTaskCorpusSnapshot(progressCallback);
		const config = snapshot.config;
		const statuses = (config?.statuses || DEFAULT_STATUSES) as string[];
		const priorities = config?.priorities ?? [];
		if (!snapshot.identityIndex) throw new Error("Task corpus identity index was not initialized");
		const tasks = snapshot.identityIndex.getTasks(true);

		// Load drafts
		progressCallback?.("Loading drafts...");
		const drafts = await this.fs.listDrafts();

		return { tasks, drafts, statuses: statuses as string[], priorities };
	}

	/**
	 * Load all tasks with cross-branch support
	 * This is the single entry point for loading tasks across all interfaces
	 */
	async loadTasks(
		progressCallback?: (msg: string) => void,
		abortSignal?: AbortSignal,
		options?: { includeCompleted?: boolean },
	): Promise<Task[]> {
		return (
			await this.buildTaskCorpusSnapshot({
				progressCallback,
				abortSignal,
				includeCompleted: options?.includeCompleted,
			})
		).tasks;
	}

	private async loadTaskCorpusSnapshot(
		progressCallback?: (message: string) => void,
		options?: { publishSharedState?: boolean },
	): Promise<TaskCorpusSnapshot> {
		return await this.buildTaskCorpusSnapshot({
			progressCallback,
			includeCompleted: true,
			visibleCompleted: false,
			publishSharedState: options?.publishSharedState,
		});
	}

	/**
	 * The ContentStore's corpus loader. By default its result becomes the shared cross-branch
	 * state; pass { publish: false } for a throwaway load (e.g. resolving one task's identity)
	 * whose result must not be installed on the store's behalf.
	 */
	private async loadContentStoreCorpus(
		progressCallback?: (message: string) => void,
		options?: { publish?: boolean },
	): Promise<TaskCorpusSnapshot> {
		if (Object.hasOwn(this, "loadTasks")) {
			const [activeTasks, completedTasks, config] = await Promise.all([
				this.loadTasks(progressCallback),
				this.fs.listCompletedTasks(),
				this.fs.loadConfig(),
			]);
			const identityIndex = await this.buildTaskIdentityIndex(
				activeTasks,
				completedTasks,
				[],
				config?.statuses ?? [...DEFAULT_STATUSES],
				config?.taskResolutionStrategy ?? "most_progressed",
			);
			return {
				tasks: identityIndex.getTasks(false),
				activeTasks,
				completedTasks,
				identityIndex,
				branchStateEntries: [],
				config,
			};
		}
		return await this.loadTaskCorpusSnapshot(progressCallback, { publishSharedState: options?.publish ?? true });
	}

	/**
	 * Build a task corpus snapshot from the working copy. Upstream this also indexed and
	 * hydrated tasks from other branches and remote refs behind a stable branch-tip snapshot;
	 * the git layer is not carried, so the only source is the local filesystem and the
	 * snapshot is stable by construction.
	 */
	private async buildTaskCorpusSnapshot(options: TaskCorpusLoadOptions, attempt = 0): Promise<TaskCorpusSnapshot> {
		const { abortSignal } = options;
		const generation = this.projectGeneration;
		const filesystem = this.fs;
		const projectRoot = filesystem.rootDir;
		const backlogRoot = filesystem.backlogDir;
		const projectChanged = () =>
			generation !== this.projectGeneration ||
			filesystem !== this.fs ||
			projectRoot !== this.fs.rootDir ||
			backlogRoot !== filesystem.backlogDir;
		const retryForCurrentProject = async () => {
			if (attempt >= 2) {
				throw new Error("Project root kept changing while tasks were loading");
			}
			return await this.buildTaskCorpusSnapshot(options, attempt + 1);
		};

		const config = await filesystem.loadConfig();
		if (projectChanged()) return await retryForCurrentProject();
		const settingsKeyBefore = this.getTaskCorpusSettingsKey(config, filesystem);
		const statuses = config?.statuses || [...DEFAULT_STATUSES];
		const resolutionStrategy = config?.taskResolutionStrategy || "most_progressed";
		const includeCompleted = options.includeCompleted ?? false;

		// Check for cancellation
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		const [localTasks, completedTasks] = await Promise.all([
			this.listTasksWithMetadata(filesystem),
			filesystem.listCompletedTasks(),
		]);
		if (projectChanged()) return await retryForCurrentProject();

		// Check for cancellation before identity resolution
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		const identityIndex = await this.buildTaskIdentityIndex(
			localTasks,
			completedTasks,
			[],
			statuses,
			resolutionStrategy,
			null,
			filesystem,
		);
		if (projectChanged()) return await retryForCurrentProject();
		const filteredTasks = identityIndex.getTasks(options.visibleCompleted ?? includeCompleted);

		// A config edit that lands while this load runs would publish a corpus built under the
		// old settings, and every later read would believe the store already holds the new ones.
		const settingsKeyAfter = this.getTaskCorpusSettingsKey(await filesystem.loadConfig(), filesystem);
		if (projectChanged()) return await retryForCurrentProject();
		if (settingsKeyBefore !== settingsKeyAfter) return await retryForCurrentProject();
		// Only the corpus this Core installs into its ContentStore may advance shared state.
		// A standalone load (statistics, ID allocation, a TUI board read) that published it
		// would make every later read believe the store already holds the current corpus.
		if (options.publishSharedState) {
			this.sharedTaskStateKey = settingsKeyAfter;
		}
		return {
			tasks: filteredTasks,
			activeTasks: localTasks,
			completedTasks,
			identityIndex,
			branchStateEntries: [],
			config,
		};
	}
}

/**
 * Builds a Core bound to the board root every interface resolves the same way: the directory
 * `CLAUDECODE_AGENTS_BOARD_ROOT` names, with no walk-up and no working-directory fallback. A root
 * that is not a directory throws rather than degrading to some nearby project.
 * Prefer passing an existing Core; use this only where no instance is available.
 */
export async function createRuntimeCore(options?: { enableWatchers?: boolean }): Promise<Core> {
	return new Core(resolveBoardRoot(), options);
}
