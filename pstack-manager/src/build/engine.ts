import { join } from "node:path";
import { readFileSync } from "node:fs";
import { type FrontValue, parseFrontmatter, serializeEntry } from "../lib/frontmatter.ts";
import { exists, fileMode, readJson, remove, sha256, walkFiles, writeFile, writeJson } from "../lib/fs.ts";
import { injectAfterH1, type Injection, isRelativeHref, type LinkRewrite, relativeHref, resolveRelative, rewriteLinks, splitHref } from "../lib/markdown.ts";
import type { UpstreamLock } from "../upstream/lock.ts";
import { type Adapter, adapterVersion } from "./adapter.ts";
import { classify, type Vocabulary } from "./classify.ts";
import { renderMatrix } from "./matrix.ts";

export type Transform =
	| { readonly type: "relocate"; readonly from: string }
	| { readonly type: "rewrite-links"; readonly rewrites: readonly LinkRewrite[] }
	| { readonly type: "inject-adapter-line"; readonly injection: Injection; readonly terms: readonly string[] }
	| { readonly type: "frontmatter-add"; readonly injection: Injection; readonly keys: readonly string[] }
	| { readonly type: "render-agent"; readonly dropped: readonly string[]; readonly set: Readonly<Record<string, FrontValue>> }
	| { readonly type: "generated"; readonly by: "manifest" | "matrix" };

export interface DistEntry {
	readonly path: string;
	readonly origin: "core" | "overlay" | "generated";
	readonly source?: string;
	readonly sourceSha256?: string;
	readonly sha256: string;
	readonly mode: "644" | "755";
	readonly transforms: readonly Transform[];
}

export interface DistManifest {
	readonly schema: 1;
	readonly adapter: string;
	readonly adapterRevision: number;
	readonly version: string;
	readonly core: { readonly version: string; readonly commit: string; readonly tree: string };
	readonly install: { readonly skills: string; readonly agents: string; readonly instructions: string };
	readonly files: readonly DistEntry[];
}

export const MANIFEST_FILE = "dist-manifest.json";

