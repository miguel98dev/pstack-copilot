import { join } from "node:path";
import type { FrontValue } from "../lib/frontmatter.ts";
import { readJson } from "../lib/fs.ts";
import type { VocabularyTerm } from "../upstream/vocabulary.ts";

export interface Relocation {
	readonly from: string;
	readonly to: string;
}

export interface AgentRule {
	readonly drop: readonly string[];
	readonly set: Readonly<Record<string, FrontValue>>;
	readonly why: string;
}

export interface ModelRules {
	readonly ladder: readonly string[];
	readonly slugs: readonly { readonly pattern: string; readonly model: string; readonly substitute?: string }[];
	readonly roles: readonly { readonly role: string; readonly cursor: readonly string[] }[];
	readonly panelRoles: readonly string[];
}

/** `pending` marks an upstream item the sync found and nobody has reviewed for Copilot yet. */
export type SupportStatus = "native" | "adapted" | "partial" | "unsupported" | "excluded" | "pending";
/** `stale` marks a feature that was validated in VS Code before upstream changed it, so the run no longer proves it. */
export type ValidationState = "vscode-validated" | "stale" | "static" | "untested";

export interface Feature {
	readonly id: string;
	readonly kind: "skill" | "playbook" | "agent" | "script" | "term" | "automation" | "copilot-addition";
	readonly status: SupportStatus;
	readonly copilot: string;
	readonly validation: ValidationState;
	readonly evidence?: string;
	readonly limits?: string;
}

export interface Watch {
	/** Upstream paths: an exact path, or a folder ending in `/**`. */
	readonly upstream: readonly string[];
	/** The adapter files or feature ids that depend on them. */
	readonly adaptation: readonly string[];
	readonly why: string;
}

export interface Adapter {
	readonly id: string;
	readonly dir: string;
	readonly displayName: string;
	readonly revision: number;
	readonly coreVersions: readonly string[];
	readonly plugin: { readonly name: string; readonly descriptionSuffix: string; readonly keywords: readonly string[] };
	readonly relocate: readonly Relocation[];
	readonly copies: readonly Relocation[];
	readonly exclude: readonly string[];
	readonly agents: { readonly from: string; readonly to: string; readonly suffix: string; readonly rules: Readonly<Record<string, AgentRule>> };
	readonly excludedLinkBase: string;
	readonly adapterSkill: string;
	readonly adapterLine: { readonly skill: string; readonly agent: string };
	readonly extraTerms: readonly VocabularyTerm[];
	readonly skillFrontmatter: { readonly allowedKeys: readonly string[]; readonly skills: Readonly<Record<string, Readonly<Record<string, FrontValue>>>> };
	readonly models: ModelRules;
	readonly features: readonly Feature[];
	readonly overlays: string;
	readonly matrix: string;
	readonly watch: readonly Watch[];
	readonly install: { readonly skills: string; readonly agents: string; readonly instructions: string };
}

function fail(file: string, message: string): never {
	throw new Error(`${file}: ${message}`);
}

function obj(value: unknown, file: string, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(file, `${name} must be an object`);
	return value as Record<string, unknown>;
}

function str(value: unknown, file: string, name: string): string {
	if (typeof value !== "string" || value === "") fail(file, `${name} must be a non-empty string`);
	return value;
}

function strings(value: unknown, file: string, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(file, `${name} must be a string array`);
	return value as string[];
}

function relocations(value: unknown, file: string, name: string): Relocation[] {
	if (!Array.isArray(value)) fail(file, `${name} must be an array`);
	return value.map((item, index) => {
		const o = obj(item, file, `${name}[${index}]`);
		return { from: str(o.from, file, `${name}[${index}].from`), to: str(o.to, file, `${name}[${index}].to`) };
	});
}

const STATUSES = new Set(["native", "adapted", "partial", "unsupported", "excluded", "pending"]);
const VALIDATIONS = new Set(["vscode-validated", "stale", "static", "untested"]);
const KINDS = new Set(["skill", "playbook", "agent", "script", "term", "automation", "copilot-addition"]);

function parseFeatures(value: unknown, file: string): Feature[] {
	const list = obj(value, file, "root").features;
	if (!Array.isArray(list)) fail(file, "features must be an array");
	const seen = new Set<string>();
	return list.map((item, index) => {
		const o = obj(item, file, `features[${index}]`);
		const id = str(o.id, file, `features[${index}].id`);
		if (seen.has(id)) fail(file, `duplicate feature ${id}`);
		seen.add(id);
		const kind = str(o.kind, file, `${id}.kind`);
		const status = str(o.status, file, `${id}.status`);
		const validation = str(o.validation, file, `${id}.validation`);
		if (!KINDS.has(kind)) fail(file, `${id}.kind ${kind}`);
		if (!STATUSES.has(status)) fail(file, `${id}.status ${status}`);
		if (!VALIDATIONS.has(validation)) fail(file, `${id}.validation ${validation}`);
		if ((validation === "vscode-validated" || validation === "stale") && typeof o.evidence !== "string") fail(file, `${id} is ${validation} without evidence`);
		return {
			id,
			kind: kind as Feature["kind"],
			status: status as SupportStatus,
			copilot: str(o.copilot, file, `${id}.copilot`),
			validation: validation as ValidationState,
			evidence: typeof o.evidence === "string" ? o.evidence : undefined,
			limits: typeof o.limits === "string" ? o.limits : undefined,
		};
	});
}

