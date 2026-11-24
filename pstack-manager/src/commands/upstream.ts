import { join } from "node:path";
import { options, paths, print, warn } from "../cli.ts";
import { readText } from "../lib/fs.ts";
import { exists } from "../lib/fs.ts";
import { failedChecks, type SyncStatus } from "../upstream/analysis.ts";
import { countChanges } from "../upstream/diff.ts";
import { adoptCurrent, findRecord, readHistory, renderHistory } from "../upstream/history.ts";
import { loadAdapter } from "../build/adapter.ts";
import { readLock, verifyTree } from "../upstream/lock.ts";
import { adapterDir } from "../paths.ts";
import { countByAction } from "../upstream/impact.ts";
import type { SyncOptions, SyncOutcome } from "../upstream/pipeline.ts";
import { runSync } from "../upstream/pipeline.ts";
import { publishRollback, publishSync } from "../upstream/publish.ts";
import { reportJson, statusLine } from "../upstream/report.ts";
import { rollbackSync } from "../upstream/rollback.ts";

const COMMON = {
	ref: { type: "string" },
	repository: { type: "string" },
	source: { type: "string" },
	adapter: { type: "string" },
	trigger: { type: "string" },
	scripts: { type: "boolean" },
	"allow-downgrade": { type: "boolean" },
	"allow-rewrite": { type: "boolean" },
	"include-rolled-back": { type: "boolean" },
	"report-out": { type: "string" },
	"run-url": { type: "string" },
	json: { type: "boolean" },
	"exit-code": { type: "boolean" },
} as const;

type Values = Record<string, string | boolean | undefined>;

function syncOptions(values: Values): SyncOptions {
	return {
		source: values.source as string | undefined,
		repository: values.repository as string | undefined,
		ref: values.ref as string | undefined,
		adapterId: values.adapter as string | undefined,
		trigger: values.trigger as string | undefined,
		scripts: Boolean(values.scripts),
		allowDowngrade: Boolean(values["allow-downgrade"]),
		allowRewrite: Boolean(values["allow-rewrite"]),
		includeRolledBack: Boolean(values["include-rolled-back"]),
		reportOut: values["report-out"] as string | undefined,
		runUrl: values["run-url"] as string | undefined,
	};
}

/** Exit codes for `check --exit-code`, so a scheduled job can branch on the result. */
const EXIT: Record<SyncStatus, number> = { unchanged: 0, "dry-run": 10, prepared: 10, "needs-adapter-work": 10, conflict: 11, blocked: 11 };

function summarize(outcome: SyncOutcome): void {
	const { analysis } = outcome;
	const { lock, previous } = analysis;
	print(`upstream pstack ${previous ? `${previous.version} -> ` : ""}${lock.version} at ${lock.commit.slice(0, 12)} (tree ${lock.tree.slice(0, 12)})`);
	print(`status: ${outcome.status}. ${statusLine(outcome.status)}`);
	if (outcome.status === "unchanged" && analysis.conflicts.length === 0) return;
	const counts = countChanges(analysis.diff);
	print(`files: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.renamed} renamed, ${counts["mode-changed"]} mode changes`);
	for (const change of analysis.diff.changes.filter((c) => c.kind === "renamed").slice(0, 10)) print(`  renamed ${change.from} -> ${change.path} (${Math.round((change.similarity || 1) * 100)}%)`);
	const actions = countByAction(analysis.impact);
	print(`copilot adaptations: ${actions.manual} need a human, ${actions.review} to review, ${actions.migrated} prepared, ${actions.automatic} handled by the build`);
	for (const conflict of analysis.conflicts) warn(`${conflict.severity === "blocking" ? "CONFLICT" : "warning"} ${conflict.kind}: ${conflict.message}`);
	for (const check of failedChecks(analysis)) warn(`failing check: ${check}`);
	if (outcome.reportPath) print(`report: ${outcome.reportPath}`);
}