/** Glob subset used by adapter excludes: `dir/**` matches everything below `dir/`, anything else is an exact path. */
export function matchesGlob(path: string, pattern: string): boolean {
	return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

export interface PathMapper {
	/** Dist path for a core file or folder, or null when the adapter does not ship it. */
	map(corePath: string): string | null;
	isExcluded(corePath: string): boolean;
}

export function pathMapper(adapter: Adapter): PathMapper {
	const isExcluded = (corePath: string) => adapter.exclude.some((pattern) => matchesGlob(corePath, pattern) || matchesGlob(`${corePath}/`, pattern));
	const map = (corePath: string): string | null => {
		if (isExcluded(corePath)) return null;
		if (corePath.startsWith(adapter.agents.from)) {
			const name = corePath.slice(adapter.agents.from.length).replace(/\.md$/, "");
			return name === "" ? adapter.agents.to.replace(/\/$/, "") : `${adapter.agents.to}${name}${adapter.agents.suffix}`;
		}
		for (const { from, to } of adapter.relocate) {
			if (from.endsWith("/")) {
				if (corePath.startsWith(from)) return `${to}${corePath.slice(from.length)}`;
				if (`${corePath}/` === from) return to.replace(/\/$/, "");
			} else if (corePath === from) return to;
		}
		return null;
	};
	return { map, isExcluded };
}

interface BuildContext {
	readonly coreDir: string;
	readonly lock: UpstreamLock;
	readonly adapter: Adapter;
	readonly mapper: PathMapper;
	readonly coreFiles: readonly string[];
	readonly vocabulary: Vocabulary;
	readonly skills: readonly string[];
}

function coreHas(ctx: BuildContext, path: string): "file" | "dir" | null {
	if (ctx.coreFiles.includes(path)) return "file";
	return ctx.coreFiles.some((file) => file.startsWith(`${path}/`)) ? "dir" : null;
}

/** Rewrites a core Markdown file's relative links for its new place in the dist tree. */
function relink(ctx: BuildContext, corePath: string, distPath: string, text: string) {
	return rewriteLinks(text, (href) => {
		if (!isRelativeHref(href)) return undefined;
		const { path, suffix } = splitHref(href);
		const target = resolveRelative(corePath, path);
		const kind = coreHas(ctx, target);
		if (!kind) return undefined;
		const mapped = ctx.mapper.map(target);
		if (mapped === null) {
			const base = ctx.adapter.excludedLinkBase.replace("{kind}", kind === "dir" ? "tree" : "blob").replace("{commit}", ctx.lock.commit);
			return `${base}${target}${suffix}`;
		}
		const next = relativeHref(distPath, mapped) + (path.endsWith("/") ? "/" : "") + suffix;
		if (resolveRelative(distPath, path) === mapped) return undefined;
		return next === href ? undefined : next;
	});
}

function addFrontmatter(text: string, keys: Readonly<Record<string, FrontValue>>): { text: string; injection: Injection } | null {
	const entries = Object.entries(keys);
	if (entries.length === 0) return null;
	const fm = parseFrontmatter(text);
	for (const [key] of entries) if (fm.entries.some((entry) => entry.key === key)) throw new Error(`frontmatter already has ${key}`);
	const close = fm.head.lastIndexOf("---");
	const inserted = entries.map(([key, value]) => `${serializeEntry(key, value)}\n`).join("");
	return { text: text.slice(0, close) + inserted + text.slice(close), injection: { at: close, inserted } };
}

function skillOf(corePath: string): string | null {
	const match = /^skills\/([^/]+)\//.exec(corePath);
	return match ? match[1] : null;
}

function unitTexts(ctx: BuildContext, prefix: string): string[] {
	return ctx.coreFiles.filter((file) => file.startsWith(prefix) && file.endsWith(".md")).map((file) => readFileSync(join(ctx.coreDir, file), "utf8"));
}

function renderAgent(ctx: BuildContext, corePath: string, distPath: string, text: string): { bytes: string; transforms: Transform[] } {
	const name = corePath.slice(ctx.adapter.agents.from.length).replace(/\.md$/, "");
	const rule = ctx.adapter.agents.rules[name];
	if (!rule) throw new Error(`no agent rule for ${corePath} in the adapter's agent mapping`);
	const fm = parseFrontmatter(text);
	const known = new Set(["name", "description", ...rule.drop]);
	for (const entry of fm.entries) if (!known.has(entry.key)) throw new Error(`${corePath} has frontmatter key ${entry.key} that the agent rule neither keeps nor drops`);
	const kept = fm.entries.filter((entry) => !rule.drop.includes(entry.key)).flatMap((entry) => entry.lines);
	const added = Object.entries(rule.set).map(([key, value]) => serializeEntry(key, value));
	const head = `---\n${[...kept, ...added].join("\n")}\n---\n`;
	const { text: body, rewrites } = relink(ctx, corePath, distPath, fm.body);
	const transforms: Transform[] = [{ type: "render-agent", dropped: rule.drop, set: rule.set }];
	if (rewrites.length > 0) transforms.push({ type: "rewrite-links", rewrites });
	const { keys } = classify([text], ctx.vocabulary, ctx.skills);
	if (keys.size === 0) return { bytes: head + body, transforms };
	const { text: injected, injection } = injectAfterH1(head + body, head.length, ctx.adapter.adapterLine.agent);
	transforms.push({ type: "inject-adapter-line", injection, terms: [...keys].sort() });
	return { bytes: injected, transforms };
}

export interface BuildResult {
	readonly version: string;
	readonly outDir: string;
	readonly manifest: DistManifest;
}

export interface BuildInput {
	readonly coreDir: string;
	readonly lock: UpstreamLock;
	readonly adapter: Adapter;
	readonly outDir: string;
}

/** Builds the adapter's distribution from the core. The same inputs always produce the same bytes. */
export function buildDist(input: BuildInput): BuildResult {
	const { coreDir, lock, adapter, outDir } = input;
	if (!adapter.coreVersions.includes(lock.version)) {
		throw new Error(`adapter ${adapter.id} supports core ${adapter.coreVersions.join(", ")}, not ${lock.version}. Review the upstream changes, update the adapter, then add the version.`);
	}
	const coreFiles = walkFiles(coreDir);
	const skills = [...new Set(coreFiles.map(skillOf).filter((name): name is string => name !== null))].sort();
	const ctx: BuildContext = {
		coreDir,
		lock,
		adapter,
		mapper: pathMapper(adapter),
		coreFiles,
		vocabulary: { terms: [...lock.vocabulary.terms, ...adapter.extraTerms], routeKey: lock.vocabulary.routeKey },
		skills,
	};
	const wrapped = new Map<string, string[]>();
	for (const skill of skills) {
		const { keys } = classify(unitTexts(ctx, `skills/${skill}/`), ctx.vocabulary, skills.filter((name) => name !== skill));
		if (keys.size > 0) wrapped.set(skill, [...keys].sort());
	}

	remove(outDir);
	const entries: DistEntry[] = [];
	const emit = (entry: Omit<DistEntry, "sha256">, bytes: Buffer | string) => {
		if (entries.some((existing) => existing.path === entry.path)) throw new Error(`two sources write ${entry.path}`);
		writeFile(join(outDir, entry.path), bytes, entry.mode);
		entries.push({ ...entry, sha256: sha256(bytes) });
	};

	for (const corePath of coreFiles) {
		const distPath = ctx.mapper.map(corePath);
		const copies = adapter.copies.filter((copy) => copy.from === corePath).map((copy) => copy.to);
		const raw = readFileSync(join(coreDir, corePath));
		const mode = fileMode(join(coreDir, corePath));
		const sourceSha256 = sha256(raw);
		for (const to of copies) emit({ path: to, origin: "core", source: corePath, sourceSha256, mode, transforms: [{ type: "relocate", from: corePath }] }, raw);
		if (distPath === null) continue;
		const transforms: Transform[] = distPath === corePath ? [] : [{ type: "relocate", from: corePath }];
		if (corePath.startsWith(adapter.agents.from)) {
			const rendered = renderAgent(ctx, corePath, distPath, raw.toString("utf8"));
			emit({ path: distPath, origin: "core", source: corePath, sourceSha256, mode, transforms: [...transforms, ...rendered.transforms] }, rendered.bytes);
			continue;
		}
		if (!corePath.endsWith(".md")) {
			emit({ path: distPath, origin: "core", source: corePath, sourceSha256, mode, transforms }, raw);
			continue;
		}
		let text = raw.toString("utf8");
		const linked = relink(ctx, corePath, distPath, text);
		if (linked.rewrites.length > 0) {
			text = linked.text;
			transforms.push({ type: "rewrite-links", rewrites: linked.rewrites });
		}
		const skill = skillOf(corePath);
		if (skill && corePath === `skills/${skill}/SKILL.md`) {
			const terms = wrapped.get(skill);
			if (terms) {
				const injected = injectAfterH1(text, parseFrontmatter(text).head.length, adapter.adapterLine.skill);
				text = injected.text;
				transforms.push({ type: "inject-adapter-line", injection: injected.injection, terms });
			}
			const added = addFrontmatter(text, adapter.skillFrontmatter.skills[skill] || {});
			if (added) {
				text = added.text;
				transforms.push({ type: "frontmatter-add", injection: added.injection, keys: Object.keys(adapter.skillFrontmatter.skills[skill]) });
			}
		}
		emit({ path: distPath, origin: "core", source: corePath, sourceSha256, mode, transforms }, text);
	}

	for (const overlayPath of walkFiles(adapter.overlays)) {
		const bytes = readFileSync(join(adapter.overlays, overlayPath));
		emit({ path: overlayPath, origin: "overlay", source: overlayPath, sourceSha256: sha256(bytes), mode: fileMode(join(adapter.overlays, overlayPath)), transforms: [] }, bytes);
	}

	const version = adapterVersion(lock.version, adapter);
	const upstreamManifest = readJson(join(coreDir, "plugin.json")) as Record<string, unknown>;
	const plugin = {
		$schema: upstreamManifest.$schema,
		name: adapter.plugin.name,
		version,
		description: `${String(upstreamManifest.description)} ${adapter.plugin.descriptionSuffix}`,
		author: upstreamManifest.author,
		homepage: upstreamManifest.homepage,
		repository: upstreamManifest.repository,
		license: upstreamManifest.license,
		keywords: [...(upstreamManifest.keywords as string[]), ...adapter.plugin.keywords],
		extensions: { "com.github.copilot": {} },
	};
	emit({ path: "plugin.json", origin: "generated", source: "plugin.json", mode: "644", transforms: [{ type: "generated", by: "manifest" }] }, `${JSON.stringify(plugin, null, "\t")}\n`);
	emit({ path: adapter.matrix, origin: "generated", mode: "644", transforms: [{ type: "generated", by: "matrix" }] }, renderMatrix(adapter, lock, version));

	const manifest: DistManifest = {
		schema: 1,
		adapter: adapter.id,
		adapterRevision: adapter.revision,
		version,
		core: { version: lock.version, commit: lock.commit, tree: lock.tree },
		install: adapter.install,
		files: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
	};
	writeJson(join(outDir, MANIFEST_FILE), manifest);
	return { version, outDir, manifest };
}

export function readManifest(distDir: string): DistManifest {
	const file = join(distDir, MANIFEST_FILE);
	if (!exists(file)) throw new Error(`${file} is missing; this folder is not a pstack build`);
	return readJson(file) as DistManifest;
}
