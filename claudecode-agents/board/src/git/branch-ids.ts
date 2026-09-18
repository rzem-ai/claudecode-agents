/**
 * Task ids in every ref the clone knows about, read-only. `git for-each-ref`
 * lists local and remote-tracking branches; `git ls-tree` lists the task files
 * in each without checking anything out. No fetch: what the clone has not seen
 * it cannot consult, and that is the accepted limit.
 */
export function listTaskIdsAcrossRefs(repoRoot: string, boardRelPath: string, prefix: string): string[] {
	const refs = Bun.spawnSync(["git", "-C", repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (refs.exitCode !== 0) return [];
	const idRe = new RegExp(`(?:^|/)(${prefix}-\\d+(?:\\.\\d+)*)(?:[ .-]|$)`, "i");
	const ids = new Set<string>();
	for (const ref of refs.stdout.toString().split("\n").filter(Boolean)) {
		const tree = Bun.spawnSync(["git", "-C", repoRoot, "ls-tree", "-r", "--name-only", ref, "--", `${boardRelPath}/tasks`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (tree.exitCode !== 0) continue;
		for (const path of tree.stdout.toString().split("\n")) {
			const m = idRe.exec(path);
			if (m?.[1]) ids.add(m[1].toUpperCase());
		}
	}
	return [...ids];
}