function parseWatch(value: unknown, file: string): Watch[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(file, "watch must be an array");
	return value.map((item, index) => {
		const o = obj(item, file, `watch[${index}]`);
		return { upstream: strings(o.upstream, file, `watch[${index}].upstream`), adaptation: strings(o.adaptation, file, `watch[${index}].adaptation`), why: str(o.why, file, `watch[${index}].why`) };
	});
}

/** Reads `pstack-<id>/adapter.json` and every mapping file it names, rejecting any shape the build does not understand. */
export function loadAdapter(dir: string): Adapter {
	const file = join(dir, "adapter.json");
	const a = obj(readJson(file), file, "root");
	const plugin = obj(a.plugin, file, "plugin");
	const agents = obj(a.agents, file, "agents");
	const line = obj(a.adapterLine, file, "adapterLine");
	const install = obj(a.install, file, "install");
	if (typeof a.revision !== "number" || !Number.isInteger(a.revision)) fail(file, "revision must be an integer");

	const agentFile = join(dir, str(agents.mapping, file, "agents.mapping"));
	const agentRules: Record<string, AgentRule> = {};
	for (const [name, rule] of Object.entries(obj(obj(readJson(agentFile), agentFile, "root").agents, agentFile, "agents"))) {
		const r = obj(rule, agentFile, name);
		agentRules[name] = { drop: strings(r.drop, agentFile, `${name}.drop`), set: obj(r.set, agentFile, `${name}.set`) as Record<string, FrontValue>, why: str(r.why, agentFile, `${name}.why`) };
	}

	const termsFile = join(dir, str(a.vocabulary, file, "vocabulary"));
	const termList = obj(readJson(termsFile), termsFile, "root").terms;
	if (!Array.isArray(termList)) fail(termsFile, "terms must be an array");
	const extraTerms = termList.map((term, index) => {
		const t = obj(term, termsFile, `terms[${index}]`);
		const pattern = str(t.pattern, termsFile, `terms[${index}].pattern`);
		const flags = typeof t.flags === "string" ? t.flags : "";
		new RegExp(pattern, flags);
		return { key: str(t.key, termsFile, `terms[${index}].key`), pattern, flags };
	});

	const fmFile = join(dir, str(a.skillFrontmatter, file, "skillFrontmatter"));
	const fm = obj(readJson(fmFile), fmFile, "root");
	const allowedKeys = strings(fm.allowedKeys, fmFile, "allowedKeys");
	const skills: Record<string, Record<string, FrontValue>> = {};
	for (const [skill, keys] of Object.entries(obj(fm.skills, fmFile, "skills"))) {
		const k = obj(keys, fmFile, skill) as Record<string, FrontValue>;
		for (const key of Object.keys(k)) if (!allowedKeys.includes(key)) fail(fmFile, `${skill} sets ${key}, which is not in allowedKeys`);
		skills[skill] = k;
	}

	const modelsFile = join(dir, str(a.models, file, "models"));
	const m = obj(readJson(modelsFile), modelsFile, "root");
	const models: ModelRules = {
		ladder: strings(m.ladder, modelsFile, "ladder"),
		slugs: (m.slugs as unknown[]).map((slug, index) => {
			const s = obj(slug, modelsFile, `slugs[${index}]`);
			return { pattern: str(s.pattern, modelsFile, "pattern"), model: str(s.model, modelsFile, "model"), substitute: typeof s.substitute === "string" ? s.substitute : undefined };
		}),
		roles: (m.roles as unknown[]).map((role, index) => {
			const r = obj(role, modelsFile, `roles[${index}]`);
			return { role: str(r.role, modelsFile, "role"), cursor: strings(r.cursor, modelsFile, "cursor") };
		}),
		panelRoles: strings(m.panelRoles, modelsFile, "panelRoles"),
	};

	const featuresFile = join(dir, str(a.features, file, "features"));
	return {
		id: str(a.id, file, "id"),
		dir,
		displayName: str(a.displayName, file, "displayName"),
		revision: a.revision,
		coreVersions: strings(a.coreVersions, file, "coreVersions"),
		plugin: { name: str(plugin.name, file, "plugin.name"), descriptionSuffix: str(plugin.descriptionSuffix, file, "plugin.descriptionSuffix"), keywords: strings(plugin.keywords, file, "plugin.keywords") },
		relocate: relocations(a.relocate, file, "relocate"),
		copies: relocations(a.copies, file, "copies"),
		exclude: strings(a.exclude, file, "exclude"),
		agents: { from: str(agents.from, file, "agents.from"), to: str(agents.to, file, "agents.to"), suffix: str(agents.suffix, file, "agents.suffix"), rules: agentRules },
		excludedLinkBase: str(a.excludedLinkBase, file, "excludedLinkBase"),
		adapterSkill: str(a.adapterSkill, file, "adapterSkill"),
		adapterLine: { skill: str(line.skill, file, "adapterLine.skill"), agent: str(line.agent, file, "adapterLine.agent") },
		extraTerms,
		skillFrontmatter: { allowedKeys, skills },
		models,
		features: parseFeatures(readJson(featuresFile), featuresFile),
		overlays: join(dir, str(a.overlays, file, "overlays")),
		watch: parseWatch(a.watch, file),
		matrix: str(a.matrix, file, "matrix"),
		install: { skills: str(install.skills, file, "install.skills"), agents: str(install.agents, file, "install.agents"), instructions: str(install.instructions, file, "install.instructions") },
	};
}

export function adapterVersion(coreVersion: string, adapter: Adapter): string {
	return `${coreVersion}+${adapter.id}.${adapter.revision}`;
}
