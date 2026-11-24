import { existsSync, readFileSync, statSync } from "node:fs";
import { compare } from "../lib/fs.ts";
import { join } from "node:path";
import type { UpstreamLock } from "./lock.ts";

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "mode-changed";

export interface FileChange {
	readonly kind: ChangeKind;
	readonly path: string;
	/** Old path of a rename. */
	readonly from?: string;
	/** 1 for a byte-identical move, below 1 for a moved and edited file. */
	readonly similarity?: number;
	readonly oldMode?: "644" | "755";
	readonly newMode?: "644" | "755";
}

export type ItemKind = "skill" | "playbook" | "agent" | "script" | "automation";

export interface ItemChange {
	readonly kind: ItemKind;
	readonly name: string;
	readonly change: "added" | "removed" | "modified" | "renamed";
	/** Old name of a renamed item. */
	readonly from?: string;
	readonly files: readonly string[];
}

export interface VocabularyChange {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly modified: readonly string[];
}

export interface UpstreamDiff {
	readonly fromVersion: string | null;
	readonly toVersion: string;
	readonly fromCommit: string | null;
	readonly toCommit: string;
	readonly changes: readonly FileChange[];
	readonly items: readonly ItemChange[];
	readonly vocabulary: VocabularyChange;
}

export interface RenameSources {
	/** Root of the tree the old lock describes. */
	readonly oldRoot: string;
	/** Root of the tree the new lock describes. */
	readonly newRoot: string;
}

const SKILL_FILE = /^skills\/([^/]+)\//;
const PLAYBOOK = /^skills\/poteto-mode\/playbooks\/([^/]+)\.md$/;
const AGENT = /^agents\/([^/]+)\.md$/;
const AUTOMATION = /^automations\/([^/]+)\//;
/** Below this, two files are different files that happen to share a few lines. */
export const RENAME_THRESHOLD = 0.6;
const MAX_TEXT_BYTES = 512 * 1024;

export function itemOf(path: string): { kind: ItemKind; name: string } | null {
	let match = PLAYBOOK.exec(path);
	if (match) return { kind: "playbook", name: match[1] };
	match = AGENT.exec(path);
	if (match) return { kind: "agent", name: match[1] };
	match = AUTOMATION.exec(path);
	if (match) return { kind: "automation", name: match[1] };
	match = SKILL_FILE.exec(path);
	if (match) return { kind: "skill", name: match[1] };
	return null;
}

export function itemId(kind: ItemKind, name: string): string {
	return `${kind}:${name}`;
}

function lineBag(text: string): Map<string, number> {
	const bag = new Map<string, number>();
	for (const line of text.split("\n")) {
		const key = line.trim();
		if (key !== "") bag.set(key, (bag.get(key) || 0) + 1);
	}
	return bag;
}

/** Multiset Jaccard similarity of two texts' non-empty lines. */
export function similarity(a: string, b: string): number {
	const bagA = lineBag(a);
	const bagB = lineBag(b);
	let common = 0;
	let total = 0;
	for (const [line, count] of bagA) {
		const other = bagB.get(line) || 0;
		common += Math.min(count, other);
		total += Math.max(count, other);
	}
	for (const [line, count] of bagB) if (!bagA.has(line)) total += count;
	return total === 0 ? 1 : common / total;
}

function sharedPrefix(a: string, b: string): number {
	const x = a.split("/");
	const y = b.split("/");
	let n = 0;
	while (n < x.length && n < y.length && x[n] === y[n]) n++;
	return n;
}

function readIfText(root: string, path: string): string | null {
	const abs = join(root, path);
	if (!existsSync(abs) || statSync(abs).size > MAX_TEXT_BYTES) return null;
	const bytes = readFileSync(abs);
	return bytes.includes(0) ? null : bytes.toString("utf8");
}

interface Pairing {
	readonly from: string;
	readonly to: string;
	readonly score: number;
}

