import { join } from "node:path";
import type { Adapter } from "../build/adapter.ts";
import { pathMapper } from "../build/engine.ts";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { exists, readText, walkFiles } from "../lib/fs.ts";
import { dirtyPaths, isRepoRoot } from "../lib/git.ts";
import type { Paths } from "../paths.ts";
import type { UpstreamDiff } from "./diff.ts";
import type { UpstreamLock } from "./lock.ts";
import { verifyTree } from "./lock.ts";

export type ConflictKind = "core-modified" | "uncommitted-changes" | "history-diverged" | "history-unknown" | "version-downgrade" | "same-version-new-content" | "overlay-collision" | "frontmatter-collision" | "unmapped-path" | "previously-rolled-back";

export interface Conflict {
	readonly kind: ConflictKind;
	/** Blocking conflicts stop the sync before anything is written. */
	readonly severity: "blocking" | "warning";
	readonly message: string;
	readonly files: readonly string[];
	/** The flag that overrides it, when one exists. */
	readonly override?: string;
}

export interface ConflictInput {
	readonly paths: Paths;
	readonly oldLock: UpstreamLock | null;
	readonly newLock: UpstreamLock;
	readonly diff: UpstreamDiff;
	readonly adapter: Adapter;
	readonly newRoot: string;
	/** Whether the locked commit is an ancestor of the new one: null when the history could not be read. */
	readonly ancestor: boolean | null;
	readonly allowDowngrade?: boolean;
	readonly allowRewrite?: boolean;
	/** Upstream commits whose sync was rolled back, so the next run does not propose them again. */
	readonly rolledBack?: readonly string[];
	readonly includeRolledBack?: boolean;
}

/** Compares dotted versions numerically, ignoring any `+build` suffix. Returns negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
	const parts = (version: string) => version.split("+")[0].split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (x[i] || 0) - (y[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Finds what would make the sync overwrite or shadow something it must not touch. The sync never resolves
 * these by itself: it stops, or reports them, and leaves every file as it was.
 */
export function detectConflicts(input: ConflictInput): Conflict[] {
	const { paths, oldLock, newLock, diff, adapter, newRoot } = input;
	const conflicts: Conflict[] = [];

	if (oldLock && exists(paths.coreUpstream)) {
		const problems = verifyTree(paths.coreUpstream, oldLock);
		if (problems.length > 0) {
			conflicts.push({ kind: "core-modified", severity: "blocking", message: "pstack-core/upstream does not match UPSTREAM.lock.json. Someone edited the exact copy, and the sync will not overwrite local work. Restore it with git, or keep the edit out of pstack-core.", files: problems.slice(0, 20) });
		}
	}

	if (isRepoRoot(paths.repoRoot)) {
		const dirty = dirtyPaths(paths.repoRoot, ["pstack-core", "pstack-copilot", "docs/sync"]);
		if (dirty.length > 0) {
			conflicts.push({ kind: "uncommitted-changes", severity: "blocking", message: "pstack-core, pstack-copilot, or docs/sync have uncommitted changes. The sync rewrites mapping files and would mix its changes with yours. Commit or stash them first.", files: dirty.slice(0, 20) });
		}
	}

	if (oldLock) {
		if (input.ancestor === false) {
			conflicts.push({ kind: "history-diverged", severity: input.allowRewrite ? "warning" : "blocking", message: `The locked commit ${oldLock.commit.slice(0, 12)} is not an ancestor of ${newLock.commit.slice(0, 12)}. Upstream rewrote history, or the ref points at another line of development.`, files: [], override: "--allow-rewrite" });
		} else if (input.ancestor === null) {
			conflicts.push({ kind: "history-unknown", severity: "warning", message: `Could not read upstream history back to ${oldLock.commit.slice(0, 12)}, so a rewritten history would go unnoticed.`, files: [] });
		}
		const order = compareVersions(newLock.version, oldLock.version);
		if (order < 0) {
			conflicts.push({ kind: "version-downgrade", severity: input.allowDowngrade ? "warning" : "blocking", message: `Upstream version went from ${oldLock.version} to ${newLock.version}.`, files: [], override: "--allow-downgrade" });
		} else if (order === 0 && oldLock.commit !== newLock.commit && diff.changes.length > 0) {
			conflicts.push({ kind: "same-version-new-content", severity: "warning", message: `Upstream changed content without a version bump (${newLock.version}). The adapter revision goes up so the installed version stays immutable.`, files: [] });
		}
	}

	if (input.rolledBack && input.rolledBack.includes(newLock.commit)) {
		conflicts.push({ kind: "previously-rolled-back", severity: input.includeRolledBack ? "warning" : "blocking", message: `A reviewer rolled back the sync of ${newLock.commit.slice(0, 12)}. It is not proposed again until upstream moves on.`, files: [], override: "--include-rolled-back" });
	}

	const mapper = pathMapper(adapter);
	const overlays = new Set(exists(adapter.overlays) ? walkFiles(adapter.overlays) : []);
	const copies = new Set(adapter.copies.map((copy) => copy.to));
	const arriving = diff.changes.filter((change) => change.kind === "added" || change.kind === "renamed").map((change) => change.path);
	const collisions: string[] = [];
	const unmapped: string[] = [];
	for (const path of arriving) {
		const target = mapper.map(path);
		if (target === null) {
			if (!mapper.isExcluded(path)) unmapped.push(path);
			continue;
		}
		if (overlays.has(target) || copies.has(target)) collisions.push(`${path} -> ${target}`);
	}
	if (collisions.length > 0) {
		conflicts.push({ kind: "overlay-collision", severity: "blocking", message: "New upstream files would land on paths that custom Copilot files already provide. The build would refuse them, and the sync will not replace or shadow the Copilot version. Rename the overlay, or map the upstream file elsewhere in adapter.json.", files: collisions });
	}
	if (unmapped.length > 0) {
		conflicts.push({ kind: "unmapped-path", severity: "warning", message: "New upstream files match no relocate or exclude rule in adapter.json, so the build cannot ship them. Add a rule to adapter.json.", files: unmapped.slice(0, 20) });
	}

	const hints = new Set(Object.keys(adapter.skillFrontmatter.skills));
	const colliding: string[] = [];
	for (const change of diff.changes) {
		const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(change.path);
		if (!match || (change.kind !== "added" && change.kind !== "modified" && change.kind !== "renamed") || !exists(join(newRoot, change.path))) continue;
		const keys = parseFrontmatter(readText(join(newRoot, change.path))).entries.map((entry) => entry.key);
		const mapped = adapter.skillFrontmatter.allowedKeys.filter((key) => keys.includes(key));
		if (mapped.length > 0 && hints.has(match[1])) colliding.push(`${change.path} now has ${mapped.join(", ")}`);
	}
	if (colliding.length > 0) {
		conflicts.push({ kind: "frontmatter-collision", severity: "warning", message: "Upstream now sets a frontmatter key that mappings/skills.json adds for the same skill. The sync drops the Copilot hint so upstream's value wins.", files: colliding });
	}
	return conflicts;
}

export function blocking(conflicts: readonly Conflict[]): Conflict[] {
	return conflicts.filter((conflict) => conflict.severity === "blocking");
}
