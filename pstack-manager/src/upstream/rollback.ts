import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapter } from "../build/adapter.ts";
import { buildDist } from "../build/engine.ts";
import { remove, writeFile } from "../lib/fs.ts";
import { conflictedFiles, isRepoRoot, out, run } from "../lib/git.ts";
import { adapterDir, type Paths } from "../paths.ts";
import { problemsOf, validateAll } from "../validate/index.ts";
import { currentRecord, findRecord, readHistory, recordId, type SyncRecord } from "./history.ts";
import { readLock, verifyTree } from "./lock.ts";

export type RollbackStatus = "reverted" | "conflict" | "invalid" | "dry-run";

export interface RollbackOptions {
	/** A history id, an upstream commit prefix, or an upstream version. Default: the newest sync that was not rolled back. */
	readonly to?: string;
	readonly adapterId?: string;
	readonly dryRun?: boolean;
	/** Commit the revert instead of leaving it staged. */
	readonly commit?: boolean;
	readonly now?: Date;
	readonly trigger?: string;
}

export interface RollbackOutcome {
	readonly status: RollbackStatus;
	readonly target: SyncRecord;
	/** The monorepo commit the sync arrived in. */
	readonly syncCommit: string;
	readonly files: readonly string[];
	readonly message: string;
	readonly commit?: string;
}

function fail(message: string): never {
	throw new Error(message);
}

const LOCK_PATH = "pstack-core/UPSTREAM.lock.json";

function lockCommitAt(repo: string, revision: string): string | null {
	const shown = run(repo, ["show", `${revision}:${LOCK_PATH}`]);
	if (shown.code !== 0) return null;
	try {
		return (JSON.parse(shown.out) as { commit?: string }).commit || null;
	} catch {
		return null;
	}
}

/**
 * The commit a sync arrived in: the newest commit on this branch whose lock names the sync's upstream commit
 * and whose parent's lock names the commit it replaced. Matching the transition, not just the commit id,
 * keeps it right when the same upstream state was locked more than once.
 */
export function findSyncCommit(repo: string, record: SyncRecord): string {
	if (!record.from) fail("the first sync has no earlier state to return to");
	const log = run(repo, ["log", "--format=%H", "--", LOCK_PATH]);
	for (const sha of log.out.split("\n").filter((line) => line !== "")) {
		if (lockCommitAt(repo, sha) !== record.to.commit) continue;
		if (lockCommitAt(repo, `${sha}^1`) !== record.from.commit) continue;
		return sha;
	}
	return fail(`no commit on this branch moved the lock from ${record.from.commit.slice(0, 12)} to ${record.to.commit.slice(0, 12)}. If the sync was never committed, discard it with git restore.`);
}

function abort(repo: string): void {
	if (run(repo, ["revert", "--abort"]).code !== 0) run(repo, ["reset", "--hard", "HEAD"]);
}

/**
 * Undoes one synchronization by reverting the commit it arrived in, which restores pstack-core, the lock, the
 * mapping files, and the history entry together. A revert that collides with later Copilot work stops and
 * lists the files, so the rollback never overwrites custom functionality. Only the newest sync can be rolled
 * back, because older ones sit under the newer core.
 */
