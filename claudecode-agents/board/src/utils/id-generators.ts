import type { Core } from "../core/backlog.ts";

/**
 * Generate the next available document ID from the local documents
 * @param core Core instance for filesystem operations
 * @returns Promise<string> Next available document ID (e.g., "doc-001")
 */
export async function generateNextDocId(core: Core): Promise<string> {
	const config = await core.filesystem.loadConfig();
	// Load local documents
	const docs = await core.filesystem.listDocuments();
	const allIds: string[] = [];

	// Add local document IDs
	for (const doc of docs) {
		allIds.push(doc.id);
	}

	// Find the highest numeric ID
	let max = 0;
	for (const id of allIds) {
		const match = id.match(/^doc-(\d+)$/);
		if (match) {
			const num = Number.parseInt(match[1] || "0", 10);
			if (num > max) max = num;
		}
	}

	const nextIdNumber = max + 1;
	const padding = config?.zeroPaddedIds;

	if (padding && typeof padding === "number" && padding > 0) {
		const paddedId = String(nextIdNumber).padStart(padding, "0");
		return `doc-${paddedId}`;
	}

	return `doc-${nextIdNumber}`;
}

/**
 * Generate the next available decision ID from the local decisions
 * @param core Core instance for filesystem operations
 * @returns Promise<string> Next available decision ID (e.g., "decision-001")
 */
export async function generateNextDecisionId(core: Core): Promise<string> {
	const config = await core.filesystem.loadConfig();
	// Load local decisions
	const decisions = await core.filesystem.listDecisions();
	const allIds: string[] = [];

	// Add local decision IDs
	for (const decision of decisions) {
		allIds.push(decision.id);
	}

	// Find the highest numeric ID
	let max = 0;
	for (const id of allIds) {
		const match = id.match(/^decision-(\d+)$/);
		if (match) {
			const num = Number.parseInt(match[1] || "0", 10);
			if (num > max) max = num;
		}
	}

	const nextIdNumber = max + 1;
	const padding = config?.zeroPaddedIds;

	if (padding && typeof padding === "number" && padding > 0) {
		const paddedId = String(nextIdNumber).padStart(padding, "0");
		return `decision-${paddedId}`;
	}

	return `decision-${nextIdNumber}`;
}
