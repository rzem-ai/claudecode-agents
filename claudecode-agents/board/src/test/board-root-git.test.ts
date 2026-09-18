import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_DIR, mainCheckoutOf, resolveBoardRoot } from "../board-root.ts";

// The board is the main checkout's .boards, found from any cwd inside the
// repository - a subdirectory, or a linked worktree, which carries its own
// stale copy and must never be the answer.
let tmp = "";
let repo = "";
let wt = "";

function git(dir: string, ...args: string[]) {
	const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "board-root-git-"));
	repo = join(tmp, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	mkdirSync(join(repo, BOARD_DIR, "tasks"), { recursive: true });
	writeFileSync(join(repo, BOARD_DIR, "config.yml"), 'project_name: "t"\ntask_prefix: "BD"\n');
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	wt = join(tmp, "wt");
	git(repo, "worktree", "add", "-q", wt, "-b", "agent-x");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveBoardRoot through git", () => {
	it("finds the repository root from a subdirectory", () => {
		expect(resolveBoardRoot({}, join(repo, "src", "deep"))).toBe(repo);
	});

	it("resolves a linked worktree to the main checkout, never the worktree's copy", () => {
		expect(mainCheckoutOf(wt)).toBe(repo);
		expect(resolveBoardRoot({}, wt)).toBe(repo);
	});

	it("says 'no board here' outside a repository", () => {
		const bare = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(() => resolveBoardRoot({}, bare)).toThrow("no board here");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("says 'no board here' in a repository with no .boards", () => {
		const other = join(tmp, "other");
		mkdirSync(other);
		git(other, "init", "-q", "-b", "main");
		expect(() => resolveBoardRoot({}, other)).toThrow("no board here");
	});

	it("lets the environment variable win over discovery", () => {
		expect(resolveBoardRoot({ CLAUDECODE_AGENTS_BOARD_ROOT: repo }, wt)).toBe(repo);
	});
});
