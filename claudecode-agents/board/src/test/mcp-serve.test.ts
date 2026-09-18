import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { McpServer } from "../mcp/server.ts";
import { registerServeTools } from "../mcp/tools/serve/index.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

// The web UI is per Claude Code instance: it lives inside the session's own MCP
// process, on a random loopback port, started only when asked. These pin the
// two tools that make that true - board_serve starts it once and hands back the
// URL, board_url answers without starting anything - and that stopping the MCP
// server takes the web UI with it.

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let server: McpServer;

async function call(name: string, args: Record<string, unknown> = {}) {
	return server.testInterface.callTool({ params: { name, arguments: args } });
}

describe("MCP serve tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-serve");
		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureBacklogStructure();
		await initializeFilesystemTestProject(server, "Test Project");
		registerServeTools(server);
	});

	afterEach(async () => {
		await server.stop();
		await safeCleanup(TEST_DIR);
	});

	it("board_url reports not running before anything is started", async () => {
		const result = await call("board_url");
		const body = JSON.parse(getText(result.content));
		expect(body.running).toBe(false);
		expect(body.url).toBeNull();
	});

	it("board_serve starts the web UI on a random loopback port and returns its URL", async () => {
		const result = await call("board_serve");
		const body = JSON.parse(getText(result.content));
		expect(body.running).toBe(true);
		expect(body.host).toBe("127.0.0.1");
		expect(body.port).toBeGreaterThan(0);
		expect(body.url).toBe(`http://127.0.0.1:${body.port}`);

		const res = await fetch(`${body.url}/api/tasks`);
		expect(res.status).toBe(200);
	});

	it("board_serve is idempotent: a second call returns the same URL", async () => {
		const first = JSON.parse(getText((await call("board_serve")).content));
		const second = JSON.parse(getText((await call("board_serve")).content));
		expect(second.url).toBe(first.url);

		const asked = JSON.parse(getText((await call("board_url")).content));
		expect(asked.running).toBe(true);
		expect(asked.url).toBe(first.url);
	});

	it("stopping the MCP server stops the web UI", async () => {
		const body = JSON.parse(getText((await call("board_serve")).content));
		await server.stop();
		let refused = false;
		try {
			await fetch(`${body.url}/api/tasks`);
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
	});
});
