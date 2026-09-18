import { clearFocus, readFocus, writeFocus } from "../../../core/focus.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";

/**
 * Which item this checkout's sessions are on. The lead calls it when it starts
 * a phase; the SubagentStart hook reads the file it writes before anything
 * else. Replaces setting CLAUDECODE_AGENTS_BOARD_PAGE_ID at launch.
 */
export function registerFocusTools(server: McpServer): void {
	const schema = {
		type: "object",
		properties: {
			id: { type: "string", description: "The item to focus, any case. Omit with clear: true to forget the focus." },
			clear: { type: "boolean", description: "Forget the current focus." },
		},
		additionalProperties: false,
	};

	const focusTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_focus",
			description:
				"Set the board item this checkout's sessions are working on, so the hooks move that item as agents start and stop. Call it when you start a phase against an item. Pass clear: true to forget it. Returns {focused: id | null}.",
			inputSchema: schema,
			annotations: { title: "Focus an item", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		schema,
		async (input) => {
			const root = server.filesystem.rootDir;
			const args = input as { id?: string; clear?: boolean };
			if (args.clear) {
				clearFocus(root);
				return { content: [{ type: "text", text: JSON.stringify({ focused: null }) }] };
			}
			if (!args.id) {
				return { content: [{ type: "text", text: JSON.stringify({ focused: readFocus(root) }) }] };
			}
			const task = await server.getTask(args.id);
			if (!task) {
				return { content: [{ type: "text", text: `no task ${args.id} on this board` }], isError: true };
			}
			writeFocus(root, task.id);
			return { content: [{ type: "text", text: JSON.stringify({ focused: task.id }) }] };
		},
	);

	server.addTool(focusTool);
}