/** Pairs deleted and added paths that are the same file moved: identical bytes first, then similar text. */
export function detectRenames(removed: readonly string[], added: readonly string[], from: UpstreamLock, to: UpstreamLock, sources?: RenameSources): Pairing[] {
	const pairs: Pairing[] = [];
	const freeOld = new Set(removed);
	const freeNew = new Set(added);
	const identical: Pairing[] = [];
	for (const oldPath of removed) {
		for (const newPath of added) {
			if (from.files[oldPath].sha256 === to.files[newPath].sha256) {
				identical.push({ from: oldPath, to: newPath, score: 1 + sharedPrefix(oldPath, newPath) / 100 });
			}
		}
	}
	identical.sort((a, b) => b.score - a.score || compare(a.from, b.from));
	for (const pair of identical) {
		if (!freeOld.has(pair.from) || !freeNew.has(pair.to)) continue;
		freeOld.delete(pair.from);
		freeNew.delete(pair.to);
		pairs.push({ ...pair, score: 1 });
	}
	if (!sources) return pairs;
	const similar: Pairing[] = [];
	const oldText = new Map<string, string>();
	const newText = new Map<string, string>();
	for (const path of freeOld) {
		const text = readIfText(sources.oldRoot, path);
		if (text !== null) oldText.set(path, text);
	}
	for (const path of freeNew) {
		const text = readIfText(sources.newRoot, path);
		if (text !== null) newText.set(path, text);
	}
	for (const [oldPath, a] of oldText) {
		for (const [newPath, b] of newText) {
			const score = similarity(a, b);
			if (score >= RENAME_THRESHOLD) similar.push({ from: oldPath, to: newPath, score });
		}
	}
	similar.sort((a, b) => b.score - a.score || compare(a.from, b.from));
	for (const pair of similar) {
		if (!freeOld.has(pair.from) || !freeNew.has(pair.to)) continue;
		freeOld.delete(pair.from);
		freeNew.delete(pair.to);
		pairs.push(pair);
	}
	return pairs;
}

function itemExists(lock: UpstreamLock | null, kind: ItemKind, name: string): boolean {
	if (!lock) return false;
	if (kind === "skill") return `skills/${name}/SKILL.md` in lock.files;
	if (kind === "playbook") return `skills/poteto-mode/playbooks/${name}.md` in lock.files;
	if (kind === "agent") return `agents/${name}.md` in lock.files;
	if (kind === "automation") return Object.keys(lock.files).some((path) => path.startsWith(`automations/${name}/`));
	return name in lock.files;
}

function scripts(lock: UpstreamLock | null): Set<string> {
	const out = new Set<string>();
	if (lock) for (const [path, file] of Object.entries(lock.files)) if (file.mode === "755" && !path.includes("/test/")) out.add(path);
	return out;
}

const NAMED_FILE = /SKILL\.md$|playbooks\/|^agents\//;

function itemChanges(from: UpstreamLock | null, to: UpstreamLock, changes: readonly FileChange[]): ItemChange[] {
	const touched = new Map<string, { kind: ItemKind; name: string; files: string[] }>();
	const touch = (path: string, kind: ItemKind, name: string) => {
		const id = itemId(kind, name);
		const entry = touched.get(id) || { kind, name, files: [] };
		entry.files.push(path);
		touched.set(id, entry);
	};
	for (const change of changes) {
		for (const path of change.from ? [change.from, change.path] : [change.path]) {
			const item = itemOf(path);
			if (item) touch(path, item.kind, item.name);
		}
	}
	const out: ItemChange[] = [];
	const renamed = new Set<string>();
	for (const change of changes) {
		if (change.kind !== "renamed" || !change.from) continue;
		const a = itemOf(change.from);
		const b = itemOf(change.path);
		if (a && b && a.kind === b.kind && a.name !== b.name && NAMED_FILE.test(change.path) && NAMED_FILE.test(change.from)) {
			out.push({ kind: b.kind, name: b.name, change: "renamed", from: a.name, files: [change.from, change.path] });
			renamed.add(itemId(a.kind, a.name));
			renamed.add(itemId(b.kind, b.name));
		}
	}
	for (const [id, entry] of touched) {
		if (renamed.has(id)) continue;
		const before = itemExists(from, entry.kind, entry.name);
		const after = itemExists(to, entry.kind, entry.name);
		if (!before && !after) continue;
		out.push({ kind: entry.kind, name: entry.name, change: before && after ? "modified" : after ? "added" : "removed", files: [...new Set(entry.files)].sort() });
	}
	const oldScripts = scripts(from);
	const newScripts = scripts(to);
	const moves = new Map(changes.filter((c) => c.kind === "renamed" && c.from).map((c) => [c.from as string, c.path]));
	const moveTargets = new Set(moves.values());
	for (const path of newScripts) {
		if (!oldScripts.has(path) && !moveTargets.has(path)) out.push({ kind: "script", name: path, change: "added", files: [path] });
		else if (oldScripts.has(path) && changes.some((c) => c.path === path)) out.push({ kind: "script", name: path, change: "modified", files: [path] });
	}
	for (const path of oldScripts) {
		const moved = moves.get(path);
		if (moved && newScripts.has(moved)) out.push({ kind: "script", name: moved, change: "renamed", from: path, files: [path, moved] });
		else if (!newScripts.has(path) && !moved) out.push({ kind: "script", name: path, change: "removed", files: [path] });
	}
	return out.sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name));
}

