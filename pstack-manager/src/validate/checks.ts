import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { type Adapter, adapterVersion } from "../build/adapter.ts";
import { classify } from "../build/classify.ts";
import { buildDist, type DistEntry, type DistManifest, MANIFEST_FILE, matchesGlob, readManifest } from "../build/engine.ts";
import { renderMatrix } from "../build/matrix.ts";
import { copilotValue } from "../build/models.ts";
import { type FrontValue, frontValue, hasFrontmatter, parseFrontmatter } from "../lib/frontmatter.ts";
import { exists, fileMode, isExecutable, readText, remove, sha256, walkFiles } from "../lib/fs.ts";
import { isRelativeHref, LINK, removeInjection, resolveRelative, reverseLinks, splitHref } from "../lib/markdown.ts";
import type { UpstreamLock } from "../upstream/lock.ts";

/** Files run by path: extensionless or shell. A `.ts` file with a shebang is run through its runtime wrapper. */
function isDirectScript(path: string): boolean {
	const name = basename(path);
	return !name.includes(".") || name.endsWith(".sh");
}

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Undoes every recorded transform of a core Markdown file and returns the bytes it should have come from. */
export function reverseEntry(entry: DistEntry, bytes: string): string {
	let text = bytes;
	const transforms = [...entry.transforms].reverse();
	for (const t of transforms) {
		if (t.type === "frontmatter-add" || t.type === "inject-adapter-line") text = removeInjection(text, t.injection);
		else if (t.type === "rewrite-links") text = reverseLinks(text, t.rewrites);
	}
	return text;
}

/** Proves the build is the core plus declared transforms, file by file. */
export function checkDistProof(coreDir: string, distDir: string, adapter: Adapter, lock: UpstreamLock): string[] {
	const problems: string[] = [];
	const manifest: DistManifest = readManifest(distDir);
	const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
	const onDisk = walkFiles(distDir).filter((path) => path !== MANIFEST_FILE);
	for (const path of onDisk) if (!listed.has(path)) problems.push(`dist file not in manifest: ${path}`);
	const sourced = new Set<string>();
	for (const entry of manifest.files) {
		const abs = join(distDir, entry.path);
		if (!exists(abs)) {
			problems.push(`manifest lists missing file: ${entry.path}`);
			continue;
		}
		const bytes = readFileSync(abs);
		if (sha256(bytes) !== entry.sha256) problems.push(`dist file changed after build: ${entry.path}`);
		if (fileMode(abs) !== entry.mode) problems.push(`mode of ${entry.path} is ${fileMode(abs)}, manifest says ${entry.mode}`);
		if (entry.origin === "core") {
			const source = entry.source as string;
			sourced.add(source);
			const locked = lock.files[source];
			if (!locked || locked.sha256 !== entry.sourceSha256) {
				problems.push(`${entry.path} came from ${source}, which is not the locked upstream file`);
				continue;
			}
			if (locked.mode !== entry.mode) problems.push(`${entry.path} changed the executable bit of ${source}`);
			const core = readFileSync(join(coreDir, source));
			const render = entry.transforms.find((t) => t.type === "render-agent");
			if (render && render.type === "render-agent") {
				problems.push(...checkAgent(entry, bytes.toString("utf8"), core.toString("utf8")));
				continue;
			}
			const textual = entry.transforms.some((t) => t.type !== "relocate");
			const restored = textual ? Buffer.from(reverseEntry(entry, bytes.toString("utf8"))) : bytes;
			if (!restored.equals(core)) problems.push(`${entry.path} is not ${source} plus its declared transforms`);
		} else if (entry.origin === "overlay") {
			const overlay = join(adapter.overlays, entry.source as string);
			if (!exists(overlay) || !readFileSync(overlay).equals(bytes)) problems.push(`${entry.path} differs from overlay ${entry.source}`);
		}
	}
	for (const path of Object.keys(lock.files)) {
		if (!sourced.has(path) && !adapter.exclude.some((pattern) => matchesGlob(path, pattern))) problems.push(`core file neither shipped nor excluded: ${path}`);
	}
	const matrix = listed.get(adapter.matrix);
	if (!matrix || readText(join(distDir, adapter.matrix)) !== renderMatrix(adapter, lock, manifest.version)) problems.push(`${adapter.matrix} is stale; rebuild`);
	const plugin = JSON.parse(readText(join(distDir, "plugin.json"))) as Record<string, unknown>;
	if (plugin.name !== adapter.plugin.name || plugin.version !== adapterVersion(lock.version, adapter)) problems.push("plugin.json name or version does not match the adapter");
	if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") problems.push("plugin.json does not declare Agent Plugins 1.0");
	return problems;
}

