import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Core } from "../core/backlog.ts";
import { setCommitContext } from "../git/commit-context.ts";
import { BacklogServer } from "../server/index.ts";
import { getPackageName } from "../utils/app-info.ts";
import { getVersion } from "../utils/version.ts";
import { registerDefinitionOfDoneTools } from "./tools/definition-of-done/index.ts";
import { registerDocumentTools } from "./tools/documents/index.ts";
import { registerFocusTools } from "./tools/focus/index.ts";
import { registerMilestoneTools } from "./tools/milestones/index.ts";
import { registerServeTools } from "./tools/serve/index.ts";
import { registerTaskTools } from "./tools/tasks/index.ts";
import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	McpPromptHandler,
	McpResourceHandler,
	McpToolHandler,
	ReadResourceResult,
} from "./types.ts";

/**
 * Minimal MCP server implementation for stdio transport.
 *
 * The Backlog.md MCP server is intentionally local-only and exposes tools,
 * resources, and prompts through the stdio transport so that desktop editors
 * (e.g. Claude Code) can interact with a project without network exposure.
 */
const APP_NAME = getPackageName();
const INSTRUCTIONS =
	"This is the repository's board, under .boards/ in the main checkout. Read items with task_view, task_list and task_search; add a comment with task_edit; say which item a phase is on with task_focus; never move an item's status, the fleet's hooks own that.";

type ServerInitOptions = {
	debug?: boolean;
};

/** What board_serve and board_url return. */
export type WebUiStatus = {
	running: boolean;
	url: string | null;
	host: string | null;
	port: number | null;
};

export class McpServer extends Core {
	private readonly server: Server;
	private transport?: StdioServerTransport;
	private stopping = false;

	/** The session's web UI, started by board_serve and stopped with this server. Null until asked for. */
	private webUi: BacklogServer | null = null;
	private webUiStarting: Promise<WebUiStatus> | null = null;

	private readonly tools = new Map<string, McpToolHandler>();
	private readonly resources = new Map<string, McpResourceHandler>();
	private readonly prompts = new Map<string, McpPromptHandler>();

	constructor(projectRoot: string, instructions: string, version = "0.0.0") {
		super(projectRoot, { enableWatchers: true });

		this.server = new Server(
			{
				name: APP_NAME,
				version,
			},
			{
				capabilities: {
					tools: { listChanged: true },
					resources: { listChanged: true },
					prompts: { listChanged: true },
				},
				instructions,
			},
		);

		this.setupHandlers();
	}

