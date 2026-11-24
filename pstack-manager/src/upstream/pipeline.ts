import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { loadAdapter } from "../build/adapter.ts";
import { buildDist } from "../build/engine.ts";
import { renderMatrix } from "../build/matrix.ts";
import { copyTree, exists, readText, remove, writeFile } from "../lib/fs.ts";
import { transaction } from "../lib/tx.ts";
import { adapterDir, MANAGER_VERSION, type Paths } from "../paths.ts";
import { type Analysis, failedChecks, type SyncStatus, validationPassed } from "./analysis.ts";
import { blocking, detectConflicts } from "./conflicts.ts";
import { countChanges, diffLocks, isEmptyDiff, renderDiff } from "./diff.ts";
import { fetchUpstream } from "./fetch.ts";
import { readHistory, recordId, type SyncRecord } from "./history.ts";
import { analyzeImpact, countByAction, type Impact } from "./impact.ts";
import { computeLock, readLock, type UpstreamLock, verifyTree } from "./lock.ts";
import { planMigration } from "./migrate.ts";
import { renderReport, reportFileName, reportJson } from "./report.ts";
import { readUpstreamVocabulary } from "./vocabulary.ts";
import { type CheckResult, validateAll } from "../validate/index.ts";

export const DEFAULT_REPOSITORY = "https://github.com/cursor/plugins";
export const DEFAULT_PATH = "pstack";

export interface SyncOptions {
	readonly source?: string;
	readonly repository?: string;
	readonly ref?: string;
	readonly adapterId?: string;
	/** What started the run: `schedule`, `manual`, `local`. It goes into the history and the report. */
	readonly trigger?: string;
	/** Analyze and validate without writing anything. */
	readonly dryRun?: boolean;
	/** Write the core and the migration even when the migrated adapter fails validation. The status says so. */
	readonly prepare?: boolean;
	/** Run upstream's script tests (bun, node) as part of the compatibility checks. */
	readonly scripts?: boolean;
	readonly allowDowngrade?: boolean;
	readonly allowRewrite?: boolean;
	/** Propose an upstream commit again even though a reviewer rolled its sync back. */
	readonly includeRolledBack?: boolean;
	/** Write the Markdown report here whatever the outcome. */
	readonly reportOut?: string;
	readonly runUrl?: string;
	readonly now?: Date;
}

export interface SyncOutcome {
	readonly status: SyncStatus;
	readonly analysis: Analysis;
	readonly record: SyncRecord | null;
	/** Repository-relative path of the committed report. */
	readonly reportPath: string | null;
	readonly report: string;
}

const CHANGELOG_HEAD = "# Upstream changelog\n\nWritten by `pstack upstream sync`, newest first. Each entry lists what changed in `cursor/plugins/pstack` between two locked commits.\n";

const EMPTY_IMPACT: Impact = { affected: [], unitTerms: [], termsWithoutRow: [], wrappedGained: [], wrappedLost: [], references: [], staleValidations: [] };

/** Builds and validates the migrated adapter against the staged core in a scratch folder. The real adapter is not touched. */
function validateMigrated(paths: Paths, adapterId: string, stagedCore: string, lock: UpstreamLock, files: ReadonlyMap<string, string>, scripts: boolean): { validation: CheckResult[] | null; buildError: string | null } {
	const scratch = mkdtempSync(join(tmpdir(), "pstack-sync-"));
	try {
		const copy = join(scratch, `pstack-${adapterId}`);
		copyTree(adapterDir(paths, adapterId), copy);
		for (const [rel, content] of files) writeFile(join(copy, rel), content);
		const adapter = loadAdapter(copy);
		const distDir = join(scratch, "dist");
		buildDist({ coreDir: stagedCore, lock, adapter, outDir: distDir });
		return { validation: validateAll({ coreDir: stagedCore, distDir, adapter, lock, scripts }), buildError: null };
	} catch (error) {
		return { validation: null, buildError: (error as Error).message };
	} finally {
		remove(scratch);
	}
}

/**
 * Fetches upstream, works out what changed and what it affects, detects conflicts, prepares the Copilot
 * migration, validates it, and, unless it is a dry run or blocked, applies everything as one transaction.
 * It never overwrites the exact copy with local edits, never edits custom Copilot files, and writes nothing
 * when it stops.
 */