export function rollbackSync(paths: Paths, options: RollbackOptions = {}): RollbackOutcome {
	const repo = paths.repoRoot;
	if (!isRepoRoot(repo)) fail("rollback needs the pstack repository as a git checkout");
	const dirty = run(repo, ["status", "--porcelain", "--untracked-files=no"]).out;
	if (dirty !== "") fail(`the working tree has uncommitted changes. Commit or stash them first:\n${dirty}`);
	const history = readHistory(paths);
	const newest = currentRecord(history);
	const target = options.to ? findRecord(history, options.to) : newest;
	if (!target) fail(options.to ? `no sync matches ${options.to}` : "no synchronization to roll back");
	if (target.kind !== "sync") fail(`${target.id} is a rollback, not a sync`);
	if (target.status === "rolled-back") fail(`${target.id} was already rolled back`);
	if (!target.from) fail("the first sync created pstack-core. Roll it back by deleting the folder, not with a revert.");
	if (!newest || newest.id !== target.id) fail(`${target.id} is not the newest sync. Roll back ${newest ? newest.id : "the newer syncs"} first.`);

	const syncCommit = findSyncCommit(repo, target);
	if (options.dryRun) return { status: "dry-run", target, syncCommit, files: [], message: `would revert ${syncCommit.slice(0, 12)}, restoring upstream ${target.from.version} (${target.from.commit.slice(0, 12)})` };

	const parents = out(repo, "rev-list", "--parents", "-n", "1", syncCommit).split(" ").length - 1;
	const reverted = run(repo, ["revert", "--no-commit", ...(parents > 1 ? ["-m", "1"] : []), syncCommit]);
	if (reverted.code !== 0) {
		const files = conflictedFiles(repo);
		abort(repo);
		return { status: "conflict", target, syncCommit, files, message: `reverting ${syncCommit.slice(0, 12)} collides with later changes${files.length > 0 ? ` in ${files.length} file(s)` : ""}. Nothing was changed. Resolve it by hand with \`git revert ${syncCommit.slice(0, 12)}\`.\n${reverted.err}` };
	}

	const lock = readLock(paths.lockFile);
	const problems = verifyTree(paths.coreUpstream, lock);
	if (lock.commit !== target.from.commit) problems.push(`the lock names ${lock.commit.slice(0, 12)}, not the previous ${target.from.commit.slice(0, 12)}`);
	const scratch = mkdtempSync(join(tmpdir(), "pstack-rollback-"));
	try {
		const adapter = loadAdapter(adapterDir(paths, options.adapterId || "copilot"));
		const distDir = join(scratch, "dist");
		buildDist({ coreDir: paths.coreUpstream, lock, adapter, outDir: distDir });
		problems.push(...problemsOf(validateAll({ coreDir: paths.coreUpstream, distDir, adapter, lock, scripts: false })));
	} catch (error) {
		problems.push((error as Error).message);
	} finally {
		remove(scratch);
	}
	if (problems.length > 0) {
		abort(repo);
		return { status: "invalid", target, syncCommit, files: problems.slice(0, 20), message: "The reverted state does not pass validation, usually because Copilot-side changes made since the sync depend on it. Nothing was changed." };
	}

	run(repo, ["revert", "--quit"]);
	const now = options.now || new Date();
	const rollbackId = recordId("rollback", target.to, history);
	const marked = history.entries.map((entry) => (entry.id === target.id ? { ...entry, status: "rolled-back" as const, rolledBackBy: rollbackId } : entry));
	const record: SyncRecord = {
		id: rollbackId,
		kind: "rollback",
		at: now.toISOString(),
		trigger: options.trigger || "local",
		status: "rollback",
		from: { commit: target.to.commit, version: target.to.version, tree: target.to.tree },
		to: { commit: target.from.commit, version: target.from.version, tree: target.from.tree },
		counts: target.counts,
		adapter: { revisionBefore: target.adapter.revisionAfter, revisionAfter: target.adapter.revisionBefore, coreVersionsAfter: target.adapter.coreVersionsAfter },
		impact: target.impact,
		conflicts: [],
		migration: [],
		validation: { passed: true, failed: [] },
		report: null,
		note: `Reverted ${syncCommit}. Restores upstream ${target.from.version} at ${target.from.commit}.`,
	};
	writeFile(paths.historyFile, `${JSON.stringify({ schema: 1, entries: [...marked, record] }, null, "\t")}\n`);
	run(repo, ["add", "-A", "pstack-core", "pstack-copilot", "docs/sync"]);
	let commit: string | undefined;
	if (options.commit) {
		const made = run(repo, ["commit", "-q", "-m", `revert(sync): restore pstack ${target.from.version} (${target.from.commit.slice(0, 12)})`, "-m", `Rolls back the sync of upstream ${target.to.commit}, which arrived in ${syncCommit}.`]);
		if (made.code !== 0) fail(`git commit failed: ${made.err}`);
		commit = out(repo, "rev-parse", "HEAD");
	}
	return { status: "reverted", target, syncCommit, files: [], commit, message: `restored upstream ${target.from.version} (${target.from.commit.slice(0, 12)}) from ${syncCommit.slice(0, 12)}${commit ? `, committed as ${commit.slice(0, 12)}` : "; the changes are staged for you to review and commit"}` };
}
