import type { UpstreamLock } from "./lock.ts";

export interface UpstreamDiff {
	readonly fromVersion: string | null;
	readonly toVersion: string;
	readonly fromCommit: string | null;
	readonly toCommit: string;
	readonly added: string[];
	readonly removed: string[];
	readonly changed: string[];
	readonly skillsAdded: string[];
	readonly skillsRemoved: string[];
	readonly playbooksAdded: string[];
	readonly playbooksRemoved: string[];
	readonly agentsAdded: string[];
	readonly agentsRemoved: string[];
	readonly termsAdded: string[];
	readonly termsRemoved: string[];
}

const SKILL = /^skills\/([^/]+)\/SKILL\.md$/;
const PLAYBOOK = /^skills\/poteto-mode\/playbooks\/([^/]+)\.md$/;
const AGENT = /^agents\/([^/]+)\.md$/;

function names(files: readonly string[], pattern: RegExp): Set<string> {
	const out = new Set<string>();
	for (const file of files) {
		const match = pattern.exec(file);
		if (match) out.add(match[1]);
	}
	return out;
}

function minus(a: Set<string>, b: Set<string>): string[] {
	return [...a].filter((item) => !b.has(item)).sort();
}

export function diffLocks(from: UpstreamLock | null, to: UpstreamLock): UpstreamDiff {
	const before = from ? Object.keys(from.files) : [];
	const after = Object.keys(to.files);
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	const changed = after.filter((path) => from && beforeSet.has(path) && from.files[path].sha256 !== to.files[path].sha256).sort();
	const terms = (lock: UpstreamLock | null) => new Set(lock ? lock.vocabulary.terms.map((term) => term.key) : []);
	return {
		fromVersion: from ? from.version : null,
		toVersion: to.version,
		fromCommit: from ? from.commit : null,
		toCommit: to.commit,
		added: minus(afterSet, beforeSet),
		removed: minus(beforeSet, afterSet),
		changed,
		skillsAdded: minus(names(after, SKILL), names(before, SKILL)),
		skillsRemoved: minus(names(before, SKILL), names(after, SKILL)),
		playbooksAdded: minus(names(after, PLAYBOOK), names(before, PLAYBOOK)),
		playbooksRemoved: minus(names(before, PLAYBOOK), names(after, PLAYBOOK)),
		agentsAdded: minus(names(after, AGENT), names(before, AGENT)),
		agentsRemoved: minus(names(before, AGENT), names(after, AGENT)),
		termsAdded: minus(terms(to), terms(from)),
		termsRemoved: minus(terms(from), terms(to)),
	};
}

export function isEmptyDiff(diff: UpstreamDiff): boolean {
	return diff.added.length + diff.removed.length + diff.changed.length === 0;
}

export function renderDiff(diff: UpstreamDiff, date: string): string {
	const list = (title: string, items: readonly string[]) =>
		items.length === 0 ? "" : `\n### ${title} (${items.length})\n\n${items.map((item) => `- \`${item}\``).join("\n")}\n`;
	const from = diff.fromVersion ? `${diff.fromVersion} (\`${(diff.fromCommit as string).slice(0, 12)}\`)` : "nothing";
	return (
		`## ${diff.toVersion} (\`${diff.toCommit.slice(0, 12)}\`), synced ${date}\n\nFrom ${from}.\n` +
		list("Skills added", diff.skillsAdded) +
		list("Skills removed", diff.skillsRemoved) +
		list("Playbooks added", diff.playbooksAdded) +
		list("Playbooks removed", diff.playbooksRemoved) +
		list("Agents added", diff.agentsAdded) +
		list("Agents removed", diff.agentsRemoved) +
		list("Cursor vocabulary added", diff.termsAdded) +
		list("Cursor vocabulary removed", diff.termsRemoved) +
		list("Files added", diff.added) +
		list("Files removed", diff.removed) +
		list("Files changed", diff.changed)
	);
}
