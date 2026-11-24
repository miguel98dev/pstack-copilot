import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter } from "../build/adapter.ts";
import { classify } from "../build/classify.ts";
import { matchesGlob, pathMapper } from "../build/engine.ts";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { exists, readText, walkFiles } from "../lib/fs.ts";
import { type ItemChange, itemId, type UpstreamDiff } from "./diff.ts";
import type { UpstreamLock } from "./lock.ts";

/**
 * How an affected adaptation gets handled.
 * - automatic: the build derives it again from the new core (relocated paths, rewritten links, adapter lines).
 * - migrated: the sync prepares the change in the mapping data. A reviewer checks it.
 * - review: the Copilot side may still be right, but upstream changed what it depends on. A human reads the change.
 * - manual: the adaptation is custom Copilot work that the sync never edits. A human has to change it.
 */
export type Action = "automatic" | "migrated" | "review" | "manual";

export interface Affected {
	readonly action: Action;
	/** What is affected: a feature id, a file in the adapter, or a mapping. */
	readonly adaptation: string;
	readonly because: string;
	readonly upstream: readonly string[];
}

export interface Reference {
	/** File in the adapter folder that mentions the changed upstream path or name. */
	readonly file: string;
	readonly mentions: string;
	readonly change: "deleted" | "renamed";
}

