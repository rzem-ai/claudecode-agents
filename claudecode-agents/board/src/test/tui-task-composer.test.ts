import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import type { Task, TaskCreateInput } from "../types/index.ts";
import { getCreatedTaskBoardOutcome, renderBoardTui, upsertBoardTask } from "../ui/board.ts";
import { openSingleSelectFilterPopup } from "../ui/components/filter-popup.ts";
import type { CaretLines } from "../ui/components/task-composer.ts";
import {
	caretIndexFromCursor,
	createTaskComposerValues,
	cursorFromCaretIndex,
	deletionEnd,
	deletionStart,
	getTaskComposerLayout,
	getTaskComposerPriorityChoices,
	getTaskComposerProjectChoices,
	getTaskComposerStatusChoices,
	getTaskComposerTypeChoices,
	openTaskComposer,
	TaskComposerController,
	toTaskCreateInput,
} from "../ui/components/task-composer.ts";
import { createScreen } from "../ui/tui.ts";
import { watchTasks } from "../utils/task-watcher.ts";
import { initializeTestProject, withTimeout } from "./test-utils.ts";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "TASK-1",
		title: "Created task",
		status: "To Do",
		assignee: [],
		createdDate: "2026-07-15 00:00",
		labels: [],
		dependencies: [],
		...overrides,
	};
}

type TestWidget = {
	_clines?: { length: number; real?: string[]; rtof?: number[]; fake?: string[] };
	_reading?: boolean;
	childBase?: number;
	content?: string;
	type?: string;
	children?: unknown[];
	getCursor?: () => { x: number; y: number };
	setCursor?: (x: number, y: number) => void;
	getValue?: () => string;
	height?: number;
	hidden?: boolean;
	items?: TestWidget[];
	label?: string;
	left?: number | string;
	options?: { label?: string };
	position?: { top?: number | string; left?: number | string; width?: number | string; height?: number | string };
	selected?: number;
	style?: { inverse?: boolean; bold?: boolean; border?: { fg?: string } };
	top?: number;
	width?: number | string;
	emit?: (event: string, ...args: unknown[]) => void;
	setValue?: (value: string) => void;
	setContent?: (value: string) => void;
};