function checkAgent(entry: DistEntry, distText: string, coreText: string): string[] {
	const problems: string[] = [];
	let text = distText;
	const inject = entry.transforms.find((t) => t.type === "inject-adapter-line");
	if (inject && inject.type === "inject-adapter-line") text = removeInjection(text, inject.injection);
	const dist = parseFrontmatter(text);
	const core = parseFrontmatter(coreText);
	const links = entry.transforms.find((t) => t.type === "rewrite-links");
	const body = links && links.type === "rewrite-links" ? reverseLinks(dist.body, links.rewrites) : dist.body;
	if (body !== core.body) problems.push(`${entry.path}: body is not the upstream agent body`);
	const render = entry.transforms.find((t) => t.type === "render-agent");
	if (!render || render.type !== "render-agent") return [`${entry.path}: missing render-agent transform`];
	for (const coreEntry of core.entries) {
		if (render.dropped.includes(coreEntry.key)) continue;
		const kept = dist.entries.find((candidate) => candidate.key === coreEntry.key);
		if (!kept || kept.lines.join("\n") !== coreEntry.lines.join("\n")) problems.push(`${entry.path}: frontmatter ${coreEntry.key} changed`);
	}
	for (const [key, value] of Object.entries(render.set)) {
		if (JSON.stringify(frontValue(dist, key)) !== JSON.stringify(value)) problems.push(`${entry.path}: ${key} is not the declared value`);
	}
	return problems;
}

/** Same inputs, same bytes: builds again into a scratch folder and compares manifests. */
export function checkDeterminism(coreDir: string, distDir: string, adapter: Adapter, lock: UpstreamLock): string[] {
	const scratch = mkdtempSync(join(tmpdir(), "pstack-rebuild-"));
	try {
		buildDist({ coreDir, lock, adapter, outDir: join(scratch, "dist") });
		const a = readText(join(distDir, MANIFEST_FILE));
		const b = readText(join(scratch, "dist", MANIFEST_FILE));
		return a === b ? [] : ["a second build produced different bytes; the build is not deterministic or dist is stale"];
	} finally {
		remove(scratch);
	}
}

/** Every Cursor term a shipped skill or agent uses must have a row in the adapter skill, as upstream requires of its Claude adapter. */
export function checkAdapterCoverage(coreDir: string, distDir: string, adapter: Adapter, lock: UpstreamLock): string[] {
	const problems: string[] = [];
	const adapterText = readText(join(distDir, adapter.adapterSkill));
	const manifest = readManifest(distDir);
	const used = new Map<string, string[]>();
	for (const entry of manifest.files) {
		const t = entry.transforms.find((transform) => transform.type === "inject-adapter-line");
		if (!t || t.type !== "inject-adapter-line") continue;
		for (const key of t.terms) used.set(key, [...(used.get(key) || []), entry.path]);
	}
	for (const [key, users] of used) if (!adapterText.includes(key)) problems.push(`adapter has no row for ${key}, used by ${users.join(", ")}`);
	for (const term of adapter.extraTerms) if (!adapterText.includes(term.key)) problems.push(`adapter has no row for declared term ${term.key}`);
	const skills = manifest.files.filter((entry) => /^skills\/[^/]+\/SKILL\.md$/.test(entry.path) && entry.origin === "core");
	const all = [...lock.vocabulary.terms, ...adapter.extraTerms];
	const names = skills.map((entry) => entry.path.split("/")[1]);
	for (const entry of skills) {
		const name = entry.path.split("/")[1];
		const texts = Object.keys(lock.files).filter((path) => path.startsWith(`skills/${name}/`) && path.endsWith(".md"));
		const { keys } = classify(texts.map((path) => readText(join(coreDir, path))), { terms: all, routeKey: lock.vocabulary.routeKey }, names.filter((other) => other !== name));
		const wrapped = entry.transforms.some((t) => t.type === "inject-adapter-line");
		if (keys.size > 0 && !wrapped) problems.push(`${entry.path} uses ${[...keys].join(", ")} but has no adapter line`);
	}
	return problems;
}

