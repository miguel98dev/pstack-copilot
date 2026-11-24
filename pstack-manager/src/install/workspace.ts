import { readFileSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifest } from "../build/engine.ts";
import { copyFile, exists, readJson, remove, sha256, walkFiles, writeJson } from "../lib/fs.ts";

/**
 * A workspace install copies pstack into a repository's `.github/` folders so a team shares it through
 * source control, the way upstream's benny pack enables pstack in a repository. Copies, not links, because
 * the files are committed.
 */
export const WORKSPACE_LOCK = ".github/pstack-install.json";

interface WorkspaceLock {
	readonly schema: 1;
	readonly version: string;
	/** Repository-relative path to the sha256 pstack wrote there. */
	readonly files: Readonly<Record<string, string>>;
}

export interface WorkspaceResult {
	readonly version: string;
	readonly written: string[];
	readonly removed: string[];
	readonly kept: string[];
	readonly skipped: string[];
}

function plan(distDir: string): Map<string, string> {
	const layout = readManifest(distDir).install;
	const out = new Map<string, string>();
	for (const path of walkFiles(join(distDir, layout.skills))) out.set(`.github/skills/${path}`, join(distDir, layout.skills, path));
	for (const path of walkFiles(join(distDir, layout.agents))) out.set(`.github/agents/${path}`, join(distDir, layout.agents, path));
	for (const path of walkFiles(join(distDir, layout.instructions))) out.set(`.github/instructions/${path}`, join(distDir, layout.instructions, path));
	return out;
}

function readWorkspaceLock(repo: string): WorkspaceLock | null {
	const file = join(repo, WORKSPACE_LOCK);
	return exists(file) ? (readJson(file) as WorkspaceLock) : null;
}

function owned(repo: string, lock: WorkspaceLock | null, rel: string): boolean {
	if (!lock || !lock.files[rel]) return false;
	const abs = join(repo, rel);
	return !exists(abs) || sha256(readFileSync(abs)) === lock.files[rel];
}

function pruneEmptyDirs(repo: string, rel: string): void {
	let dir = dirname(join(repo, rel));
	const stop = join(repo, ".github");
	while (dir.startsWith(stop) && dir !== stop && exists(dir) && readdirSync(dir).length === 0) {
		rmdirSync(dir);
		dir = dirname(dir);
	}
}

export function installWorkspace(repo: string, distDir: string, force: boolean): WorkspaceResult {
	if (!exists(join(repo, ".git"))) throw new Error(`${repo} is not a git repository root`);
	const lock = readWorkspaceLock(repo);
	const wanted = plan(distDir);
	const result: WorkspaceResult = { version: readManifest(distDir).version, written: [], removed: [], kept: [], skipped: [] };
	const files: Record<string, string> = {};
	for (const [rel, src] of wanted) {
		const abs = join(repo, rel);
		if (exists(abs) && !owned(repo, lock, rel) && !force) {
			(lock && lock.files[rel] ? result.kept : result.skipped).push(rel);
			continue;
		}
		copyFile(src, abs);
		files[rel] = sha256(readFileSync(abs));
		result.written.push(rel);
	}
	if (lock) {
		for (const rel of Object.keys(lock.files)) {
			if (wanted.has(rel)) continue;
			if (owned(repo, lock, rel)) {
				remove(join(repo, rel));
				pruneEmptyDirs(repo, rel);
				result.removed.push(rel);
			} else result.kept.push(rel);
		}
	}
	writeJson(join(repo, WORKSPACE_LOCK), { schema: 1, version: result.version, files } satisfies WorkspaceLock);
	return result;
}

export function uninstallWorkspace(repo: string): WorkspaceResult {
	const lock = readWorkspaceLock(repo);
	if (!lock) throw new Error(`no ${WORKSPACE_LOCK} in ${repo}`);
	const result: WorkspaceResult = { version: lock.version, written: [], removed: [], kept: [], skipped: [] };
	for (const rel of Object.keys(lock.files)) {
		if (owned(repo, lock, rel)) {
			remove(join(repo, rel));
			pruneEmptyDirs(repo, rel);
			result.removed.push(rel);
		} else result.kept.push(rel);
	}
	remove(join(repo, WORKSPACE_LOCK));
	return result;
}