export function runSync(paths: Paths, options: SyncOptions = {}): SyncOutcome {
	const adapterId = options.adapterId || "copilot";
	const trigger = options.trigger || "local";
	const now = options.now || new Date();
	const date = now.toISOString().slice(0, 10);
	const fetched = fetchUpstream({ source: options.source, repository: options.repository || DEFAULT_REPOSITORY, ref: options.ref || "main", path: DEFAULT_PATH });
	let staging: string | null = null;
	try {
		const lock = computeLock(fetched, readUpstreamVocabulary(fetched.repoRoot), DEFAULT_PATH, `pstack-manager ${MANAGER_VERSION}`);
		const previous = exists(paths.lockFile) ? readLock(paths.lockFile) : null;
		const hasCore = previous !== null && exists(paths.coreUpstream);
		const diff = diffLocks(previous, lock, hasCore ? { oldRoot: paths.coreUpstream, newRoot: fetched.pstackDir } : undefined);
		const upstream = previous ? fetched.history({ commit: previous.commit, committedAt: previous.committedAt }) : { ancestor: null, commits: [] };
		const adapter = loadAdapter(adapterDir(paths, adapterId));
		const conflictInput = { paths, oldLock: previous, newLock: lock, diff, adapter, newRoot: fetched.pstackDir, ancestor: upstream.ancestor, allowDowngrade: options.allowDowngrade, allowRewrite: options.allowRewrite, includeRolledBack: options.includeRolledBack, rolledBack: readHistory(paths).entries.filter((entry) => entry.kind === "sync" && entry.status === "rolled-back").map((entry) => entry.to.commit) };

		const finish = (status: SyncStatus, analysis: Analysis, record: SyncRecord | null, reportPath: string | null, revision?: { before: number; after: number }): SyncOutcome => {
			const report = renderReport(analysis, { status, trigger, date, repository: lock.repository, reportPath: reportPath || undefined, adapterRevision: revision, runUrl: options.runUrl });
			if (options.reportOut) writeFile(options.reportOut, report);
			return { status, analysis, record, reportPath, report };
		};
		const bare = (conflicts: Analysis["conflicts"]): Analysis => ({ lock, previous, diff, upstream, impact: EMPTY_IMPACT, conflicts, migration: null, validation: null, buildError: null });

		if (previous && isEmptyDiff(diff)) {
			const conflicts = detectConflicts(conflictInput).filter((conflict) => conflict.kind === "core-modified");
			return finish(blocking(conflicts).length > 0 ? "conflict" : "unchanged", bare(conflicts), null, null);
		}

		const impact = previous && hasCore ? analyzeImpact({ diff, oldLock: previous, newLock: lock, oldRoot: paths.coreUpstream, newRoot: fetched.pstackDir, adapter }) : EMPTY_IMPACT;
		const conflicts = detectConflicts(conflictInput);
		if (blocking(conflicts).length > 0) return finish("conflict", { ...bare(conflicts), impact }, null, null);

		const migration = previous ? planMigration({ adapterDir: adapterDir(paths, adapterId), adapter, diff, impact, oldLock: previous, newLock: lock, newRoot: fetched.pstackDir }) : null;
		staging = join(paths.coreDir, `.staging-${process.pid}`);
		remove(staging);
		copyTree(fetched.pstackDir, staging);
		const copyProblems = verifyTree(staging, lock);
		if (copyProblems.length > 0) throw new Error(`staged copy differs from upstream:\n${copyProblems.join("\n")}`);

		const checked = validateMigrated(paths, adapterId, staging, lock, migration ? migration.files : new Map(), Boolean(options.scripts));
		const analysis: Analysis = { lock, previous, diff, upstream, impact, conflicts, migration, validation: checked.validation, buildError: checked.buildError };
		const passed = validationPassed(analysis);
		const revision = migration ? migration.revision : undefined;

		if (options.dryRun) return finish("dry-run", analysis, null, null, revision);
		if (!passed && !options.prepare) return finish("blocked", analysis, null, null, revision);

		const status: SyncStatus = passed ? "prepared" : "needs-adapter-work";
		const history = readHistory(paths);
		const id = recordId("sync", lock, history);
		const name = reportFileName(date, lock.version, lock.commit);
		const reportPath = posix.join("docs", "sync", "reports", `${name}.md`);
		const record: SyncRecord = {
			id,
			kind: "sync",
			at: now.toISOString(),
			trigger,
			status,
			from: previous ? { commit: previous.commit, version: previous.version, tree: previous.tree } : null,
			to: { commit: lock.commit, version: lock.version, tree: lock.tree },
			counts: countChanges(diff),
			adapter: { revisionBefore: revision ? revision.before : adapter.revision, revisionAfter: revision ? revision.after : adapter.revision, coreVersionsAfter: migration ? migration.coreVersions : adapter.coreVersions },
			impact: { affected: impact.affected.length, needsManual: countByAction(impact).manual },
			conflicts: conflicts.map((conflict) => conflict.kind),
			migration: migration ? migration.ops : [],
			validation: { passed, failed: failedChecks(analysis) },
			report: reportPath,
		};

		const tx = transaction();
		try {
			tx.swapDir(paths.coreUpstream, staging);
			staging = null;
			if (migration) for (const [rel, content] of migration.files) tx.writeFile(join(adapterDir(paths, adapterId), rel), content);
			tx.writeFile(paths.lockFile, `${JSON.stringify(lock, null, "\t")}\n`);
			const old = exists(paths.changelog) ? readText(paths.changelog).replace(CHANGELOG_HEAD, "") : "";
			tx.writeFile(paths.changelog, `${CHANGELOG_HEAD}\n${renderDiff(diff, date)}${old}`);
			if (migration) {
				const after = loadAdapter(adapterDir(paths, adapterId));
				tx.writeFile(join(adapterDir(paths, adapterId), "docs", "COMPATIBILITY.md"), renderMatrix(after, lock, `${lock.version}+${after.id}.${after.revision}`));
			}
			const outcome = finish(status, analysis, record, reportPath, revision);
			tx.writeFile(join(paths.repoRoot, reportPath), outcome.report);
			tx.writeFile(join(paths.repoRoot, "docs", "sync", "reports", `${name}.json`), `${JSON.stringify(reportJson(analysis, status, trigger), null, "\t")}\n`);
			tx.writeFile(paths.historyFile, `${JSON.stringify({ schema: 1, entries: [...history.entries, record] }, null, "\t")}\n`);
			tx.commit();
			return outcome;
		} catch (error) {
			tx.rollback();
			throw error;
		}
	} finally {
		if (staging) remove(staging);
		fetched.cleanup();
	}
}