/** Every upstream item has exactly one traceability entry, and every entry still names a real item. */
export function checkFeatureCoverage(adapter: Adapter, lock: UpstreamLock): string[] {
	const expected = new Set<string>();
	for (const path of Object.keys(lock.files)) {
		let match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
		if (match) expected.add(`skill:${match[1]}`);
		match = /^skills\/poteto-mode\/playbooks\/([^/]+)\.md$/.exec(path);
		if (match) expected.add(`playbook:${match[1]}`);
		match = /^agents\/([^/]+)\.md$/.exec(path);
		if (match) expected.add(`agent:${match[1]}`);
		match = /^automations\/([^/]+)\//.exec(path);
		if (match) expected.add(`automation:${match[1]}`);
		if (lock.files[path].mode === "755" && !path.includes("/test/")) expected.add(`script:${path}`);
	}
	for (const term of [...lock.vocabulary.terms, ...adapter.extraTerms]) expected.add(`term:${term.key}`);
	expected.add(`term:${lock.vocabulary.routeKey}`);
	for (const path of walkFiles(adapter.overlays)) {
		let match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
		if (match) expected.add(`copilot-addition:${match[1]}`);
		match = /\/agents\/([^/]+)\.agent\.md$/.exec(path);
		if (match) expected.add(`copilot-addition:${match[1]}-agent`);
		match = /\/rules\/([^/]+)\.instructions\.md$/.exec(path);
		if (match) expected.add(`copilot-addition:${match[1]}-instructions`);
	}
	const actual = new Set(adapter.features.map((feature) => feature.id));
	const problems: string[] = [];
	for (const id of expected) if (!actual.has(id)) problems.push(`no traceability entry for ${id} in mappings/features.json`);
	for (const id of actual) if (!expected.has(id)) problems.push(`traceability entry ${id} names nothing upstream or in the overlays`);
	return problems;
}

/** The Agent Skills rules Copilot applies, which make a skill silently fail to load when broken. */
export function lintSkillFolder(dir: string, options: { links: boolean } = { links: true }): string[] {
	const file = join(dir, "SKILL.md");
	const label = posix.join(basename(dirname(dir)), basename(dir));
	if (!exists(file)) return [`${label}: no SKILL.md`];
	const text = readText(file);
	if (!hasFrontmatter(text)) return [`${label}: SKILL.md has no frontmatter, so the skill never registers`];
	let fm: ReturnType<typeof parseFrontmatter>;
	try {
		fm = parseFrontmatter(text);
	} catch (error) {
		return [`${label}: frontmatter does not parse: ${(error as Error).message}`];
	}
	const problems: string[] = [];
	const name = frontValue(fm, "name");
	const description = frontValue(fm, "description");
	if (name !== basename(dir)) problems.push(`${label}: name ${JSON.stringify(name)} is not the folder name`);
	if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64) problems.push(`${label}: name must be lowercase words joined by hyphens, at most 64 characters`);
	if (typeof description !== "string" || description.length === 0) problems.push(`${label}: description is required`);
	else if (description.length > 1024) problems.push(`${label}: description is ${description.length} characters; the limit is 1024`);
	for (const key of ["disable-model-invocation", "user-invocable"]) {
		const value = frontValue(fm, key);
		if (value !== undefined && typeof value !== "boolean") problems.push(`${label}: ${key} must be true or false`);
	}
	const hint = frontValue(fm, "argument-hint");
	if (hint !== undefined && typeof hint !== "string") problems.push(`${label}: argument-hint must be a string`);
	for (const path of walkFiles(dir)) {
		const abs = join(dir, path);
		if (isDirectScript(path) && readFileSync(abs).subarray(0, 2).toString() === "#!" && !isExecutable(abs) && !path.includes("/test/")) problems.push(`${label}: ${path} has a shebang but is not executable`);
		if (!options.links || !path.endsWith(".md") || path.startsWith("upstream/")) continue;
		for (const match of readText(abs).matchAll(LINK)) {
			if (!isRelativeHref(match[1])) continue;
			const target = join(dirname(abs), splitHref(match[1]).path);
			if (!exists(target)) problems.push(`${label}: ${path} links to ${match[1]}, which does not exist`);
		}
	}
	return problems;
}

function checkAgentFile(path: string, rel: string, skills: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	const fm = parseFrontmatter(readText(path));
	const description = frontValue(fm, "description");
	if (typeof frontValue(fm, "name") !== "string") problems.push(`${rel}: name is required`);
	if (typeof description !== "string" || description === "") problems.push(`${rel}: description is required by the Copilot agent schema`);
	const effort = frontValue(fm, "reasoning-effort");
	if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.has(effort))) problems.push(`${rel}: reasoning-effort ${String(effort)} is not a Copilot effort`);
	const model = frontValue(fm, "model");
	if (model !== undefined && typeof model !== "string" && !Array.isArray(model)) problems.push(`${rel}: model must be a string or a list`);
	for (const key of ["user-invocable", "disable-model-invocation"]) {
		const value = frontValue(fm, key);
		if (value !== undefined && typeof value !== "boolean") problems.push(`${rel}: ${key} must be true or false`);
	}
	const preload: FrontValue | undefined = frontValue(fm, "skills");
	if (preload !== undefined) {
		if (!Array.isArray(preload)) problems.push(`${rel}: skills must be a list`);
		else for (const skill of preload) if (!skills.has(skill)) problems.push(`${rel}: preloads skill ${skill}, which the build does not ship`);
	}
	for (const key of ["handoffs", "agents", "argument-hint", "advancedOptions", "is_background"]) {
		if (fm.entries.some((entry) => entry.key === key)) problems.push(`${rel}: ${key} is not supported by the Copilot harness`);
	}
	return problems;
}

