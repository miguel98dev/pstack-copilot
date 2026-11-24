import type { CheckResult } from "../validate/index.ts";
import type { Conflict } from "./conflicts.ts";
import type { UpstreamDiff } from "./diff.ts";
import type { UpstreamHistory } from "./fetch.ts";
import type { Impact } from "./impact.ts";
import type { UpstreamLock } from "./lock.ts";
import type { MigrationPlan } from "./migrate.ts";

export type SyncStatus = "unchanged" | "dry-run" | "conflict" | "blocked" | "prepared" | "needs-adapter-work";

/** Everything the sync learned about one upstream state, before and after it decided what to do. */
export interface Analysis {
	readonly lock: UpstreamLock;
	readonly previous: UpstreamLock | null;
	readonly diff: UpstreamDiff;
	readonly upstream: UpstreamHistory;
	readonly impact: Impact;
	readonly conflicts: readonly Conflict[];
	readonly migration: MigrationPlan | null;
	/** Results of building and validating the migrated adapter against the new core; null when nothing was built. */
	readonly validation: readonly CheckResult[] | null;
	/** Problems that stop the build or the validation from running at all. */
	readonly buildError: string | null;
}

export function failedChecks(analysis: Pick<Analysis, "validation" | "buildError">): string[] {
	const failed = (analysis.validation || []).filter((check) => check.problems.length > 0).map((check) => check.name);
	return analysis.buildError ? ["build", ...failed] : failed;
}

export function validationPassed(analysis: Pick<Analysis, "validation" | "buildError">): boolean {
	return analysis.buildError === null && analysis.validation !== null && failedChecks(analysis).length === 0;
}
