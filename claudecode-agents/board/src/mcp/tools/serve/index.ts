import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";

/**
 * The web UI, per Claude Code instance.
 *
 * Nothing about the board depends on the web UI: the task tools and the fleet's
 * hooks read and write the task files directly. The UI is a viewer for the
 * human, started only when asked - the `/board` command calls `board_serve` -
 * inside this MCP process, on a random loopback port, so it lives and dies
 * with the session that started it. `board_url` answers without starting
 * anything, so an agent can report whether there is a board to look at.
 */
export function registerServeTools(server: McpServer): void {
	const emptySchema = { type: "object", properties: {}, additionalProperties: false };

	const serveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "board_serve",
			description:
				"Start the board's web UI for this session if it is not already running, on a random loopback port, and return its URL. Idempotent: a second call returns the same URL. The UI stops when this session's MCP server stops.",
			inputSchema: emptySchema,
			annotations: { title: "Serve the board", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		emptySchema,
		async () => {
			const status = await server.startWebUi();
			return { content: [{ type: "text", text: JSON.stringify(status) }] };
		},
	);

	const urlTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "board_url",
			description:
				"Report whether this session's board web UI is running and, if so, its URL. Starts nothing; use board_serve to start it.",
			inputSchema: emptySchema,
			annotations: { title: "Board URL", readOnlyHint: true, destructiveHint: false },
		},
		emptySchema,
		async () => {
			return { content: [{ type: "text", text: JSON.stringify(server.webUiStatus()) }] };
		},
	);

	server.addTool(serveTool);
	server.addTool(urlTool);
}