/** Agent Skills, custom agent, instruction, and script rules for everything the build ships. */
export function checkSchemas(distDir: string, adapter: Adapter): string[] {
	const problems: string[] = [];
	const skillsRoot = join(distDir, adapter.install.skills);
	const skills = new Set(walkFiles(skillsRoot).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.split("/")[0]));
	for (const skill of skills) problems.push(...lintSkillFolder(join(skillsRoot, skill), { links: false }));
	const agentsRoot = join(distDir, adapter.install.agents);
	for (const path of walkFiles(agentsRoot)) {
		if (!path.endsWith(".agent.md")) problems.push(`${adapter.install.agents}${path}: agent files must end in .agent.md`);
		else problems.push(...checkAgentFile(join(agentsRoot, path), `${adapter.install.agents}${path}`, skills));
	}
	const rulesRoot = join(distDir, adapter.install.instructions);
	for (const path of walkFiles(rulesRoot)) {
		const fm = parseFrontmatter(readText(join(rulesRoot, path)));
		if (!path.endsWith(".instructions.md")) problems.push(`${path}: instruction files must end in .instructions.md`);
		if (typeof frontValue(fm, "applyTo") !== "string") problems.push(`${path}: applyTo is required`);
	}
	for (const path of walkFiles(distDir)) {
		const abs = join(distDir, path);
		if (isDirectScript(path) && readFileSync(abs).subarray(0, 2).toString() === "#!" && !isExecutable(abs) && !path.includes("/test/")) problems.push(`${path} has a shebang but is not executable`);
	}
	return problems;
}

/**
 * Every relative link in a shipped Markdown file resolves inside the build. A link that is already dead in
 * the upstream source is upstream's own mistake, which the exact copy cannot fix, so it does not count.
 */
export function checkLinks(distDir: string, coreDir: string): string[] {
	const problems: string[] = [];
	const files = walkFiles(distDir);
	const fileSet = new Set(files);
	const isDir = (path: string) => files.some((file) => file.startsWith(`${path}/`));
	const coreFiles = new Set(walkFiles(coreDir));
	const coreHas = (path: string) => coreFiles.has(path) || [...coreFiles].some((file) => file.startsWith(`${path}/`));
	const sourceOf = new Map(readManifest(distDir).files.filter((entry) => entry.origin === "core" && entry.source).map((entry) => [entry.path, entry.source as string]));
	for (const path of files.filter((file) => file.endsWith(".md"))) {
		const source = sourceOf.get(path);
		const deadUpstream = new Set<string>();
		if (source) {
			for (const match of readText(join(coreDir, source)).matchAll(LINK)) {
				if (isRelativeHref(match[1]) && !coreHas(resolveRelative(source, splitHref(match[1]).path))) deadUpstream.add(match[1]);
			}
		}
		for (const match of readText(join(distDir, path)).matchAll(LINK)) {
			const href = match[1];
			if (!isRelativeHref(href) || deadUpstream.has(href)) continue;
			const target = resolveRelative(path, splitHref(href).path);
			if (target === "" || target.startsWith("..")) {
				problems.push(`${path}: link ${href} leaves the build`);
				continue;
			}
			if (!fileSet.has(target) && !isDir(target)) problems.push(`${path}: link ${href} does not resolve`);
		}
	}
	return problems;
}

/** The adapter skill states the same role defaults the manager writes, so the two never disagree. */
export function checkModels(distDir: string, adapter: Adapter): string[] {
	const problems: string[] = [];
	const text = readText(join(distDir, adapter.adapterSkill));
	for (const role of adapter.models.roles) {
		const value = role.cursor.map((slug) => copilotValue(slug, adapter.models)).join(", ");
		if (!value.split(", ").every((part) => text.includes(`\`${part}\``) || text.includes(part))) problems.push(`adapter skill does not state ${role.role}: ${value}`);
		for (const slug of role.cursor) {
			try {
				copilotValue(slug, adapter.models);
			} catch (error) {
				problems.push((error as Error).message);
			}
		}
	}
	return problems;
}
