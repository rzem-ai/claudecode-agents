/**
 * Who a commit is for and what it records. `note` is the imperative action
 * the subject opens with, naming the item (`Move BD-2 to Doing`); the CLI
 * sets it from the shape of the edit (a `-s` is a status move, a `--comment`
 * is a comment). `by` becomes the `Board-Writer` trailer; the CLI sets it
 * from `--by` and the MCP server sets `by: "mcp"`. The git layer reads both
 * when it builds the message. Process-wide because one invocation makes one
 * write.
 */
export type CommitContext = { by?: string; note?: string };

let current: CommitContext = {};

export function setCommitContext(ctx: CommitContext): void {
	current = { ...current, ...ctx };
}

export function getCommitContext(): CommitContext {
	return current;
}

export function setCommitNote(note: string | undefined): void {
	current = { ...current, note };
}

/**
 * Clears the note only. `by` is sticky: a long-lived process such as the MCP
 * server sets it once at construction and every commit it makes after should
 * still carry it, so a commit's write completing must not erase who wrote it.
 */
export function clearCommitNote(): void {
	current = { ...current, note: undefined };
}

/** Clears both `by` and `note`. For tests that want a clean slate. */
export function resetCommitContext(): void {
	current = {};
}
