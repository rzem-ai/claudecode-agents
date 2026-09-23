import type { BacklogConfig } from "../types/index.ts";

export const DEFAULT_PRIORITY_OPTIONS = [
	{ label: "High", value: "high" },
	{ label: "Medium", value: "medium" },
	{ label: "Low", value: "low" },
] as const;

export type PriorityOption = {
	label: string;
	value: string;
};

export function normalizePriorityValue(value: string | null | undefined): string | undefined {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
	return normalized.length > 0 ? normalized : undefined;
}

export function getPriorityOptions(
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): PriorityOption[] {
	const configuredPriorities: readonly string[] = Array.isArray(configOrPriorities)
		? configOrPriorities
		: ((configOrPriorities as Pick<BacklogConfig, "priorities"> | null | undefined)?.priorities ?? []);
	const options: PriorityOption[] = [];
	const seen = new Set<string>();

	for (const entry of configuredPriorities) {
		const label = String(entry ?? "")
			.trim()
			.replace(/\s+/g, " ");
		const value = normalizePriorityValue(label);
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		options.push({ label, value });
	}

	return options.length > 0 ? options : DEFAULT_PRIORITY_OPTIONS.map((option) => ({ ...option }));
}

export function getPriorityValues(
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): string[] {
	return getPriorityOptions(configOrPriorities).map((option) => option.value);
}

export function getPriorityLabels(
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): string[] {
	return getPriorityOptions(configOrPriorities).map((option) => option.label);
}

export function resolvePriorityValue(
	value: string | null | undefined,
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): string | undefined {
	const normalized = normalizePriorityValue(value);
	if (!normalized) {
		return undefined;
	}
	const allowed = new Set(getPriorityValues(configOrPriorities));
	return allowed.has(normalized) ? normalized : undefined;
}

export function formatPriorityLabel(
	value: string | null | undefined,
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): string {
	const normalized = normalizePriorityValue(value);
	if (!normalized) {
		return "";
	}
	const configured = getPriorityOptions(configOrPriorities).find((option) => option.value === normalized);
	if (configured) {
		return configured.label;
	}
	return normalized
		.split(" ")
		.map((part) => (part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : ""))
		.join(" ");
}

/**
 * The spelling a priority is written to disk with: the configured label when the
 * config lists the value, otherwise the value unchanged. Only explicitly configured
 * priorities apply, so a board without a `priorities` list keeps its lowercase files.
 */
export function toPersistedPriority(
	value: string | undefined,
	config: Pick<BacklogConfig, "priorities"> | null | undefined,
): string | undefined {
	const normalized = normalizePriorityValue(value);
	if (!normalized || !config?.priorities?.length) {
		return value;
	}
	return getPriorityOptions(config).find((option) => option.value === normalized)?.label ?? value;
}

export function getPriorityRank(
	value: string | null | undefined,
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): number {
	const normalized = normalizePriorityValue(value);
	if (!normalized) {
		return 0;
	}
	const values = getPriorityValues(configOrPriorities);
	const index = values.indexOf(normalized);
	return index === -1 ? 0 : values.length - index;
}

export function formatValidPriorityValues(
	configOrPriorities?: Pick<BacklogConfig, "priorities"> | readonly string[] | null,
): string {
	return getPriorityLabels(configOrPriorities).join(", ");
}