export interface UnitTermChange {
	readonly unit: string;
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

export interface Impact {
	readonly affected: readonly Affected[];
	readonly unitTerms: readonly UnitTermChange[];
	/** Cursor terms in use after the sync that the adapter skill has no row for. */
	readonly termsWithoutRow: readonly string[];
	readonly wrappedGained: readonly string[];
	readonly wrappedLost: readonly string[];
	readonly references: readonly Reference[];
	/** Feature ids that were validated in VS Code and whose upstream item changed. */
	readonly staleValidations: readonly string[];
}

export interface ImpactInput {
	readonly diff: UpstreamDiff;
	readonly oldLock: UpstreamLock | null;
	readonly newLock: UpstreamLock;
	readonly oldRoot: string | null;
	readonly newRoot: string;
	readonly adapter: Adapter;
}

const SKILL_UNIT = /^skills\/([^/]+)\//;
const AGENT_UNIT = /^agents\/([^/]+)\.md$/;

type Keys = Map<string, Set<string>>;

/** Cursor terms each skill folder and agent file use, by upstream's own classifier. */
export function unitTerms(root: string, lock: UpstreamLock, extra: Adapter["extraTerms"]): Keys {
	const files = Object.keys(lock.files);
	const skills = [...new Set(files.map((file) => SKILL_UNIT.exec(file)).filter((m): m is RegExpExecArray => m !== null && `skills/${m[1]}/SKILL.md` in lock.files).map((m) => m[1]))].sort();
	const vocabulary = { terms: [...lock.vocabulary.terms, ...extra], routeKey: lock.vocabulary.routeKey };
	const out: Keys = new Map();
	for (const skill of skills) {
		const texts = files.filter((file) => file.startsWith(`skills/${skill}/`) && file.endsWith(".md")).map((file) => readText(join(root, file)));
		out.set(`skill:${skill}`, classify(texts, vocabulary, skills.filter((name) => name !== skill)).keys);
	}
	for (const file of files) {
		const match = AGENT_UNIT.exec(file);
		if (match) out.set(`agent:${match[1]}`, classify([readText(join(root, file))], vocabulary, skills).keys);
	}
	return out;
}

function sameKeys(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
	const x = a || new Set<string>();
	const y = b || new Set<string>();
	return x.size === y.size && [...x].every((key) => y.has(key));
}

function adapterTextFiles(adapter: Adapter): { file: string; text: string }[] {
	const roots: [string, string][] = [
		[adapter.overlays, "overlays"],
		[join(adapter.dir, "mappings"), "mappings"],
	];
	const out: { file: string; text: string }[] = [];
	for (const [root, label] of roots) {
		if (!exists(root)) continue;
		for (const path of walkFiles(root)) if (/\.(md|json)$/.test(path)) out.push({ file: `${label}/${path}`, text: readFileSync(join(root, path), "utf8") });
	}
	return out;
}

function mentionsOf(path: string): string[] {
	const parts = path.split("/");
	const tail = parts.slice(-2).join("/");
	return [...new Set([path, tail])].filter((candidate) => candidate.includes("/") && basename(candidate) !== "");
}

function featureStatus(adapter: Adapter, id: string) {
	return adapter.features.find((feature) => feature.id === id);
}

function itemFeatureId(item: ItemChange, which: "new" | "old"): string {
	const name = which === "old" && item.from ? item.from : item.name;
	return itemId(item.kind, name);
}

function agentKeyProblem(newRoot: string, name: string, adapter: Adapter): string | null {
	const rule = adapter.agents.rules[name];
	const file = join(newRoot, `agents/${name}.md`);
	if (!rule || !exists(file)) return null;
	const known = new Set(["name", "description", ...rule.drop]);
	const unknown = parseFrontmatter(readText(file)).entries.map((entry) => entry.key).filter((key) => !known.has(key));
	return unknown.length === 0 ? null : `frontmatter key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} not covered by the agent rule`;
}

/** Works out which Copilot adaptations a diff touches and how each one gets handled. */
export function analyzeImpact(input: ImpactInput): Impact {
	const { diff, oldLock, newLock, oldRoot, newRoot, adapter } = input;
	const affected: Affected[] = [];
	const add = (item: Affected) => affected.push(item);
	const mapper = pathMapper(adapter);

	const before = oldLock && oldRoot ? unitTerms(oldRoot, oldLock, adapter.extraTerms) : new Map<string, Set<string>>();
	const after = unitTerms(newRoot, newLock, adapter.extraTerms);
	const unitChanges: UnitTermChange[] = [];
	const wrappedGained: string[] = [];
	const wrappedLost: string[] = [];
	for (const [unit, keys] of after) {
		const old = before.get(unit);
		if (!sameKeys(old, keys)) {
			unitChanges.push({ unit, added: [...keys].filter((key) => !(old && old.has(key))).sort(), removed: old ? [...old].filter((key) => !keys.has(key)).sort() : [] });
		}
		if (keys.size > 0 && !(old && old.size > 0)) wrappedGained.push(unit);
		if (keys.size === 0 && old && old.size > 0) wrappedLost.push(unit);
	}
	for (const unit of wrappedGained) add({ action: "automatic", adaptation: `adapter line on ${unit}`, because: "The unit now uses a Cursor name, so the build adds the adapter line.", upstream: [] });
	for (const unit of wrappedLost) add({ action: "automatic", adaptation: `adapter line on ${unit}`, because: "The unit no longer uses a Cursor name, so the build stops adding the adapter line.", upstream: [] });

	const adapterSkill = join(adapter.overlays, adapter.adapterSkill);
	const rows = exists(adapterSkill) ? readText(adapterSkill) : "";
	const used = new Set<string>();
	for (const keys of after.values()) for (const key of keys) used.add(key);
	for (const term of adapter.extraTerms) used.add(term.key);
	for (const term of newLock.vocabulary.terms) used.add(term.key);
	const termsWithoutRow = [...used].filter((key) => !rows.includes(key)).sort();
	for (const key of termsWithoutRow) {
		const users = [...after].filter(([, keys]) => keys.has(key)).map(([unit]) => unit);
		add({ action: "manual", adaptation: adapter.adapterSkill, because: `Cursor name ${key} has no row in the adapter skill${users.length > 0 ? `; used by ${users.slice(0, 6).join(", ")}${users.length > 6 ? ` and ${users.length - 6} more` : ""}` : ""}.`, upstream: [] });
	}

	const staleValidations: string[] = [];
	for (const item of diff.items) {
		const files = item.files;
		if (item.change === "added") {
			add({ action: "migrated", adaptation: `features.json ${itemFeatureId(item, "new")}`, because: `New upstream ${item.kind} ${item.name}. The sync adds a pending entry for review.`, upstream: files });
			if (item.kind === "agent") add({ action: "migrated", adaptation: `agents.json ${item.name}`, because: "New upstream agent. The sync derives a rule from its frontmatter.", upstream: files });
		} else if (item.change === "removed") {
			if (featureStatus(adapter, itemFeatureId(item, "new"))) add({ action: "migrated", adaptation: `features.json ${itemFeatureId(item, "new")}`, because: `Upstream ${item.kind} ${item.name} was deleted. The sync removes its entry.`, upstream: files });
			if (item.kind === "agent" && adapter.agents.rules[item.name]) add({ action: "migrated", adaptation: `agents.json ${item.name}`, because: "Upstream agent was deleted. The sync removes its rule.", upstream: files });
			if (item.kind === "skill" && adapter.skillFrontmatter.skills[item.name]) add({ action: "migrated", adaptation: `skills.json ${item.name}`, because: "Upstream skill was deleted. The sync removes its argument-hint.", upstream: files });
		} else if (item.change === "renamed") {
			if (featureStatus(adapter, itemFeatureId(item, "old"))) add({ action: "migrated", adaptation: `features.json ${itemFeatureId(item, "old")} -> ${itemFeatureId(item, "new")}`, because: `Upstream ${item.kind} ${item.from} is now ${item.name}. The sync renames the entry and keeps its content.`, upstream: files });
			if (item.kind === "agent" && item.from && adapter.agents.rules[item.from]) add({ action: "migrated", adaptation: `agents.json ${item.from} -> ${item.name}`, because: "Upstream agent was renamed. The sync renames its rule.", upstream: files });
			if (item.kind === "skill" && item.from && adapter.skillFrontmatter.skills[item.from]) add({ action: "migrated", adaptation: `skills.json ${item.from} -> ${item.name}`, because: "Upstream skill was renamed. The sync renames its argument-hint.", upstream: files });
		} else {
			const feature = featureStatus(adapter, itemFeatureId(item, "new"));
			if (feature && feature.validation === "vscode-validated") {
				staleValidations.push(feature.id);
				add({ action: "migrated", adaptation: `features.json ${feature.id}`, because: `Upstream changed ${item.kind} ${item.name}, which a VS Code run validated. The sync marks the validation stale.`, upstream: files });
			} else if (feature && feature.status !== "native" && feature.status !== "pending" && feature.status !== "excluded") {
				add({ action: "review", adaptation: `features.json ${feature.id}`, because: `Upstream changed ${item.kind} ${item.name}, which has a Copilot adaptation (${feature.status}). Check that "${feature.copilot.slice(0, 80)}" still holds.`, upstream: files });
			}
			if (item.kind === "agent") {
				const problem = agentKeyProblem(newRoot, item.name, adapter);
				if (problem) add({ action: "manual", adaptation: `agents.json ${item.name}`, because: `Upstream agent ${item.name} has ${problem}; the build refuses to render it.`, upstream: files });
				else if (adapter.agents.rules[item.name]) add({ action: "review", adaptation: `agents.json ${item.name}`, because: "Upstream agent changed; its body and kept frontmatter are copied again, and its mapping rule is unchanged.", upstream: files });
			}
		}
	}
	const v = diff.vocabulary;
	for (const key of v.added) add({ action: "migrated", adaptation: `features.json term:${key}`, because: "New Cursor term in upstream's vocabulary. The sync adds a pending entry.", upstream: [] });
	for (const key of v.removed) if (adapter.features.some((feature) => feature.id === `term:${key}`)) add({ action: "migrated", adaptation: `features.json term:${key}`, because: "Upstream dropped this Cursor term. The sync removes its entry; the adapter skill row stays until a reviewer removes it.", upstream: [] });
	for (const key of v.modified) add({ action: "review", adaptation: `features.json term:${key}`, because: "Upstream changed the pattern that detects this Cursor term, so more or fewer files may need the adapter line.", upstream: [] });

	const references: Reference[] = [];
	const files = adapterTextFiles(adapter);
	const gone: { path: string; change: "deleted" | "renamed" }[] = [];
	for (const change of diff.changes) {
		if (change.kind === "deleted") gone.push({ path: change.path, change: "deleted" });
		else if (change.kind === "renamed" && change.from) gone.push({ path: change.from, change: "renamed" });
	}
	for (const { path, change } of gone) {
		for (const mention of mentionsOf(path)) {
			for (const { file, text } of files) {
				if (file.startsWith("mappings/features.json") || file.startsWith("mappings/agents.json") || file.startsWith("mappings/skills.json")) continue;
				if (text.includes(mention) && !references.some((ref) => ref.file === file && ref.mentions === mention)) references.push({ file, mentions: mention, change });
			}
		}
	}
	for (const ref of references) add({ action: "manual", adaptation: `${ref.file}`, because: `Mentions ${ref.mentions}, which upstream ${ref.change === "deleted" ? "deleted" : "renamed"}. The sync never edits overlays or hand-written mappings.`, upstream: [ref.mentions] });

	const touched = diff.changes.flatMap((change) => (change.from ? [change.path, change.from] : [change.path]));
	for (const watch of adapter.watch) {
		const hits = touched.filter((path) => watch.upstream.some((pattern) => matchesGlob(path, pattern)));
		if (hits.length === 0) continue;
		const removed = hits.some((path) => diff.changes.some((change) => change.path === path && change.kind === "deleted") || diff.changes.some((change) => change.from === path));
		for (const target of watch.adaptation) add({ action: removed ? "manual" : "review", adaptation: target, because: `${watch.why} Changed upstream: ${[...new Set(hits)].slice(0, 5).join(", ")}${hits.length > 5 ? `, and ${hits.length - 5} more` : ""}.`, upstream: [...new Set(hits)] });
	}

	for (const change of diff.changes) {
		const target = change.kind === "deleted" ? null : mapper.map(change.path);
		if (target !== null && target !== change.path) add({ action: "automatic", adaptation: `build path ${target}`, because: "Relocated by the adapter's relocate rules.", upstream: [change.path] });
	}

	const seen = new Set<string>();
	const unique = affected.filter((item) => {
		const key = `${item.action}|${item.adaptation}|${item.because}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const consolidated = unique.filter((item) => !(item.action === "automatic" && item.adaptation.startsWith("build path ")));
	const relocated = unique.filter((item) => item.action === "automatic" && item.adaptation.startsWith("build path "));
	if (relocated.length > 0) consolidated.push({ action: "automatic", adaptation: `${relocated.length} relocated build paths`, because: "Changed upstream files that the adapter relocates (docs, README, LICENSE). The build rewrites their links again.", upstream: relocated.flatMap((item) => item.upstream) });
	return { affected: consolidated, unitTerms: unitChanges, termsWithoutRow, wrappedGained, wrappedLost, references, staleValidations };
}

export function countByAction(impact: Impact): Record<Action, number> {
	const counts: Record<Action, number> = { automatic: 0, migrated: 0, review: 0, manual: 0 };
	for (const item of impact.affected) counts[item.action]++;
	return counts;
}
