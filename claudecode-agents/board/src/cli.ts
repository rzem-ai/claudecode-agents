#!/usr/bin/env bun
import { Command } from "commander";
import { resolveBoardRoot } from "./board-root.ts";
import { generateKanbanBoardWithMetadata } from "./board.ts";
import { Core } from "./core/backlog.ts";
import { loadTaskDetail, loadTaskListItems } from "./core/task-detail.ts";
import { printJson, type SearchResultInput, searchJson, taskListJson, taskViewJson } from "./formatters/json-output.ts";
import { formatTaskPlainText } from "./formatters/task-plain-text.ts";
import { createMcpServer } from "./mcp/server.ts";
import { BacklogServer } from "./server/index.ts";
import type { SearchResult, SearchResultType, TaskCreateInput } from "./types/index.ts";
import type { TaskEditArgs } from "./types/task-edit-args.ts";
import { getCanonicalStatus, getValidStatuses } from "./utils/status.ts";
import { buildTaskUpdateInput } from "./utils/task-edit-builder.ts";

declare const __EMBEDDED_VERSION__: string | undefined;
const VERSION = typeof __EMBEDDED_VERSION__ === "string" ? __EMBEDDED_VERSION__ : "dev";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function list(value: string, previous: string[] = []): string[] {
	const parts = value.split(",").map((v) => v.trim());
	return previous.concat(parts.filter(Boolean));
}

function repeat(value: string, previous: string[] = []): string[] {
	return previous.concat([value]);
}