	private setupHandlers(): void {
		this.server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools());
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request));
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => this.listResources());
		this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => this.listResourceTemplates());
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => this.readResource(request));
		this.server.setRequestHandler(ListPromptsRequestSchema, async () => this.listPrompts());
		this.server.setRequestHandler(GetPromptRequestSchema, async (request) => this.getPrompt(request));
	}

	/**
	 * Register a tool implementation with the server.
	 */
	public addTool(tool: McpToolHandler): void {
		this.tools.set(tool.name, tool);
	}

	/** Where the web UI is, without starting it. */
	public webUiStatus(): WebUiStatus {
		const url = this.webUi?.url ?? null;
		if (!this.webUi || url === null) return { running: false, url: null, host: null, port: null };
		return { running: true, url, host: this.webUi.host, port: this.webUi.port };
	}

	/**
	 * Start the web UI on a random loopback port if it is not running, and
	 * report where it is. Idempotent, and two overlapping calls share one
	 * start. Quiet, because stdout here is the MCP transport.
	 */
	public async startWebUi(): Promise<WebUiStatus> {
		if (this.webUi?.url) return this.webUiStatus();
		if (this.webUiStarting) return this.webUiStarting;
		const ui = new BacklogServer(this.filesystem.rootDir);
		this.webUiStarting = ui
			.start(0, false, { quiet: true })
			.then(() => {
				this.webUi = ui;
				return this.webUiStatus();
			})
			.finally(() => {
				this.webUiStarting = null;
			});
		return this.webUiStarting;
	}

	/** Stop the web UI if it is running. Safe to call when it is not. */
	public async stopWebUi(): Promise<void> {
		const ui = this.webUi;
		this.webUi = null;
		if (ui) await ui.stop();
	}

	/**
	 * Register a resource implementation with the server.
	 */
	public addResource(resource: McpResourceHandler): void {
		this.resources.set(resource.uri, resource);
	}

	/**
	 * Register a prompt implementation with the server.
	 */
	public addPrompt(prompt: McpPromptHandler): void {
		this.prompts.set(prompt.name, prompt);
	}

	/**
	 * Connect the server to the stdio transport.
	 */
	public async connect(): Promise<void> {
		if (this.transport) {
			return;
		}

		this.transport = new StdioServerTransport();
		await this.server.connect(this.transport);
	}

	/**
	 * Start the server. The stdio transport begins handling requests as soon as
	 * it is connected, so this method exists primarily for symmetry with
	 * callers that expect an explicit start step.
	 */
	public async start(): Promise<void> {
		if (!this.transport) {
			throw new Error("MCP server not connected. Call connect() before start().");
		}
	}

	/**
	 * Stop the server and release transport resources.
	 */
	public async stop(): Promise<void> {
		if (this.stopping) {
			return;
		}
		this.stopping = true;
		try {
			await this.stopWebUi();
			await this.server.close();
		} finally {
			this.transport = undefined;
			this.disposeSearchService();
			this.disposeContentStore();
		}
	}

	public getServer(): Server {
		return this.server;
	}

	// -- Internal handlers --------------------------------------------------

	protected async listTools(): Promise<ListToolsResult> {
		return {
			tools: Array.from(this.tools.values()).map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: {
					type: "object",
					...tool.inputSchema,
				},
				...(tool.annotations ? { annotations: tool.annotations } : {}),
			})),
		};
	}

	protected async callTool(request: {
		params: { name: string; arguments?: Record<string, unknown> };
	}): Promise<CallToolResult> {
		const { name, arguments: args = {} } = request.params;
		const tool = this.tools.get(name);

		if (!tool) {
			throw new McpError(ErrorCode.InvalidParams, `Tool not found: ${name}`);
		}

		return await tool.handler(args);
	}

	protected async listResources(): Promise<ListResourcesResult> {
		return {
			resources: Array.from(this.resources.values()).map((resource) => ({
				uri: resource.uri,
				name: resource.name || "Unnamed Resource",
				description: resource.description,
				mimeType: resource.mimeType,
			})),
		};
	}

	protected async listResourceTemplates(): Promise<ListResourceTemplatesResult> {
		return {
			resourceTemplates: [],
		};
	}

	protected async readResource(request: { params: { uri: string } }): Promise<ReadResourceResult> {
		const { uri } = request.params;

		// Exact match first
		let resource = this.resources.get(uri);

		// Fallback to base URI for parameterised resources
		if (!resource) {
			const baseUri = uri.split("?")[0] || uri;
			resource = this.resources.get(baseUri);
		}

		if (!resource) {
			throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
		}

		return await resource.handler(uri);
	}

	protected async listPrompts(): Promise<ListPromptsResult> {
		return {
			prompts: Array.from(this.prompts.values()).map((prompt) => ({
				name: prompt.name,
				description: prompt.description,
				arguments: prompt.arguments,
			})),
		};
	}

	protected async getPrompt(request: {
		params: { name: string; arguments?: Record<string, unknown> };
	}): Promise<GetPromptResult> {
		const { name, arguments: args = {} } = request.params;
		const prompt = this.prompts.get(name);

		if (!prompt) {
			throw new McpError(ErrorCode.InvalidParams, `Prompt not found: ${name}`);
		}

		return await prompt.handler(args);
	}

	/**
	 * Helper exposed for tests so they can call handlers directly.
	 */
	public get testInterface() {
		return {
			listTools: () => this.listTools(),
			callTool: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => this.callTool(request),
			listResources: () => this.listResources(),
			listResourceTemplates: () => this.listResourceTemplates(),
			readResource: (request: { params: { uri: string } }) => this.readResource(request),
			listPrompts: () => this.listPrompts(),
			getPrompt: (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
				this.getPrompt(request),
		};
	}
}

/**
 * Factory that bootstraps a fully configured MCP server instance.
 *
 * The board root is fixed (see resolveBoardRoot), so a root without a config is
 * an error rather than something to discover a way out of.
 */
export async function createMcpServer(projectRoot: string, options: ServerInitOptions = {}): Promise<McpServer> {
	// We need to check config first to determine which instructions to use
	const tempCore = new Core(projectRoot);
	await tempCore.ensureConfigLoaded();
	const [config, version] = await Promise.all([tempCore.filesystem.loadConfig(), getVersion()]);

	if (!config) {
		throw new Error("no board/config.yml under the board root");
	}

	const server = new McpServer(projectRoot, INSTRUCTIONS, version);

	setCommitContext({ by: "mcp" });
	registerTaskTools(server, config);
	registerMilestoneTools(server);
	registerDefinitionOfDoneTools(server);
	registerDocumentTools(server, config);
	registerServeTools(server);
	registerFocusTools(server);

	if (options.debug) {
		console.error("MCP server initialised (stdio transport only).");
	}

	return server;
}