export async function upstream(args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	const p = paths();
	switch (sub) {
		case "check": {
			const { values } = options(rest, COMMON);
			const outcome = runSync(p, { ...syncOptions(values), dryRun: true });
			if (values.json) process.stdout.write(`${JSON.stringify(reportJson(outcome.analysis, outcome.status, values.trigger || "local"), null, "\t")}\n`);
			else summarize(outcome);
			return values["exit-code"] ? EXIT[outcome.status] : outcome.status === "conflict" ? 1 : 0;
		}
		case "sync": {
			const { values } = options(rest, { ...COMMON, prepare: { type: "boolean" } });
			const outcome = runSync(p, { ...syncOptions(values), prepare: Boolean(values.prepare) });
			summarize(outcome);
			return outcome.status === "conflict" || outcome.status === "blocked" ? 1 : 0;
		}
		case "run": {
			const { values } = options(rest, { ...COMMON, base: { type: "string" }, remote: { type: "string" }, "no-push": { type: "boolean" }, gh: { type: "string" }, "author-name": { type: "string" }, "author-email": { type: "string" } });
			const author = values["author-name"] && values["author-email"] ? { name: values["author-name"], email: values["author-email"] } : undefined;
			const result = publishSync(p, { sync: syncOptions(values), base: values.base, remote: values.remote, push: !values["no-push"], gh: values.gh, author });
			summarize(result.sync);
			print(`action: ${result.action}${result.pullRequest ? `: ${result.pullRequest}${result.draft ? " (draft, needs adapter work)" : ""}` : ""}${result.issue ? `: ${result.issue}` : ""}${result.note ? ` (${result.note})` : ""}`);
			if (process.env.GITHUB_OUTPUT) {
				const { appendFileSync } = await import("node:fs");
				appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.sync.status}\naction=${result.action}\nurl=${result.pullRequest || result.issue || ""}\n`);
			}
			return 0;
		}
		case "rollback": {
			const { values } = options(rest, { to: { type: "string" }, adapter: { type: "string" }, "dry-run": { type: "boolean" }, commit: { type: "boolean" }, trigger: { type: "string" }, pr: { type: "boolean" }, base: { type: "string" }, remote: { type: "string" }, "no-push": { type: "boolean" }, gh: { type: "string" }, "author-name": { type: "string" }, "author-email": { type: "string" } });
			if (values.pr) {
				const author = values["author-name"] && values["author-email"] ? { name: values["author-name"], email: values["author-email"] } : undefined;
				const published = publishRollback(p, { to: values.to, adapterId: values.adapter, trigger: values.trigger }, { base: values.base, remote: values.remote, push: !values["no-push"], gh: values.gh, author });
				print(`${published.rollback.status}: ${published.rollback.message}`);
				for (const file of published.rollback.files) warn(`  ${file}`);
				if (published.pullRequest) print(`pull request: ${published.pullRequest}`);
				return published.rollback.status === "reverted" ? 0 : 1;
			}
			const result = rollbackSync(p, { to: values.to, adapterId: values.adapter, dryRun: values["dry-run"], commit: values.commit, trigger: values.trigger });
			print(`${result.status}: ${result.message}`);
			for (const file of result.files) warn(`  ${file}`);
			return result.status === "reverted" || result.status === "dry-run" ? 0 : 1;
		}
		case "history": {
			const { values } = options(rest, { json: { type: "boolean" }, adopt: { type: "boolean" }, adapter: { type: "string" } });
			if (values.adopt) {
				const adapter = loadAdapter(adapterDir(p, values.adapter || "copilot"));
				const lock = readLock(p.lockFile);
				const adopted = adoptCurrent(p, adapter.revision, adapter.coreVersions, verifyTree(p.coreUpstream, lock), new Date());
				print(adopted ? `recorded ${adopted.to.version} (${adopted.to.commit.slice(0, 12)}) as the first history entry` : "the history already has entries; nothing to adopt");
			}
			const history = readHistory(p);
			print(values.json ? JSON.stringify(history, null, "\t") : renderHistory(history));
			return 0;
		}
		case "report": {
			const { positionals } = options(rest, {});
			const history = readHistory(p);
			const record = positionals[0] ? findRecord(history, positionals[0]) : [...history.entries].reverse().find((entry) => entry.report);
			if (!record || !record.report) {
				warn("no report found");
				return 1;
			}
			const file = join(p.repoRoot, record.report);
			if (!exists(file)) {
				warn(`${record.report} is missing`);
				return 1;
			}
			process.stdout.write(readText(file));
			return 0;
		}
		default:
			warn("usage: pstack upstream check|sync|run|rollback|history|report");
			return 2;
	}
}
