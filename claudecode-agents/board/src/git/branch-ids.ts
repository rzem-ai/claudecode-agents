/**
 * Task ids in every ref the clone knows about, read-only. A separate
 * `git ls-tree` per ref (from `for-each-ref`) would spawn one subprocess per
 * branch on every id allocation - hundreds of them in a repository with
 * hundreds of remote-tracking refs, in the same process as the web server.
 * `git log --all --name-only --diff-filter=A --format=` instead walks the
 * history reachable from every ref in a single subprocess and prints every
 * path ever added anywhere in that history. A file added on some ref and
 * later deleted or archived still printed here, so its id still counts as
 * occupied - conservative, and exactly what allocation wants: an id must
 * never be reused just because its file moved or vanished. No fetch: what
 * the clone has not seen it cannot consult, and that is the accepted limit.
 */
export function listTaskIdsAcrossRefs(repoRoot: string, boardRelPath: string, prefix: string): string[] {
	const log = Bun.spawnSync(
		["git", "-C", repoRoot, "log", "--all", "--name-only", "--diff-filter=A", "--format=", "--", `${boardRelPath}/tasks`],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (log.exitCode !== 0) return [];
	const idRe = new RegExp(`(?:^|/)(${prefix}-\\d+(?:\\.\\d+)*)(?:[ .-]|$)`, "i");
	const ids = new Set<string>();
	for (const path of log.stdout.toString().split("\n")) {
		const m = idRe.exec(path);
		if (m?.[1]) ids.add(m[1].toUpperCase());
	}
	return [...ids];
}