function vocabularyChange(from: UpstreamLock | null, to: UpstreamLock): VocabularyChange {
	const before = new Map((from ? from.vocabulary.terms : []).map((term) => [term.key, `${term.pattern}/${term.flags}`]));
	const after = new Map(to.vocabulary.terms.map((term) => [term.key, `${term.pattern}/${term.flags}`]));
	return {
		added: [...after.keys()].filter((key) => !before.has(key)).sort(),
		removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
		modified: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
	};
}

/** Compares two locks. With `sources`, deleted and added files that are the same file moved and edited are reported as renames. */
export function diffLocks(from: UpstreamLock | null, to: UpstreamLock, sources?: RenameSources): UpstreamDiff {
	const before = from ? from.files : {};
	const after = to.files;
	const removed = Object.keys(before).filter((path) => !(path in after)).sort();
	const added = Object.keys(after).filter((path) => !(path in before)).sort();
	const pairs = from ? detectRenames(removed, added, from, to, sources) : [];
	const movedFrom = new Set(pairs.map((pair) => pair.from));
	const movedTo = new Set(pairs.map((pair) => pair.to));
	const changes: FileChange[] = [];
	for (const path of added) if (!movedTo.has(path)) changes.push({ kind: "added", path, newMode: after[path].mode });
	for (const path of removed) if (!movedFrom.has(path)) changes.push({ kind: "deleted", path, oldMode: before[path].mode });
	for (const pair of pairs) changes.push({ kind: "renamed", path: pair.to, from: pair.from, similarity: Math.round(pair.score * 100) / 100, oldMode: before[pair.from].mode, newMode: after[pair.to].mode });
	for (const path of Object.keys(after).sort()) {
		if (!(path in before)) continue;
		if (before[path].sha256 !== after[path].sha256) changes.push({ kind: "modified", path, oldMode: before[path].mode, newMode: after[path].mode });
		else if (before[path].mode !== after[path].mode) changes.push({ kind: "mode-changed", path, oldMode: before[path].mode, newMode: after[path].mode });
	}
	changes.sort((a, b) => compare(a.path, b.path) || compare(a.kind, b.kind));
	return {
		fromVersion: from ? from.version : null,
		toVersion: to.version,
		fromCommit: from ? from.commit : null,
		toCommit: to.commit,
		changes,
		items: itemChanges(from, to, changes),
		vocabulary: vocabularyChange(from, to),
	};
}

export function isEmptyDiff(diff: UpstreamDiff): boolean {
	return diff.changes.length === 0 && diff.vocabulary.added.length + diff.vocabulary.removed.length + diff.vocabulary.modified.length === 0;
}

export function countChanges(diff: UpstreamDiff): Record<ChangeKind, number> {
	const counts: Record<ChangeKind, number> = { added: 0, modified: 0, deleted: 0, renamed: 0, "mode-changed": 0 };
	for (const change of diff.changes) counts[change.kind]++;
	return counts;
}

const LABEL: Record<ItemChange["change"], string> = { added: "added", removed: "removed", modified: "modified", renamed: "renamed" };

/** The short entry that goes into pstack-core/CHANGELOG.upstream.md. */
export function renderDiff(diff: UpstreamDiff, date: string): string {
	const counts = countChanges(diff);
	const from = diff.fromVersion ? `${diff.fromVersion} (\`${(diff.fromCommit as string).slice(0, 12)}\`)` : "nothing";
	let out = `## ${diff.toVersion} (\`${diff.toCommit.slice(0, 12)}\`), synced ${date}\n\nFrom ${from}. ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.renamed} renamed, ${counts["mode-changed"]} mode changes.\n`;
	for (const kind of ["skill", "playbook", "agent", "script", "automation"] as const) {
		const items = diff.items.filter((item) => item.kind === kind && item.change !== "modified");
		if (items.length === 0) continue;
		out += `\n### ${kind[0].toUpperCase()}${kind.slice(1)}s\n\n${items.map((item) => `- \`${item.name}\` ${LABEL[item.change]}${item.from ? ` (was \`${item.from}\`)` : ""}`).join("\n")}\n`;
	}
	const v = diff.vocabulary;
	if (v.added.length + v.removed.length + v.modified.length > 0) {
		out += `\n### Cursor vocabulary\n\n${[...v.added.map((k) => `- added ${k}`), ...v.removed.map((k) => `- removed ${k}`), ...v.modified.map((k) => `- changed ${k}`)].join("\n")}\n`;
	}
	return out;
}
