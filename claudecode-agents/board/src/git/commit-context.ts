/**
 * Who a commit is for and what it records. The CLI sets it from `--by` and
 * from the shape of the edit (a `-s` is a status move, a `--comment` is a
 * comment); the MCP server sets `by: "mcp"`. The git layer reads it when it
 * builds the subject. Process-wide because one invocation makes one write.
 */
export type CommitContext = { by?: string; note?: string };

let current: CommitContext = {};

export function setCommitContext(ctx: CommitContext): void {
	current = { ...current, ...ctx };
}

export function getCommitContext(): CommitContext {
	return current;
}

export function clearCommitContext(): void {
	current = {};
}