function collectWidgets(root: { children?: unknown[] }): TestWidget[] {
	const widgets: TestWidget[] = [];
	const visit = (node: TestWidget) => {
		widgets.push(node);
		for (const child of node.children ?? []) visit(child as TestWidget);
	};
	visit(root as TestWidget);
	return widgets;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${message}`);
}

function pressKey(widget: TestWidget | undefined, name: string, ch = ""): void {
	const shift = name.startsWith("S-");
	const keyName = shift ? name.slice(2) : name;
	const key = { name: keyName, full: name, shift };
	widget?.emit?.("keypress", ch, key);
	widget?.emit?.(`key ${name}`, ch, key);
}

function clickWidget(widget: TestWidget | undefined): void {
	widget?.emit?.("click", { button: "left", x: 0, y: 0 });
}

function typeText(widget: TestWidget | undefined, value: string): void {
	for (const character of value) {
		pressKey(widget, character, character);
	}
}

async function settleComposerFocus(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TUI task composer model", () => {
	it("places the caret from the widget's end-relative cursor", () => {
		const singleLine = { real: ["abcdef"], rtof: [0], fakeCount: 1 };
		expect(caretIndexFromCursor("abcdef", { x: 0, y: 0 }, singleLine)).toBe(6);
		expect(caretIndexFromCursor("abcdef", { x: -2, y: 0 }, singleLine)).toBe(4);

		// Two logical lines: the newline between them counts as a character.
		const twoLines = { real: ["alpha beta", "second line"], rtof: [0, 1], fakeCount: 2 };
		expect(caretIndexFromCursor("alpha beta\nsecond line", { x: -3, y: 0 }, twoLines)).toBe(19);
		expect(caretIndexFromCursor("alpha beta\nsecond line", { x: -2, y: -1 }, twoLines)).toBe(8);

		// One logical line wrapped across two rows: no newline to account for.
		const wrapped = { real: ["wwww xxxx ", "yyyy zzzz"], rtof: [0, 0], fakeCount: 1 };
		expect(caretIndexFromCursor("wwww xxxx yyyy zzzz", { x: -2, y: -1 }, wrapped)).toBe(8);
	});

	it("deletes one character or one word back from the caret", () => {
		expect(deletionStart("abcdef", 4, "char")).toBe(3);
		expect(deletionStart("abcdef", 0, "char")).toBe(0);
		expect(deletionStart("hello world", 11, "word")).toBe(6);
		expect(deletionStart("hello world  ", 13, "word")).toBe(6);
		expect(deletionStart("hello", 5, "word")).toBe(0);
		expect(deletionStart("", 0, "word")).toBe(0);
	});

	it("treats an astral character as one unit in both directions", () => {
		const value = "ab🚀cd";
		// Four visible characters, but six UTF-16 units: the emoji occupies indices 2 and 3.
		expect(value.length).toBe(6);
		// Backspace just after the emoji removes both of its UTF-16 units.
		expect(deletionStart(value, 4, "char")).toBe(2);
		expect(value.slice(0, deletionStart(value, 4, "char")) + value.slice(4)).toBe("abcd");
		// Delete just before it does the same going forward.
		expect(deletionEnd(value, 2)).toBe(4);
		expect(value.slice(0, 2) + value.slice(deletionEnd(value, 2))).toBe("abcd");
		// Ordinary characters either side still move by one.
		expect(deletionStart(value, 2, "char")).toBe(1);
		expect(deletionEnd(value, 4)).toBe(5);
		expect(deletionEnd(value, value.length)).toBe(value.length);
	});

	it("round-trips the caret between an index and the widget's cursor offsets", () => {
		const cases: Array<[string, CaretLines]> = [
			["abcdef", { real: ["abcdef"], rtof: [0], fakeCount: 1 }],
			["alpha beta\nsecond line", { real: ["alpha beta", "second line"], rtof: [0, 1], fakeCount: 2 }],
			["wwww xxxx yyyy zzzz", { real: ["wwww xxxx ", "yyyy zzzz"], rtof: [0, 0], fakeCount: 1 }],
		];
		for (const [value, lines] of cases) {
			for (let index = 0; index <= value.length; index += 1) {
				const cursor = cursorFromCaretIndex(value, index, lines);
				expect(caretIndexFromCursor(value, cursor, lines)).toBe(index);
			}
		}
	});

	it("maps a display-cell cursor onto code-point boundaries around a wide astral character", () => {
		const value = "A𠮷B";
		const lines: CaretLines = {
			// Blessed adds \x03 as an internal placeholder for the second terminal cell.
			real: ["A𠮷\x03B"],
			rtof: [0],
			fakeCount: 1,
			displayWidth: (text) => Array.from(text).reduce((width, character) => width + (character === "𠮷" ? 2 : 1), 0),
		};

		// The widget can leave its cursor on the second cell of a wide character. Resolve that
		// ambiguous cell to the boundary before the character, never between its surrogates.
		expect(caretIndexFromCursor(value, { x: -2, y: 0 }, lines)).toBe(1);
		expect(cursorFromCaretIndex(value, 1, lines)).toEqual({ x: -3, y: 0 });
		for (const index of [0, 1, 3, 4]) {
			expect(caretIndexFromCursor(value, cursorFromCaretIndex(value, index, lines), lines)).toBe(index);
		}
	});

	it("rests on the first configured workflow status and never Draft", () => {
		const values = createTaskComposerValues(["Review", "Ready", "Done"]);
		expect(values.status).toBe("Review");
		expect(values.type).toBe("");
		expect(values.priority).toBe("");
		expect(values.project).toBe("");
	});

	it("offers Draft only in the opened status choices without changing the resting value", () => {
		const values = createTaskComposerValues(["Backlog", "Doing", "Done"]);
		const choices = getTaskComposerStatusChoices(["Backlog", "Doing", "Done"]);

		expect(choices.map((choice) => choice.value)).toEqual(["Draft", "Backlog", "Doing", "Done"]);
		expect(values.status).toBe("Backlog");
	});

	it("uses configured type and priority choices with explicit unset options", () => {
		expect(getTaskComposerTypeChoices(["Incident", "Feature"])).toEqual([
			{ label: "None", value: "" },
			{ label: "Incident", value: "Incident" },
			{ label: "Feature", value: "Feature" },
		]);
		expect(getTaskComposerPriorityChoices(["Urgent", "Eventually"])).toEqual([
			{ label: "None", value: "" },
			{ label: "Urgent", value: "urgent" },
			{ label: "Eventually", value: "eventually" },
		]);
		expect(getTaskComposerProjectChoices(["Web", "API"])).toEqual([
			{ label: "None", value: "" },
			{ label: "Web", value: "Web" },
			{ label: "API", value: "API" },
		]);
		expect(getTaskComposerProjectChoices()).toEqual([{ label: "None", value: "" }]);
	});

	it("builds the canonical first-slice payload and omits unset fields", () => {
		expect(
			toTaskCreateInput({
				title: "  Capture intent  ",
				description: "Line one\nLine two",
				status: "Review",
				type: "Feature",
				priority: "urgent",
				project: "",
				dueDate: "2026-08-10",
			}),
		).toEqual({
			title: "Capture intent",
			description: "Line one\nLine two",
			status: "Review",
			type: "Feature",
			priority: "urgent",
			dueDate: "2026-08-10",
		});

		expect(
			toTaskCreateInput({
				title: "Minimal",
				description: "",
				status: "To Do",
				type: "",
				priority: "",
				project: "",
				dueDate: "",
			}),
		).toEqual({
			title: "Minimal",
			status: "To Do",
		});

		expect(
			toTaskCreateInput({
				title: "Projected task",
				description: "",
				status: "To Do",
				type: "",
				priority: "",
				project: "Web",
				dueDate: "",
			}),
		).toEqual({
			title: "Projected task",
			status: "To Do",
			project: "Web",
		});
	});

	it("adds one row to the details frame only when projects are configured", () => {
		const withoutProjects = getTaskComposerLayout(100, 30, { types: ["Feature"], priorities: ["High"] });
		const withProjects = getTaskComposerLayout(100, 30, {
			types: ["Feature"],
			priorities: ["High"],
			projects: ["Web", "API"],
		});

		expect(withProjects.detailsHeight).toBe(withoutProjects.detailsHeight + 1);
		expect(withProjects.actionsTop).toBe(withoutProjects.actionsTop + 1);
	});

	it("rejects a due date that names no calendar day before persistence", async () => {
		const controller = new TaskComposerController(["To Do", "Done"]);
		controller.values.title = "Invalid due date";
		controller.values.dueDate = "10/08/2026";
		let calls = 0;

		expect(
			await controller.create(async () => {
				calls += 1;
				return task();
			}),
		).toBeNull();
		expect(calls).toBe(0);
		expect(controller.error).toContain("YYYY-MM-DD");
	});

	it("fits shipped selector content at 100x30 and 80x24, then stacks details at 50x18", () => {
		expect(getTaskComposerLayout(100, 30)).toMatchObject({
			compact: true,
			popupWidth: 74,
			popupHeight: 20,
			descriptionHeight: 3,
			detailsTop: 9,
			detailsHeight: 4,
			actionsTop: 13,
		});
		expect(getTaskComposerLayout(80, 24)).toMatchObject({
			compact: true,
			popupWidth: 74,
			popupHeight: 20,
			actionsTop: 13,
		});
		expect(getTaskComposerLayout(50, 18)).toMatchObject({
			compact: true,
			stackSelectors: true,
			popupHeight: 16,
			descriptionHeight: 3,
			detailsTop: 9,
			detailsHeight: 5,
			actionsTop: 14,
		});
	});

	it("derives compact selector layout from configured content instead of a screen breakpoint", () => {
		const statuses = ["To Do", "Waiting for external approval", "Done"];
		expect(getTaskComposerLayout(100, 30, { statuses }).compact).toBe(true);
		expect(getTaskComposerLayout(140, 30, { statuses }).compact).toBe(true);

		const types = ["A very long configured type value that exceeds a compact column"];
		expect(getTaskComposerLayout(100, 30, { types })).toMatchObject({
			compact: true,
			stackSelectors: true,
			detailsTop: 9,
			detailsHeight: 5,
			actionsTop: 14,
		});
	});

	it("keeps the composer inside short terminals so no row is pushed off-screen", () => {
		for (const screenHeight of [6, 8, 10, 12, 14, 16, 20, 24, 40]) {
			const { popupHeight } = getTaskComposerLayout(80, screenHeight);
			expect(popupHeight).toBeLessThanOrEqual(screenHeight);
		}
		expect(getTaskComposerLayout(80, 10).popupHeight).toBe(8);
		for (const screenHeight of [8, 9, 10]) {
			expect(getTaskComposerLayout(80, screenHeight).popupHeight).toBeGreaterThanOrEqual(8);
		}
	});

	it("does not persist invalid input and preserves values after a failed attempt", async () => {
		const controller = new TaskComposerController(["Review", "Done"]);
		let calls = 0;
		const persist = async (_input: TaskCreateInput) => {
			calls += 1;
			throw new Error("Disk is read-only");
		};

		expect(await controller.create(persist)).toBeNull();
		expect(calls).toBe(0);
		expect(controller.error).toBe("Title is required.");

		controller.values.title = "Retry me";
		controller.values.description = "Keep this description";
		expect(await controller.create(persist)).toBeNull();
		expect(calls).toBe(1);
		expect(controller.error).toBe("Disk is read-only");
		expect(controller.values).toEqual({
			title: "Retry me",
			description: "Keep this description",
			status: "Review",
			type: "",
			priority: "",
			project: "",
			dueDate: "",
		});
	});
});

describe("TUI task composer canonical persistence", () => {
	let testDir: string;
	let core: Core;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "backlog-tui-composer-"));
		core = new Core(testDir);
		await initializeTestProject(core, "TUI Composer Test");
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("routes normal and explicitly selected Draft values through canonical creation", async () => {
		const normal = new TaskComposerController(["To Do", "Done"]);
		normal.values.title = "Normal task";
		const createdTask = await normal.create(async (input) => (await core.createTaskFromInput(input, false)).task);

		const draft = new TaskComposerController(["To Do", "Done"]);
		draft.values.title = "Draft task";
		draft.values.status = "Draft";
		const createdDraft = await draft.create(async (input) => (await core.createTaskFromInput(input, false)).task);

		expect(createdTask?.id).toBe("TASK-1");
		expect(await core.fs.loadTask("TASK-1")).not.toBeNull();
		expect(createdDraft?.id).toBe("DRAFT-1");
		expect(await core.fs.loadDraft("DRAFT-1")).not.toBeNull();
		expect(await core.fs.loadTask("DRAFT-1")).toBeNull();
	});

	it("persists mid-field astral insertions from both text fields without corrupting their caret", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		Object.defineProperty(screen, "fullUnicode", { configurable: true, value: true, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		let taskPath = "";

		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async (input) => {
					const result = await core.createTaskFromInput(input, false);
					if (!result.filePath) throw new Error("Expected canonical task creation to return its path");
					taskPath = result.filePath;
					return result.task;
				},
			});
			await settleComposerFocus();

			const title = eventScreen.focused;
			title?.setValue?.("A𠮷B");
			pressKey(title, "end");
			pressKey(title, "left");
			pressKey(title, "left");
			typeText(title, "X");
			expect(title?.getValue?.()).toBe("AX𠮷B");
			expect(title?.getCursor?.()).toEqual({ x: -3, y: 0 });

			pressKey(title, "tab", "\t");
			await settleComposerFocus();
			const description = eventScreen.focused;
			description?.setValue?.("left 𠮷 right");
			pressKey(description, "end");
			for (let step = 0; step < 7; step += 1) pressKey(description, "left");
			typeText(description, "Y");
			expect(description?.getValue?.()).toBe("left Y𠮷 right");
			expect(description?.getCursor?.()).toEqual({ x: -8, y: 0 });

			for (let step = 0; step < 5; step += 1) pressKey(eventScreen.focused, "tab", "\t");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "enter", "\r");
			expect((await withTimeout(resultPromise, "Unicode-safe composer persistence", 1000))?.id).toBe("TASK-1");

			const persisted = await readFile(taskPath, "utf8");
			// YAML escapes astral title characters, while Markdown keeps them literal. Both forms
			// must represent the complete code point rather than separate surrogate halves.
			expect(persisted).toContain("AX\\U00020BB7B");
			expect(persisted).toContain("left Y𠮷 right");
			expect(persisted).not.toContain("�");
			expect(persisted).not.toContain("\\uD842");
			expect(await core.fs.loadTask("TASK-1")).toMatchObject({
				title: "AX𠮷B",
				description: "left Y𠮷 right",
			});
		} finally {
			screen.destroy();
		}
	});

	it("does not inspect Git index ownership when auto-commit is disabled", async () => {
		let calls = 0;
		const originalGetIndexEntries = core.gitOps.getIndexEntries.bind(core.gitOps);
		core.gitOps.getIndexEntries = async () => {
			calls += 1;
			throw new Error("index inspection must not run");
		};

		try {
			const result = await core.createTaskFromInput({ title: "Filesystem-only create" }, false);
			expect(result.task.id).toBe("TASK-1");
			expect(calls).toBe(0);
			expect(await core.fs.loadTask("TASK-1")).not.toBeNull();
		} finally {
			core.gitOps.getIndexEntries = originalGetIndexEntries;
		}
	});

	it("keeps watcher delivery idempotent with the board optimistic upsert", async () => {
		let resolveAdded!: (created: Task) => void;
		const added = new Promise<Task>((resolve) => {
			resolveAdded = resolve;
		});
		const watcher = watchTasks(core, { onTaskAdded: resolveAdded }, []);
		try {
			const controller = new TaskComposerController(["To Do", "Done"]);
			controller.values.title = "Watched task";
			const created = await controller.create(async (input) => (await core.createTaskFromInput(input, false)).task);
			expect(created).not.toBeNull();

			const optimistic = upsertBoardTask([], created as Task);
			const watched = await withTimeout(added, "TUI composer watcher delivery", 3000);
			const reconciled = upsertBoardTask(optimistic, watched);
			expect(reconciled.map((candidate) => candidate.id)).toEqual(["TASK-1"]);
		} finally {
			watcher.stop();
		}
	});
});

describe("TUI task composer selector navigation", () => {
	const PROJECTS = ["Web"];

	/**
	 * Tab from the initial focus until the selector whose label starts with `prefix` is focused,
	 * then press Down and report the content of whatever ends up focused. Tab traversal and the
	 * arrow keys both act on the composer's own active field, so driving Tab first is what makes
	 * the arrow assertion meaningful.
	 */
	async function focusSelectorThenPressDown(
		width: number,
		height: number,
		prefix: string,
	): Promise<string | undefined> {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: width, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: height, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				projects: PROJECTS,
				persist: async () => task(),
			});
			await settleComposerFocus();

			let steps = 0;
			while (!eventScreen.focused?.content?.startsWith(prefix)) {
				if (steps > 20) throw new Error(`never focused a widget starting with "${prefix}"`);
				pressKey(eventScreen.focused, "tab", "\t");
				await settleComposerFocus();
				steps += 1;
			}

			pressKey(eventScreen.focused, "down");
			await settleComposerFocus();
			const landed = eventScreen.focused?.content;

			pressKey(eventScreen.focused, "escape", "\x1b");
			await withTimeout(resultPromise, "composer navigation cancellation", 1000);
			return landed;
		} finally {
			screen.destroy();
		}
	}

	// Unstacked compact keeps Type and Priority on one row, so Down from Type drops past both
	// to the full-width Project row below them.
	it("moves Down from Type to Project when Type and Priority share a row", async () => {
		const layout = getTaskComposerLayout(100, 30, { projects: PROJECTS });
		expect(layout.compact).toBe(true);
		expect(layout.stackSelectors).toBe(false);

		expect(await focusSelectorThenPressDown(100, 30, "Type:")).toStartWith("Project:");
	});

	// Stacked compact puts Type on its own row above Priority, so Down from Type must still
	// reach Priority. An unconditional project override used to skip Priority entirely, leaving
	// it unreachable by arrow keys on a narrow terminal.
	it("moves Down from Type to Priority in the stacked compact layout", async () => {
		const layout = getTaskComposerLayout(46, 18, { projects: PROJECTS });
		expect(layout.compact).toBe(true);
		expect(layout.stackSelectors).toBe(true);

		expect(await focusSelectorThenPressDown(46, 18, "Type:")).toStartWith("Priority:");
	});
});

describe("TUI task composer interaction", () => {
	it("opens the actual composer and Cancel performs no write", async () => {
		const screen = createScreen({ smartCSR: false });
		let writes = 0;
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => {
					writes += 1;
					return task();
				},
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			const descendants: Array<{ content?: string; children?: unknown[]; emit?: (event: string) => void }> = [];
			const visit = (node: { children?: unknown[] }) => {
				descendants.push(node);
				for (const child of node.children ?? []) visit(child as { children?: unknown[] });
			};
			visit(screen as unknown as { children?: unknown[] });
			const cancel = descendants.find((node) => node.content === "Cancel");
			expect(cancel).toBeDefined();
			cancel?.emit?.("key enter");

			expect(await withTimeout(resultPromise, "composer cancel", 1000)).toBeNull();
			expect(writes).toBe(0);
		} finally {
			screen.destroy();
		}
	});

	it("clicks text fields into exclusive read mode and handles repeated Title clicks", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const eventScreen = screen as unknown as {
			focused?: TestWidget;
			program?: { cursorHidden?: boolean };
		};
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			const widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			const title = widgets.find((widget) => widget.options?.label === " Title ");
			const description = widgets.find((widget) => widget.options?.label === " Description ");
			const dueDate = widgets.find((widget) => widget.options?.label === " Due ");
			const status = widgets.find((widget) => widget.content === "Status: To Do ▼");

			clickWidget(description);
			await settleComposerFocus();
			expect(eventScreen.focused).toBe(description);
			expect(description?._reading).toBe(true);
			expect(description?.getCursor?.()).toBeDefined();
			expect(eventScreen.program?.cursorHidden).toBe(false);
			expect(description?.style?.border?.fg).toBe("yellow");
			expect(title?.style?.border?.fg).toBe("gray");
			typeText(eventScreen.focused, "Clicked description");
			expect(description?.getValue?.()).toBe("Clicked description");

			pressKey(eventScreen.focused, "tab", "\t");
			expect(eventScreen.focused).toBe(dueDate);
			expect(dueDate?.style?.border?.fg).toBe("yellow");
			pressKey(eventScreen.focused, "tab", "\t");
			expect(eventScreen.focused).toBe(status);
			expect(status?.style).toMatchObject({ inverse: true, bold: true });

			clickWidget(title);
			await settleComposerFocus();
			expect(eventScreen.focused).toBe(title);
			expect(title?._reading).toBe(true);
			expect(title?.style?.border?.fg).toBe("yellow");
			expect(description?.style?.border?.fg).toBe("gray");
			expect(status?.style).toMatchObject({ inverse: false, bold: false });
			typeText(eventScreen.focused, "First");

			// Clicking the already active Title takes the same cancel/readInput path and remains editable.
			clickWidget(title);
			await settleComposerFocus();
			expect(eventScreen.focused).toBe(title);
			expect(title?._reading).toBe(true);
			typeText(eventScreen.focused, " again");
			expect(title?.getValue?.()).toBe("First again");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "mouse text-field cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("opens every selector picker from a click and restores exclusive selector focus", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				types: ["Bug", "Feature"],
				priorities: ["High", "Low"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			const widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			const selectors = [
				{
					widget: widgets.find((candidate) => candidate.content === "Status: To Do ▼"),
					choices: ["Draft", "To Do", "Done"],
				},
				{
					widget: widgets.find((candidate) => candidate.content === "Type: None ▼"),
					choices: ["None", "Bug", "Feature"],
				},
				{
					widget: widgets.find((candidate) => candidate.content === "Priority: None ▼"),
					choices: ["None", "High", "Low"],
				},
			];

			for (const { widget, choices } of selectors) {
				clickWidget(widget);
				await settleComposerFocus();
				expect(eventScreen.focused?.items?.map((item) => item.content)).toEqual(choices);
				pressKey(eventScreen.focused, "enter", "\r");
				await settleComposerFocus();
				expect(eventScreen.focused).toBe(widget);
				expect(widget?.style).toMatchObject({ inverse: true, bold: true });
			}

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "mouse selector cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("deletes back from the caret in both text fields and repaints", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		// Real terminals report unicode support, which is exactly when the textarea's own
		// backspace does nothing and the textbox deletes from the end without repainting.
		Object.defineProperty(screen, "fullUnicode", { configurable: true, value: true, writable: true });
		const originalRender = screen.render.bind(screen);
		let renders = 0;
		screen.render = () => {
			renders += 1;
			originalRender();
		};
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();

			const title = eventScreen.focused;
			typeText(title, "abcdef");
			expect(title?.getValue?.()).toBe("abcdef");
			renders = 0;
			pressKey(title, "backspace", "\x7f");
			expect(title?.getValue?.()).toBe("abcde");
			// The library deletes without rendering, so the field looks frozen until the next key.
			expect(renders).toBeGreaterThan(0);

			// Mid-field: the library always removes the last character instead of the caret's.
			pressKey(title, "left");
			pressKey(title, "left");
			pressKey(title, "backspace", "\x7f");
			expect(title?.getValue?.()).toBe("abde");

			// Ctrl+W removes the word before the caret, not the trailing one.
			pressKey(title, "C-w", "\x17");
			expect(title?.getValue?.()).toBe("de");

			pressKey(title, "tab", "\t");
			// The widget only starts listening for keys on the next tick.
			await settleComposerFocus();
			const description = eventScreen.focused;
			expect(description).not.toBe(title);
			typeText(description, "hello world");
			pressKey(description, "backspace", "\x7f");
			expect(description?.getValue?.()).toBe("hello worl");
			pressKey(description, "left");
			pressKey(description, "left");
			pressKey(description, "backspace", "\x7f");
			expect(description?.getValue?.()).toBe("hello wrl");
			pressKey(description, "C-w", "\x17");
			expect(description?.getValue?.()).toBe("hello rl");

			// An astral character is removed whole, never leaving half a surrogate pair behind.
			// setValue does not move the caret, so anchor it at the end before stepping back.
			const putCaret = (stepsBack: number) => {
				description?.emit?.("keypress", "", { name: "end", full: "end" });
				for (let step = 0; step < stepsBack; step += 1) {
					description?.emit?.("keypress", "", { name: "left", full: "left" });
				}
			};
			description?.setValue?.("ab🚀cd");
			putCaret(2); // just after the emoji
			pressKey(description, "backspace", "\x7f");
			expect(description?.getValue?.()).toBe("abcd");
			description?.setValue?.("ab🚀cd");
			putCaret(3); // just before the emoji (terminal columns, not UTF-16 units)
			pressKey(description, "delete", "");
			expect(description?.getValue?.()).toBe("abcd");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "composer deletion cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("opens a single-select picker on the current value so Enter keeps it", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		try {
			// "Draft" is the first choice, so an unselected list would silently confirm it.
			const choices = getTaskComposerStatusChoices(["To Do", "In Progress", "Done"]);
			expect(choices[0]?.value).toBe("Draft");
			const pickerPromise = openSingleSelectFilterPopup({
				screen,
				title: "Task Status",
				choices,
				selectedValue: "In Progress",
			});
			await settleComposerFocus();
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "enter", "\r");
			expect(await withTimeout(pickerPromise, "picker preselection", 1000)).toBe("In Progress");
		} finally {
			screen.destroy();
		}
	});

	it("joins description lines without crashing on the widget's stale cursor", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		Object.defineProperty(screen, "fullUnicode", { configurable: true, value: true, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			pressKey(eventScreen.focused, "tab", "\t");
			await settleComposerFocus();
			const description = eventScreen.focused;
			description?.setValue?.("line one\nline two");

			// Caret at the end of the first line: Delete removes the newline, so the widget has one
			// fewer line than its negative row offset still points at.
			description?.emit?.("keypress", "", { name: "up", full: "up" });
			description?.emit?.("keypress", "", { name: "end", full: "end" });
			pressKey(description, "delete", "");
			expect(description?.getValue?.()).toBe("line oneline two");

			// The same join from the other side: Backspace at the start of the second line.
			description?.setValue?.("first\nsecond");
			description?.emit?.("keypress", "", { name: "up", full: "up" });
			description?.emit?.("keypress", "", { name: "home", full: "home" });
			description?.emit?.("keypress", "", { name: "down", full: "down" });
			pressKey(description, "backspace", "\x7f");
			expect(description?.getValue?.()).toBe("firstsecond");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "description line join", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("keeps an edited early description line in the viewport", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 40, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		Object.defineProperty(screen, "fullUnicode", { configurable: true, value: true, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			pressKey(eventScreen.focused, "tab", "\t");
			await settleComposerFocus();
			const description = eventScreen.focused;
			const longDescription = "one ".repeat(80).trim();
			description?.setValue?.(longDescription);
			description?.setCursor?.(0, -Math.max(0, (description?._clines?.length ?? 1) - 1));
			const valueBeforeEdit = description?.getValue?.() ?? "";
			const cursorBeforeEdit = description?.getCursor?.() ?? { x: 0, y: 0 };
			const clines = description?._clines;
			const caretBeforeEdit = caretIndexFromCursor(valueBeforeEdit, cursorBeforeEdit, {
				real: clines?.real ?? [valueBeforeEdit],
				rtof: clines?.rtof ?? [0],
				fakeCount: clines?.fake?.length ?? 1,
			});
			expect(caretBeforeEdit).toBeLessThan(valueBeforeEdit.length / 2);
			typeText(description, "X");

			expect(description?.getValue?.()).toBe(
				`${valueBeforeEdit.slice(0, caretBeforeEdit)}X${valueBeforeEdit.slice(caretBeforeEdit)}`,
			);
			// The caret is on an early wrapped line, so setValue must not leave the textarea parked
			// on its final line. The exact offset can vary with the terminal's wrapping geometry.
			expect(description?.childBase).toBeLessThan((description?._clines?.length ?? 1) - 1);

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "description viewport cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("uses spatial arrows across every control and Tab traverses them in order", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const originalRender = screen.render.bind(screen);
		let renders = 0;
		screen.render = () => {
			renders += 1;
			originalRender();
		};
		const eventScreen = screen as unknown as { focused?: TestWidget; emit(event: string): void };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();

			expect(eventScreen.focused?.options?.label).toBe(" Title ");
			// Tab walks the whole order forward and wraps back to the title.
			for (const expected of [
				" Description ",
				" Due ",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				" Title ",
			]) {
				pressKey(eventScreen.focused, "tab", "\t");
				if (expected) expect(eventScreen.focused?.options?.label).toBe(expected);
			}
			// Tab must not type a tab character into either text field.
			expect(eventScreen.focused?.getValue?.()).toBe("");
			// Shift+Tab wraps backwards to the last control and walks back to the title.
			pressKey(eventScreen.focused, "S-tab", "\t");
			expect(eventScreen.focused?.content).toBe("Cancel");
			for (const expected of ["Create task", "Priority: None ▼", "Type: None ▼", "Status: To Do ▼"]) {
				pressKey(eventScreen.focused, "S-tab", "\t");
				expect(eventScreen.focused?.content).toBe(expected);
			}
			pressKey(eventScreen.focused, "S-tab", "\t");
			expect(eventScreen.focused?.options?.label).toBe(" Due ");
			pressKey(eventScreen.focused, "S-tab", "\t");
			expect(eventScreen.focused?.options?.label).toBe(" Description ");
			pressKey(eventScreen.focused, "S-tab", "\t");
			expect(eventScreen.focused?.options?.label).toBe(" Title ");
			expect(eventScreen.focused?.getValue?.()).toBe("");

			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.options?.label).toBe(" Description ");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.options?.label).toBe(" Due ");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Status: To Do ▼");
			expect(eventScreen.focused?.style).toMatchObject({ inverse: true, bold: true });
			pressKey(eventScreen.focused, "right");
			expect(eventScreen.focused?.content).toBe("Status: To Do ▼");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Type: None ▼");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "right");
			expect(eventScreen.focused?.content).toBe("Cancel");
			pressKey(eventScreen.focused, "left");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "tab", "\t");
			expect(eventScreen.focused?.content).toBe("Cancel");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "Esc from composer action", 1000)).toBeNull();
			renders = 0;
			eventScreen.emit("resize");
			expect(renders).toBe(0);
		} finally {
			screen.destroy();
		}
	});

	it("adapts the spatial focus graph to the narrow stacked selector layout", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 50, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 18, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Status: To Do ▼");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Type: None ▼");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Priority: None ▼");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "up");
			expect(eventScreen.focused?.content).toBe("Priority: None ▼");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "right");
			expect(eventScreen.focused?.content).toBe("Cancel");
			pressKey(eventScreen.focused, "left");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "narrow composer cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("preserves title caret editing and multiline description arrows", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();

			typeText(eventScreen.focused, "abc");
			pressKey(eventScreen.focused, "left");
			typeText(eventScreen.focused, "X");
			expect(eventScreen.focused?.getValue?.()).toBe("abXc");
			expect(eventScreen.focused?.options?.label).toBe(" Title ");

			pressKey(eventScreen.focused, "down");
			await settleComposerFocus();
			typeText(eventScreen.focused, "first");
			pressKey(eventScreen.focused, "enter", "\r");
			typeText(eventScreen.focused, "second");
			pressKey(eventScreen.focused, "up");
			expect(eventScreen.focused?.options?.label).toBe(" Description ");
			expect(eventScreen.focused?.getCursor?.().y).toBe(-1);
			pressKey(eventScreen.focused, "up");
			expect(eventScreen.focused?.options?.label).toBe(" Title ");

			pressKey(eventScreen.focused, "down");
			await settleComposerFocus();
			expect(eventScreen.focused?.getCursor?.().y).toBe(-1);
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.options?.label).toBe(" Description ");
			expect(eventScreen.focused?.getCursor?.().y).toBe(0);
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.options?.label).toBe(" Due ");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Status: To Do ▼");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "composer text navigation cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("opens selectors with Enter and restores focus after selection", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				types: ["Bug", "Feature"],
				priorities: ["High", "Low"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Status: To Do ▼");

			pressKey(eventScreen.focused, "enter", "\r");
			await settleComposerFocus();
			expect(eventScreen.focused?.items?.map((item) => item.content)).toEqual(["Draft", "To Do", "Done"]);
			pressKey(eventScreen.focused, "up");
			pressKey(eventScreen.focused, "enter", "\r");
			await settleComposerFocus();
			expect(eventScreen.focused?.content).toBe("Status: Draft ▼");
			expect(eventScreen.focused?.style).toMatchObject({ inverse: true, bold: true });

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "composer selector cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("keeps invalid values for correction and creates explicitly", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const eventScreen = screen as unknown as { focused?: TestWidget };
		const persisted: TaskCreateInput[] = [];
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async (input) => {
					persisted.push(input);
					return task({ title: input.title });
				},
			});
			await settleComposerFocus();
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "enter", "\r");
			await waitUntil(() => eventScreen.focused?.options?.label === " Title ", "invalid title focus");
			expect(persisted).toHaveLength(0);
			expect(
				collectWidgets(screen as unknown as { children?: unknown[] }).some((widget) =>
					widget.content?.includes("Title is required."),
				),
			).toBe(true);

			eventScreen.focused?.setValue?.("Corrected task");
			pressKey(eventScreen.focused, "down");
			await settleComposerFocus();
			eventScreen.focused?.setValue?.("Kept description");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "down");
			pressKey(eventScreen.focused, "enter", "\r");

			const created = await withTimeout(resultPromise, "explicit task creation", 1000);
			expect(created?.title).toBe("Corrected task");
			expect(persisted).toEqual([
				{
					title: "Corrected task",
					description: "Kept description",
					status: "To Do",
				},
			]);
		} finally {
			screen.destroy();
		}
	});

	it("keeps an editable row and visible cursor for both text fields at 8-10 terminal rows", async () => {
		for (const screenHeight of [8, 9, 10]) {
			const screen = createScreen({ smartCSR: false });
			Object.defineProperty(screen, "width", { configurable: true, value: 80, writable: true });
			Object.defineProperty(screen, "height", { configurable: true, value: screenHeight, writable: true });
			const eventScreen = screen as unknown as {
				focused?: TestWidget;
				program?: { cursorHidden?: boolean };
			};
			try {
				const resultPromise = openTaskComposer({
					screen,
					statuses: ["To Do", "In Progress", "Done"],
					persist: async () => task(),
				});
				await settleComposerFocus();
				const widgets = collectWidgets(screen as unknown as { children?: unknown[] });
				const form = widgets.find((widget) => widget.type === "scrollable-box");
				const title = widgets.find((widget) => widget.options?.label === " Title ");
				const description = widgets.find((widget) => widget.options?.label === " Description ");
				expect(form?.height).toBeGreaterThanOrEqual(3);

				const expectEditableRowVisible = (input: TestWidget | undefined) => {
					const fieldTop = Number(input?.position?.top ?? 0);
					const firstEditableRow = fieldTop + 1;
					const viewportTop = form?.childBase ?? 0;
					const viewportBottom = viewportTop + (form?.height ?? 0);
					expect(firstEditableRow).toBeGreaterThanOrEqual(viewportTop);
					expect(firstEditableRow).toBeLessThan(viewportBottom);
					expect(input?._reading).toBe(true);
					expect(input?.getCursor?.()).toBeDefined();
					expect(eventScreen.program?.cursorHidden).toBe(false);
				};

				expect(eventScreen.focused).toBe(title);
				expectEditableRowVisible(title);
				pressKey(eventScreen.focused, "tab", "\t");
				expect(eventScreen.focused).toBe(description);
				expectEditableRowVisible(description);

				pressKey(eventScreen.focused, "escape", "\x1b");
				expect(await withTimeout(resultPromise, `short ${screenHeight}-row composer cancellation`, 1000)).toBeNull();
			} finally {
				screen.destroy();
			}
		}
	});

	it("renders the longest shipped status and selector cue without clipping at 80 and 100 columns", async () => {
		for (const screenWidth of [80, 100]) {
			const screen = createScreen({ smartCSR: false });
			Object.defineProperty(screen, "width", { configurable: true, value: screenWidth, writable: true });
			Object.defineProperty(screen, "height", { configurable: true, value: 24, writable: true });
			try {
				const resultPromise = openTaskComposer({
					screen,
					statuses: ["In Progress", "To Do", "Done"],
					persist: async () => task(),
				});
				await settleComposerFocus();
				const status = collectWidgets(screen as unknown as { children?: unknown[] }).find(
					(widget) => widget.content === "Status: In Progress ▼",
				);
				expect(status).toBeDefined();
				expect(status?.content?.endsWith(" ▼")).toBe(true);
				expect(status?.width).toBeGreaterThanOrEqual(Bun.stringWidth(status?.content ?? ""));

				pressKey((screen as unknown as { focused?: TestWidget }).focused, "escape", "\x1b");
				expect(await withTimeout(resultPromise, `${screenWidth}-column composer cancellation`, 1000)).toBeNull();
			} finally {
				screen.destroy();
			}
		}
	});

	it("stacks selector rows when configured content cannot fit a normal column", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		try {
			const typeValue = "A very long configured type value that exceeds a compact column";
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				types: [typeValue],
				persist: async () => task(),
			});
			await settleComposerFocus();
			const widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			const status = widgets.find((widget) => widget.content === "Status: To Do ▼");
			const type = widgets.find((widget) => widget.content === "Type: None ▼");
			const priority = widgets.find((widget) => widget.content === "Priority: None ▼");
			expect(status?.position?.top).toBe(10);
			expect(type?.position?.top).toBe(11);
			expect(priority?.position?.top).toBe(12);
			type?.setContent?.(`Type: ${typeValue} ▼`);
			expect(type?.width).toBeGreaterThanOrEqual(Bun.stringWidth(type?.content ?? ""));
			expect(priority?.width).toBeGreaterThanOrEqual(Bun.stringWidth(priority?.content ?? ""));
			expect(status?.width).toBeGreaterThanOrEqual(Bun.stringWidth(status?.content ?? ""));

			const eventScreen = screen as unknown as { focused?: TestWidget };
			for (let step = 0; step < 6; step += 1) pressKey(eventScreen.focused, "down");
			expect(eventScreen.focused?.content).toBe("Create task");
			pressKey(eventScreen.focused, "up");
			expect(eventScreen.focused?.content).toBe("Priority: None ▼");

			pressKey(eventScreen.focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "content-constrained composer cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("reflows an open composer between full and compact terminal sizes", async () => {
		const screen = createScreen({ smartCSR: false });
		const mutableScreen = screen as unknown as { width: number; height: number; emit(event: string): void };
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			let widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			let description = widgets.find((widget) => widget.options?.label === " Description ");
			let details = widgets.find((widget) => widget.options?.label === " Details ");
			let actions = widgets.find((widget) => widget.content === "Actions");
			let status = widgets.find((widget) => widget.content === "Status: To Do ▼");
			let type = widgets.find((widget) => widget.content === "Type: None ▼");
			expect(description?.position).toMatchObject({ top: 3, height: 3 });
			expect(details?.position).toMatchObject({ top: 9, height: 4 });
			expect(actions?.position).toMatchObject({ top: 13, height: 1 });
			expect(actions?.hidden).toBe(true);
			// Selectors sit inside the details frame but are positioned in viewport coordinates.
			expect(status?.position).toMatchObject({ top: 10, left: 3 });
			expect(type?.position).toMatchObject({ top: 11, left: 3 });
			expect(widgets.some((widget) => widget.content?.includes("[↑↓←→/Tab]"))).toBe(true);

			mutableScreen.width = 50;
			mutableScreen.height = 18;
			mutableScreen.emit("resize");
			widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			description = widgets.find((widget) => widget.options?.label === " Description ");
			details = widgets.find((widget) => widget.options?.label === " Details ");
			actions = widgets.find((widget) => widget.content === "Actions");
			status = widgets.find((widget) => widget.content === "Status: To Do ▼");
			type = widgets.find((widget) => widget.content === "Type: None ▼");
			expect(description?.position).toMatchObject({ top: 3, height: 3 });
			expect(details?.position).toMatchObject({ top: 9, height: 5 });
			expect(actions?.position).toMatchObject({ top: 14, height: 1 });
			expect(actions?.hidden).toBe(true);
			expect(status?.position).toMatchObject({ top: 10, left: 3 });
			expect(type?.position).toMatchObject({ top: 11, left: 3 });
			const priority = widgets.find((widget) => widget.content === "Priority: None ▼");
			expect(priority?.position).toMatchObject({ top: 12, left: 3 });
			expect(widgets.some((widget) => widget.content?.includes("[↑↓←→/Tab]"))).toBe(true);

			mutableScreen.width = 80;
			mutableScreen.height = 24;
			mutableScreen.emit("resize");
			widgets = collectWidgets(screen as unknown as { children?: unknown[] });
			details = widgets.find((widget) => widget.options?.label === " Details ");
			type = widgets.find((widget) => widget.content === "Type: None ▼");
			expect(details?.position).toMatchObject({ top: 9, height: 4 });
			expect(type?.position).toMatchObject({ top: 11, left: 3 });
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "escape", "\x1b");
			expect(await withTimeout(resultPromise, "resized composer cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("scrolls the composer viewport so the actions stay reachable on a short terminal", async () => {
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 80, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 10, writable: true });
		const focused = () => (screen as unknown as { focused?: TestWidget }).focused;
		try {
			const resultPromise = openTaskComposer({
				screen,
				statuses: ["To Do", "Done"],
				persist: async () => task(),
			});
			await settleComposerFocus();
			const form = collectWidgets(screen as unknown as { children?: unknown[] }).find(
				(widget) => widget.type === "scrollable-box",
			);
			expect(form).toBeDefined();
			expect(form?.childBase).toBe(0);

			for (let step = 0; step < 8 && focused()?.content !== "Create task"; step += 1) {
				pressKey(focused(), "down");
			}
			expect(focused()?.content).toBe("Create task");
			// Ten rows cannot show every field, so reaching the buttons must scroll the viewport.
			expect(form?.childBase).toBeGreaterThan(0);

			pressKey(focused(), "enter", "\r");
			await waitUntil(() => focused()?.options?.label === " Title ", "focus to return to the title field");
			expect(form?.childBase).toBe(0);

			pressKey(focused(), "escape", "\x1b");
			expect(await withTimeout(resultPromise, "short terminal composer cancellation", 1000)).toBeNull();
		} finally {
			screen.destroy();
		}
	});

	it("opens the actual composer on an empty board and renders and focuses once after first-task creation", async () => {
		const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const screen = createScreen({ smartCSR: false });
		Object.defineProperty(screen, "width", { configurable: true, value: 100, writable: true });
		Object.defineProperty(screen, "height", { configurable: true, value: 30, writable: true });
		const originalRender = screen.render.bind(screen);
		let renders = 0;
		screen.render = () => {
			renders += 1;
			originalRender();
		};
		let resolveCreate!: (created: Task) => void;
		const createResult = new Promise<Task>((resolve) => {
			resolveCreate = resolve;
		});
		try {
			const boardPromise = renderBoardTui([], ["To Do", "Done"], "horizontal", 20, {
				screen,
				createTask: async () => createResult,
			});
			(screen as unknown as { emit(event: string): void }).emit("key n");
			await waitUntil(
				() =>
					collectWidgets(screen as unknown as { children?: unknown[] }).some(
						(widget) => widget.content === "Create task",
					),
				"the real task composer",
			);
			await waitUntil(
				() => typeof (screen as unknown as { focused?: TestWidget }).focused?.setValue === "function",
				"the title field to receive focus",
			);
			const focused = (screen as unknown as { focused?: TestWidget }).focused;
			focused?.setValue?.("Actual composer task");
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "down");
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "down");
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "down");
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "down");
			pressKey((screen as unknown as { focused?: TestWidget }).focused, "down");
			const create = (screen as unknown as { focused?: TestWidget }).focused;
			expect(create?.content).toBe("Create task");
			pressKey(create, "enter", "\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const rendersBeforeResolution = renders;
			resolveCreate(task({ id: "TASK-2", title: "Actual composer task" }));
			await waitUntil(() => {
				const boardFocus = (screen as unknown as { focused?: { items?: TestWidget[]; selected?: number } }).focused;
				return Boolean(boardFocus?.items?.[boardFocus.selected ?? 0]?.content?.includes("TASK-2"));
			}, "the created task to receive focus");
			expect(renders - rendersBeforeResolution).toBe(1);
			(screen as unknown as { emit(event: string): void }).emit("key q");
			await withTimeout(boardPromise, "board close after actual composer success", 1000);
		} finally {
			screen.destroy();
			if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	it("unwinds a rejected composer and applies future watcher updates", async () => {
		const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const screen = createScreen({ smartCSR: false });
		const initial = task({ title: "Existing" });
		const watched = task({ id: "TASK-2", title: "Watcher after rejection" });
		let subscriber: ((tasks: Task[], statuses: string[]) => void) | undefined;
		let composerCalls = 0;
		try {
			const boardPromise = renderBoardTui([initial], ["To Do", "Done"], "horizontal", 20, {
				screen,
				subscribeUpdates: (update) => {
					subscriber = update;
				},
				taskComposer: async () => {
					composerCalls += 1;
					if (composerCalls === 1) {
						subscriber?.([initial, watched], ["To Do", "Done"]);
						throw new Error("composer setup failed");
					}
					return null;
				},
			});
			(screen as unknown as { emit(event: string): void }).emit("key n");
			await waitUntil(() => composerCalls === 1, "the first composer rejection");
			await waitUntil(() => {
				const focused = (screen as unknown as { focused?: TestWidget }).focused;
				return Boolean(focused?.items?.some((item) => item.content?.includes("TASK-2")));
			}, "the queued watcher update");

			const later = task({ id: "TASK-3", title: "Future watcher update" });
			subscriber?.([initial, watched, later], ["To Do", "Done"]);
			await waitUntil(() => {
				const focused = (screen as unknown as { focused?: TestWidget }).focused;
				return Boolean(focused?.items?.some((item) => item.content?.includes("TASK-3")));
			}, "a future watcher update after rejection");
			(screen as unknown as { emit(event: string): void }).emit("key n");
			await waitUntil(() => composerCalls === 2, "the composer to reopen after rejection");
			(screen as unknown as { emit(event: string): void }).emit("key q");
			await withTimeout(boardPromise, "board close after composer rejection", 1000);
		} finally {
			screen.destroy();
			if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	for (const delivery of [
		"before persistence resolves",
		"before the composer closes",
		"after board success",
	] as const) {
		it(`handles watcher delivery ${delivery} with one board render and focused creation`, async () => {
			const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
			const screen = createScreen({ smartCSR: false });
			const originalRender = screen.render.bind(screen);
			let renders = 0;
			screen.render = () => {
				renders += 1;
				originalRender();
			};

			const initial = task({ id: "TASK-1", title: "Existing" });
			const created = task({ id: "TASK-2", title: "Created from N" });
			let subscriber: ((tasks: Task[], statuses: string[]) => void) | undefined;
			let composerCalls = 0;
			try {
				const boardPromise = renderBoardTui([initial], ["To Do", "Done"], "horizontal", 20, {
					screen,
					subscribeUpdates: (update) => {
						subscriber = update;
					},
					createTask: async () => {
						if (delivery === "before persistence resolves") subscriber?.([initial, created], ["To Do", "Done"]);
						return created;
					},
					taskComposer: async (options) => {
						composerCalls += 1;
						const result = await options.persist({ title: created.title, status: created.status });
						if (delivery === "before the composer closes") subscriber?.([initial, created], ["To Do", "Done"]);
						return result;
					},
				});
				expect(subscriber).toBeDefined();
				renders = 0;
				(screen as unknown as { emit(event: string): void }).emit("key n");

				for (let attempt = 0; attempt < 50 && renders < 1; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(composerCalls).toBe(1);
				expect(renders).toBe(1);
				const focusedList = (
					screen as unknown as { focused?: { items?: Array<{ content?: string }>; selected?: number } }
				).focused;
				expect(focusedList?.items?.[focusedList.selected ?? 0]?.content).toContain("TASK-2");

				if (delivery === "after board success") {
					subscriber?.([initial, created], ["To Do", "Done"]);
				}
				expect(renders).toBe(1);

				(screen as unknown as { emit(event: string): void }).emit("key q");
				await withTimeout(boardPromise, "board close", 1000);
			} finally {
				screen.destroy();
				if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
				else Reflect.deleteProperty(process.stdout, "isTTY");
			}
		});
	}
});

describe("TUI task creation board outcome", () => {
	it("focuses a visible created task and updates watcher duplicates in place", () => {
		const created = task();
		const tasks = upsertBoardTask([], created);
		const updated = upsertBoardTask(tasks, { ...created, title: "Watcher copy" });

		expect(updated).toHaveLength(1);
		expect(updated[0]?.title).toBe("Watcher copy");
		expect(getCreatedTaskBoardOutcome(created, true)).toEqual({
			focusTaskId: "TASK-1",
			message: "Created TASK-1.",
			tone: "green",
		});
	});

	it("explains why drafts and filtered tasks cannot be focused", () => {
		expect(getCreatedTaskBoardOutcome(task({ id: "DRAFT-1", status: "Draft" }), false)).toEqual({
			message: "Created DRAFT-1 as a draft. Drafts are not shown on the task board.",
			tone: "yellow",
		});
		expect(getCreatedTaskBoardOutcome(task(), false)).toEqual({
			message: "Created TASK-1, but it is hidden by the current board filters.",
			tone: "yellow",
		});
	});
});
