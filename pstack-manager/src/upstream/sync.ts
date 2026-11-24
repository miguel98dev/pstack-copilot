import { join } from "node:path";
import { copyTree, exists, moveDir, readText, remove, writeFile, writeJson } from "../lib/fs.ts";
import { MANAGER_VERSION, type Paths } from "../paths.ts";
import { diffLocks, isEmptyDiff, renderDiff, type UpstreamDiff } from "./diff.ts";
import { fetchUpstream } from "./fetch.ts";
import { computeLock, readLock, type UpstreamLock, verifyTree } from "./lock.ts";
import { readUpstreamVocabulary } from "./vocabulary.ts";

export const DEFAULT_REPOSITORY = "https://github.com/cursor/plugins";
export const DEFAULT_PATH = "pstack";

export interface SyncOptions {
	readonly source?: string;
	readonly repository?: string;
	readonly ref?: string;
	/** Checks a staged core before it replaces the current one. Returns problems; any problem blocks the sync. */
	readonly gate?: (stagedCore: string, lock: UpstreamLock) => string[];
	/** Replace the core even when the gate reports problems. The problems are still returned. */
	readonly force?: boolean;
	readonly dryRun?: boolean;
}

export interface SyncResult {
	readonly lock: UpstreamLock;
	readonly diff: UpstreamDiff;
	readonly status: "unchanged" | "updated" | "blocked" | "dry-run";
	readonly problems: string[];
}

const CHANGELOG_HEAD =
	"# Upstream changelog\n\nWritten by `pstack upstream sync`, newest first. Each entry lists what changed in `cursor/plugins/pstack` between two locked commits.\n";

export function syncUpstream(paths: Paths, options: SyncOptions): SyncResult {
	const fetched = fetchUpstream({
		source: options.source,
		repository: options.repository || DEFAULT_REPOSITORY,
		ref: options.ref || "main",
		path: DEFAULT_PATH,
	});
	try {
		const lock = computeLock(fetched, readUpstreamVocabulary(fetched.repoRoot), DEFAULT_PATH, `pstack-manager ${MANAGER_VERSION}`);
		const previous = exists(paths.lockFile) ? readLock(paths.lockFile) : null;
		const diff = diffLocks(previous, lock);
		const intact = previous !== null && exists(paths.coreUpstream) && verifyTree(paths.coreUpstream, previous).length === 0;
		if (intact && isEmptyDiff(diff) && previous.commit === lock.commit) return { lock, diff, status: "unchanged", problems: [] };
		if (options.dryRun) return { lock, diff, status: "dry-run", problems: [] };

		const staging = join(paths.coreDir, `.staging-${process.pid}`);
		remove(staging);
		copyTree(fetched.pstackDir, staging);
		const copyProblems = verifyTree(staging, lock);
		if (copyProblems.length > 0) {
			remove(staging);
			throw new Error(`staged copy differs from upstream:\n${copyProblems.join("\n")}`);
		}
		const problems = options.gate ? options.gate(staging, lock) : [];
		if (problems.length > 0 && !options.force) {
			remove(staging);
			return { lock, diff, status: "blocked", problems };
		}
		remove(paths.coreUpstream);
		moveDir(staging, paths.coreUpstream);
		writeJson(paths.lockFile, lock);
		const old = exists(paths.changelog) ? readText(paths.changelog).replace(CHANGELOG_HEAD, "") : "";
		writeFile(paths.changelog, `${CHANGELOG_HEAD}\n${renderDiff(diff, new Date().toISOString().slice(0, 10))}${old}`);
		return { lock, diff, status: "updated", problems };
	} finally {
		fetched.cleanup();
	}
}
