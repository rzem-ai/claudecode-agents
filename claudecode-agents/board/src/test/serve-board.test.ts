import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import { BacklogServer } from "../server/index.ts";
import { unusedLoopbackPort } from "./test-ports.ts";

let root = "";
let server: BacklogServer | undefined;
let port = 0;

beforeAll(async () => {
	port = await unusedLoopbackPort();
	root = mkdtempSync(join(tmpdir(), "board-serve-"));
	mkdirSync(join(root, DEFAULT_DIRECTORIES.BACKLOG, "tasks"), { recursive: true });
	writeFileSync(
		join(root, DEFAULT_DIRECTORIES.BACKLOG, "config.yml"),
		'project_name: "t"\ntask_prefix: "BD"\nstatuses: ["To Do", "Doing", "Blocked", "Blocked by human", "Done"]\n',
	);
	server = new BacklogServer(root);
	await server.start(port, false);
});

afterAll(async () => {
	// A failed beforeAll should not be masked by a failure to stop a server that never started.
	await server?.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("board serve", () => {
	it("serves the page with the fleet's name and no upstream branding", async () => {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		expect(html).toContain("<title>Board</title>");
		expect(html).not.toContain("Backlog.md");
	});

	it("serves the tasks API", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("serves the configured statuses", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/statuses`);
		expect(await res.json()).toEqual(["To Do", "Doing", "Blocked", "Blocked by human", "Done"]);
	});
});