function core(): Core {
	try {
		return new Core(resolveBoardRoot());
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

async function statusOrFail(c: Core, wanted: string): Promise<string> {
	const statuses = await getValidStatuses(c);
	const hit = await getCanonicalStatus(wanted, c, statuses);
	if (!hit) fail(`invalid status "${wanted}". Configured statuses: ${statuses.join(", ")}`);
	return hit;
}

async function emitTask(c: Core, id: string, json: boolean) {
	const task = await c.getTask(id);
	if (!task) fail(`no task ${id}`);
	const detail = await loadTaskDetail(c, task);
	if (json) printJson(taskViewJson(detail, c.filesystem.rootDir));
	else console.log(formatTaskPlainText(detail));
}

/** Search results carry bare tasks; the JSON formatter wants rows that already know their readiness. */
async function withReadiness(c: Core, results: SearchResult[]): Promise<SearchResultInput[]> {
	const tasks = results.flatMap((result) => (result.type === "task" ? [result.task] : []));
	const rows = (tasks.length > 0 ? await loadTaskListItems(c, tasks) : [])[Symbol.iterator]();
	const projected: SearchResultInput[] = [];
	for (const result of results) {
		if (result.type !== "task") {
			projected.push(result);
			continue;
		}
		const row = rows.next();
		// One row per task result, in order, so this never runs out.
		if (row.done) break;
		projected.push({ ...result, task: row.value });
	}
	return projected;
}

const program = new Command().name("board").description("The fleet's board").version(VERSION);
const task = program.command("task").description("tasks on the board");

task
	.command("create <title>")
	.option("-d, --description <text>")
	.option("-s, --status <status>")
	.option("-a, --assignee <names>", "comma-separated or repeated", list)
	.option("-l, --labels <labels>", "comma-separated or repeated", list)
	.option("--priority <priority>")
	.option("--project <project>")
	.option("--milestone <milestone>")
	.option("-p, --parent <taskId>")
	.option("--dep <taskId>", "repeatable", repeat)
	.option("--ac <text>", "acceptance criterion, repeatable", repeat)
	.option("--plan <text>")
	.option("--notes <text>")
	.option("--json")
	.option("--plain")
	.action(async (title: string, o) => {
		const c = core();
		const input: TaskCreateInput = {
			title,
			description: o.description,
			status: o.status ? await statusOrFail(c, o.status) : undefined,
			assignee: o.assignee,
			labels: o.labels,
			priority: o.priority,
			project: o.project,
			milestone: o.milestone,
			parentTaskId: o.parent,
			dependencies: o.dep,
			acceptanceCriteria: o.ac?.map((text: string) => ({ text, checked: false })),
			implementationPlan: o.plan,
			implementationNotes: o.notes,
		};
		const { task: created } = await c.createTaskFromInput(input);
		if (o.json || o.plain) await emitTask(c, created.id, Boolean(o.json));
		else console.log(`Created ${created.id}`);
	});

task
	.command("edit <taskId>")
	.option("-t, --title <text>")
	.option("-d, --description <text>")
	.option("-s, --status <status>")
	.option("-a, --assignee <names>", "comma-separated or repeated", list)
	.option("-l, --labels <labels>", "replace labels", list)
	.option("--add-label <label>", "repeatable", repeat)
	.option("--remove-label <label>", "repeatable", repeat)
	.option("--priority <priority>")
	.option("--project <project>")
	.option("--milestone <milestone>")
	.option("--dep <taskId>", "repeatable", repeat)
	.option("--ref <text>", "add a reference, repeatable", repeat)
	.option("--ac <text>", "add acceptance criterion, repeatable", repeat)
	.option("--check-ac <n>", "repeatable", repeat)
	.option("--uncheck-ac <n>", "repeatable", repeat)
	.option("--remove-ac <n>", "repeatable", repeat)
	.option("--plan <text>", "replace the plan")
	.option("--append-plan <text>", "repeatable", repeat)
	.option("--notes <text>", "replace the notes")
	.option("--append-notes <text>", "repeatable", repeat)
	.option("--comment <text>", "repeatable", repeat)
	.option("--comment-author <name>")
	.option("--final-summary <text>")
	.option("--json")
	.option("--plain")
	.action(async (taskId: string, o) => {
		const c = core();
		const current = await c.getTask(taskId);
		if (!current) fail(`no task ${taskId}`);
		if (o.comment?.length && !o.commentAuthor) fail("--comment needs --comment-author");
		const args: TaskEditArgs = {
			title: o.title,
			description: o.description,
			status: o.status ? await statusOrFail(c, o.status) : undefined,
			assignee: o.assignee,
			labels: o.labels,
			addLabels: o.addLabel,
			removeLabels: o.removeLabel,
			priority: o.priority,
			project: o.project,
			milestone: o.milestone,
			dependencies: o.dep,
			addReferences: o.ref,
			acceptanceCriteriaAdd: o.ac,
			acceptanceCriteriaCheck: o.checkAc?.map(Number),
			acceptanceCriteriaUncheck: o.uncheckAc?.map(Number),
			acceptanceCriteriaRemove: o.removeAc?.map(Number),
			planSet: o.plan,
			planAppend: o.appendPlan,
			notesSet: o.notes,
			notesAppend: o.appendNotes,
			commentsAppend: o.comment,
			commentAuthor: o.commentAuthor,
			finalSummary: o.finalSummary,
		};
		await c.updateTaskFromInput(current.id, buildTaskUpdateInput(args));
		if (o.json || o.plain) await emitTask(c, current.id, Boolean(o.json));
		else console.log(`Updated ${current.id}`);
	});

task
	.command("view <taskId>")
	.option("--json")
	.option("--plain")
	.action(async (taskId: string, o) => {
		await emitTask(core(), taskId, Boolean(o.json));
	});

task
	.command("list")
	.option("--status <status>", "repeatable", repeat)
	.option("--project <project>")
	.option("--assignee <name>")
	.option("--labels <labels>", "comma-separated or repeated", list)
	.option("--search <text>")
	.option("--limit <n>")
	.option("--json")
	.option("--plain")
	.action(async (o) => {
		const c = core();
		const statuses = o.status ? await Promise.all(o.status.map((s: string) => statusOrFail(c, s))) : undefined;
		const tasks = await c.queryTasks({
			query: o.search,
			limit: o.limit ? Number(o.limit) : undefined,
			filters: { status: statuses, project: o.project, assignee: o.assignee, labels: o.labels },
		});
		const items = await loadTaskListItems(c, tasks);
		if (o.json) printJson(taskListJson(items));
		else for (const t of items) console.log(`${t.id}  ${t.status}  ${t.title}`);
	});

task
	.command("search <query>")
	.option("--type <type>", "task, document or decision; repeatable", repeat)
	.option("--limit <n>")
	.option("--json")
	.action(async (query: string, o) => {
		const c = core();
		const service = await c.getSearchService();
		const results = service.search({
			query,
			limit: o.limit ? Number(o.limit) : undefined,
			types: o.type as SearchResultType[] | undefined,
		});
		if (o.json) printJson(searchJson(await withReadiness(c, results), c.filesystem.rootDir, c.filesystem.docsDir));
		else for (const r of results) console.log(r.type === "task" ? `${r.task.id}  ${r.task.title}` : `${r.type}`);
	});

program
	.command("export")
	.description("the board as a markdown table on stdout")
	.action(async () => {
		const c = core();
		const config = await c.filesystem.loadConfig();
		const tasks = await c.queryTasks();
		console.log(generateKanbanBoardWithMetadata(tasks, await getValidStatuses(c), config?.projectName ?? "board"));
	});

program
	.command("mcp")
	.description("MCP server on stdio")
	.action(async () => {
		const server = await createMcpServer(resolveBoardRoot());
		await server.connect();
		await server.start();
	});

program
	.command("serve")
	.description("the web board on 127.0.0.1")
	.option("--port <n>", "default 6420")
	.action(async (o) => {
		const server = new BacklogServer(resolveBoardRoot());
		await server.start(o.port ? Number(o.port) : undefined, false);
	});

program.parseAsync(process.argv).catch((error) => fail(error instanceof Error ? error.message : String(error)));
