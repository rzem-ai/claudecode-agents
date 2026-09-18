import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFocus } from "../core/focus.ts";
import { McpServer } from "../mcp/server.ts";
import { registerFocusTools } from "../mcp/tools/focus/index.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const getText = (content: unknown[] | undefined): string => (content?.[0] as { text?: string } | undefined)?.text ?? "";

let TEST_DIR: string;
let server: McpServer;

async function call(name: string, args: Record<string, unknown> = {}) {
	return server.testInterface.callTool({ params: { name, arguments: args } });
}

describe("task_focus", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-focus");
		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureBacklogStructure();
		await initializeFilesystemTestProject(server, "Test Project");
		const config = await server.filesystem.loadConfig();
		if (!config) throw new Error("no config");
		registerTaskTools(server, config);
		registerFocusTools(server);
	});

	afterEach(async () => {
		await server.stop();
		await safeCleanup(TEST_DIR);
	});

	it("focuses an existing item and clears it", async () => {
		const created = await call("task_create", { title: "Focus me" });
		// The plain-text detail leads with a "File: .../<id> - <slug>.md" line whose
		// path segment carries the id in its original (lowercase) generated case; the
		// canonical id is on the "Task <ID> - <title>" header line below it, so anchor
		// there rather than taking the first id-shaped token in the text.
		const id = /^Task ([A-Za-z]+-\d+) /m.exec(getText(created.content))?.[1];
		expect(id).toBeDefined();
		const focused = JSON.parse(getText((await call("task_focus", { id: id?.toLowerCase() })).content));
		expect(focused.focused).toBe(id);
		expect(readFocus(TEST_DIR)).toBe(id as string);
		const unchanged = JSON.parse(getText((await call("task_focus", {})).content));
		expect(unchanged.focused).toBe(id);
		const cleared = JSON.parse(getText((await call("task_focus", { clear: true })).content));
		expect(cleared.focused).toBeNull();
		expect(readFocus(TEST_DIR)).toBeNull();
	});

	it("refuses an unknown id", async () => {
		const r = await call("task_focus", { id: "BD-99" });
		expect(r.isError).toBe(true);
	});
});
