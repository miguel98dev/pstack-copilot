import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readManifest } from "../build/engine.ts";
import { copyTree, ensureDir, exists, isSymlink, linkTarget, moveDir, readText, remove, replaceSymlink } from "../lib/fs.ts";
import type { Paths } from "../paths.ts";
import { type InstallState, readState, writeState } from "./state.ts";

export interface InstallLayout {
	readonly skills: string;
	readonly agents: string;
	readonly instructions: string;
}

export interface PlannedLink {
	readonly link: string;
	readonly target: string;
}

export function versionsDir(paths: Paths): string {
	return join(paths.pstackHome, "versions");
}

export function currentLink(paths: Paths): string {
	return join(paths.pstackHome, "current");
}

function list(dir: string): string[] {
	return exists(dir) ? readdirSync(dir).sort() : [];
}

/** Links that expose one installed version to Copilot: skills, custom agents, and personal instructions. */
export function planLinks(paths: Paths, versionDir: string, layout: InstallLayout): PlannedLink[] {
	const current = currentLink(paths);
	const plans: PlannedLink[] = [];
	for (const name of list(join(versionDir, layout.skills))) {
		plans.push({ link: join(paths.copilotHome, "skills", name), target: join(current, layout.skills, name) });
	}
	for (const name of list(join(versionDir, layout.agents))) {
		plans.push({ link: join(paths.copilotHome, "agents", name), target: join(current, layout.agents, name) });
	}
	for (const name of list(join(versionDir, layout.instructions))) {
		plans.push({ link: join(paths.copilotHome, "instructions", name), target: join(current, layout.instructions, name) });
	}
	return plans;
}

export function isOurs(paths: Paths, path: string): boolean {
	const target = linkTarget(path);
	return target !== null && (target === paths.pstackHome || target.startsWith(`${paths.pstackHome}/`));
}

export interface LinkResult {
	readonly links: string[];
	readonly skipped: string[];
	readonly backedUp: string[];
}

/**
 * Makes the Copilot home match the plan. pstack only creates, replaces, or deletes symlinks that point into
 * the pstack home. Anything else at a planned path, such as a skill folder the user copied there to edit, is
 * left alone and reported, unless `force` moves it to a timestamped backup first.
 */
export function syncLinks(paths: Paths, plans: readonly PlannedLink[], previous: readonly string[], force: boolean): LinkResult {
	const links: string[] = [];
	const skipped: string[] = [];
	const backedUp: string[] = [];
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (const { link, target } of plans) {
		const occupied = exists(link) || isSymlink(link);
		if (occupied && !isOurs(paths, link)) {
			if (!force) {
				skipped.push(link);
				continue;
			}
			const backup = join(paths.pstackHome, "backups", stamp, relative(paths.copilotHome, link));
			moveDir(link, backup);
			backedUp.push(backup);
		}
		replaceSymlink(target, link);
		links.push(link);
	}
	const planned = new Set(plans.map((plan) => plan.link));
	for (const old of previous) if (!planned.has(old) && isOurs(paths, old)) remove(old);
	return { links, skipped, backedUp };
}

/** Copies a build into the immutable versions folder. An existing version with other bytes is an error, not an overwrite. */
export function storeVersion(paths: Paths, distDir: string, force: boolean): { version: string; dir: string; reused: boolean } {
	const manifest = readManifest(distDir);
	const dir = join(versionsDir(paths), manifest.version);
	if (exists(dir)) {
		const same = exists(join(dir, "dist-manifest.json")) && readText(join(dir, "dist-manifest.json")) === readText(join(distDir, "dist-manifest.json"));
		if (same) return { version: manifest.version, dir, reused: true };
		if (!force) throw new Error(`version ${manifest.version} is already installed with different content. Raise the adapter revision, or pass --force to replace it.`);
		remove(dir);
	}
	const staging = `${dir}.staging-${process.pid}`;
	remove(staging);
	copyTree(distDir, staging);
	moveDir(staging, dir);
	return { version: manifest.version, dir, reused: false };
}

export function layoutOf(versionDir: string): InstallLayout {
	const manifest = readManifest(versionDir);
	if (!manifest.install) throw new Error(`${versionDir} has no install layout in its manifest`);
	return manifest.install;
}

export interface ActivateResult extends LinkResult {
	readonly state: InstallState;
}

/** Points `current` at a stored version and brings the Copilot links in line with it. */
export function activate(paths: Paths, version: string, force: boolean): ActivateResult {
	const dir = join(versionsDir(paths), version);
	if (!exists(dir)) throw new Error(`version ${version} is not installed in ${versionsDir(paths)}`);
	const state = readState(paths);
	ensureDir(paths.pstackHome);
	replaceSymlink(dir, currentLink(paths));
	const result = syncLinks(paths, planLinks(paths, dir, layoutOf(dir)), state.user ? state.user.links : [], force);
	const previous = state.active;
	const history = previous && previous !== version ? [...state.history.filter((v) => v !== previous && v !== version), previous] : state.history.filter((v) => v !== version);
	const next: InstallState = {
		...state,
		active: version,
		history,
		user: { version, installedAt: new Date().toISOString(), links: result.links, skipped: result.skipped },
	};
	writeState(paths, next);
	return { ...result, state: next };
}

export function deactivate(paths: Paths): string[] {
	const state = readState(paths);
	const removed: string[] = [];
	const candidates = new Set(state.user ? state.user.links : []);
	for (const sub of ["skills", "agents", "instructions"]) for (const name of list(join(paths.copilotHome, sub))) candidates.add(join(paths.copilotHome, sub, name));
	for (const path of candidates) {
		if (isOurs(paths, path)) {
			remove(path);
			removed.push(path);
		}
	}
	if (isSymlink(currentLink(paths))) remove(currentLink(paths));
	writeState(paths, { ...state, active: null, user: null, history: state.active ? [...state.history.filter((v) => v !== state.active), state.active] : state.history });
	return removed;
}

export function installedVersions(paths: Paths): string[] {
	return list(versionsDir(paths)).filter((name) => !name.includes(".staging-"));
}
