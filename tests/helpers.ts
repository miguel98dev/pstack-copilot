import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePaths, type Paths } from "../pstack-manager/src/paths.ts";

export const MANAGER = join(dirname(new URL(import.meta.url).pathname), "..", "pstack-manager");
export const REPO = join(MANAGER, "..");

export function write(root: string, rel: string, text: string, mode = 0o644): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pstack-test-${prefix}-`));
}

/** A small cursor/plugins checkout with the same shapes pstack uses: skills, routing, an agent, scripts, docs, automations, and the vocabulary source. */
export function makeUpstream(version = "1.0.0"): string {
	const root = tempDir("upstream");
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "test");
	write(
		root,
		"scripts/generate-pstack-harness-trees.mjs",
		`const TERMS = [\n  { key: "\`Task\`", re: /\`Task\`|\\bTask (tool|subagent|call)/ },\n  { key: "\`environment: \\"cloud\\"\`", re: /environment: "(cloud|local)"/ },\n  { key: "~/.cursor/plugins/", re: /\\.cursor\\/plugins|\\.cursor-plugin/ },\n];\nconst ROUTE_KEY = "Run another pstack skill";\n`,
	);
	write(root, "pstack/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "pstack", version, description: "test pstack", author: { name: "Lauren Tan" }, homepage: "https://example.com", repository: "https://github.com/cursor/plugins", license: "MIT", keywords: ["pstack"] }, null, "\t"));
	write(root, "pstack/.cursor-plugin/plugin.json", "{}\n");
	write(root, "pstack/LICENSE", "MIT License\n\nCopyright (c) 2026 Lauren Tan\n");
	write(root, "pstack/README.md", "# pstack\n\nSee [alpha](./skills/alpha/SKILL.md), [the guide](./docs/guide/README.md), and [benny](./automations/benny/README.md).\n");
	write(root, "pstack/docs/guide/README.md", "# Guide\n\nRun [beta](../../skills/beta/SKILL.md).\n");
	write(root, "pstack/skills/alpha/SKILL.md", '---\nname: alpha\ndescription: "Alpha spawns a Task subagent. Use for /alpha."\ndisable-model-invocation: true\n---\n\n# Alpha\n\nSpawn one `Task` with `environment: "cloud"`, then run the **beta** skill.\n\nSee [the guide](../../docs/guide/README.md).\n');
	write(root, "pstack/skills/alpha/scripts/run.sh", "#!/bin/sh\necho alpha\n", 0o755);
	write(root, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta is plain. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nNothing platform-specific here.\n");
	write(root, "pstack/skills/poteto-mode/SKILL.md", "---\nname: poteto-mode\ndescription: Router. Use for /poteto-mode.\ndisable-model-invocation: true\n---\n\n# Poteto mode\n\nOpen [playbooks](playbooks/).\n");
	write(root, "pstack/skills/poteto-mode/playbooks/feature.md", "### Feature\n\nBuild it.\n");
	write(root, "pstack/agents/helper.md", "---\nname: helper\ndescription: A delegate that searches ~/.cursor/plugins/ for skills.\nis_background: true\nmodel: claude-opus-5-5-xhigh-fast\n---\n\n# Helper\n\nSearch `~/.cursor/plugins/` first.\n");
	write(root, "pstack/automations/benny/README.md", "# benny\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
	return root;
}

export function commitUpstream(root: string, rel: string, text: string): void {
	write(root, rel, text);
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", `change ${rel}`);
}

const ADAPTER_SKILL = `---
name: pstack-copilot
description: Test adapter. Maps Cursor names.
user-invocable: false
---

# Adapter

Rows: \`Task\`, \`environment: "cloud"\`, ~/.cursor/plugins/, Run another pstack skill, Cursor-only features, \`/loop\`, inherit-parent. Defaults: \`claude-opus-5.5 @xhigh\`.
`;

/** A test adapter folder shaped like pstack-copilot, for the fixture upstream. */
export function makeAdapter(repoRoot: string, version = "1.0.0", revision = 1): void {
	const dir = join(repoRoot, "pstack-copilot");
	write(dir, "adapter.json", JSON.stringify({
		id: "copilot",
		displayName: "test",
		revision,
		coreVersions: [version],
		plugin: { name: "pstack", descriptionSuffix: "Test port.", keywords: ["copilot"] },
		relocate: [
			{ from: "skills/", to: "skills/" },
			{ from: "docs/", to: "skills/pstack-copilot/upstream/docs/" },
			{ from: "README.md", to: "skills/pstack-copilot/upstream/README.md" },
			{ from: "LICENSE", to: "skills/pstack-copilot/upstream/LICENSE" },
		],
		copies: [{ from: "LICENSE", to: "LICENSE" }],
		exclude: ["automations/**", ".cursor-plugin/**", "plugin.json"],
		agents: { from: "agents/", to: "com.github.copilot/agents/", suffix: ".agent.md", mapping: "mappings/agents.json" },
		excludedLinkBase: "https://github.com/cursor/plugins/{kind}/{commit}/pstack/",
		adapterSkill: "skills/pstack-copilot/SKILL.md",
		adapterLine: { skill: "On Copilot, read [the adapter](../pstack-copilot/SKILL.md).", agent: "On Copilot, read the pstack-copilot skill." },
		vocabulary: "mappings/terms.json",
		skillFrontmatter: "mappings/skills.json",
		models: "mappings/models.json",
		features: "mappings/features.json",
		overlays: "overlays",
		matrix: "skills/pstack-copilot/COMPATIBILITY.md",
		install: { skills: "skills/", agents: "com.github.copilot/agents/", instructions: "com.github.copilot/rules/" },
	}, null, "\t"));
	write(dir, "mappings/terms.json", JSON.stringify({ terms: [{ key: "`/loop`", pattern: "/loop\\b", flags: "" }] }));
	write(dir, "mappings/skills.json", JSON.stringify({ allowedKeys: ["argument-hint"], skills: { alpha: { "argument-hint": "<task>" } } }));
	write(dir, "mappings/agents.json", JSON.stringify({ agents: { helper: { drop: ["is_background", "model"], set: { model: "claude-opus-5.5", "reasoning-effort": "xhigh", "user-invocable": false }, why: "test" } } }));
	write(dir, "mappings/models.json", JSON.stringify({ ladder: ["low", "medium", "high", "xhigh"], slugs: [{ pattern: "^claude-opus-5-5-(low|medium|high|xhigh)(-fast)?$", model: "claude-opus-5.5" }], roles: [{ role: "feature, refactoring", cursor: ["claude-opus-5-5-xhigh-fast"] }], panelRoles: [] }));
	const features = [
		{ id: "skill:alpha", kind: "skill", status: "adapted", copilot: "a", validation: "static" },
		{ id: "skill:beta", kind: "skill", status: "native", copilot: "b", validation: "static" },
		{ id: "skill:poteto-mode", kind: "skill", status: "adapted", copilot: "p", validation: "static" },
		{ id: "playbook:feature", kind: "playbook", status: "native", copilot: "f", validation: "static" },
		{ id: "agent:helper", kind: "agent", status: "adapted", copilot: "h", validation: "static" },
		{ id: "script:skills/alpha/scripts/run.sh", kind: "script", status: "native", copilot: "s", validation: "untested" },
		{ id: "term:`Task`", kind: "term", status: "adapted", copilot: "t", validation: "static" },
		{ id: 'term:`environment: "cloud"`', kind: "term", status: "partial", copilot: "c", validation: "static" },
		{ id: "term:~/.cursor/plugins/", kind: "term", status: "adapted", copilot: "p", validation: "static" },
		{ id: "term:Run another pstack skill", kind: "term", status: "adapted", copilot: "r", validation: "static" },
		{ id: "term:`/loop`", kind: "term", status: "partial", copilot: "l", validation: "static" },
		{ id: "automation:benny", kind: "automation", status: "excluded", copilot: "x", validation: "untested" },
		{ id: "copilot-addition:pstack-copilot", kind: "copilot-addition", status: "native", copilot: "a", validation: "static" },
		{ id: "copilot-addition:pstack-instructions", kind: "copilot-addition", status: "native", copilot: "i", validation: "static" },
	];
	write(dir, "mappings/features.json", JSON.stringify({ features }, null, "\t"));
	write(dir, "overlays/skills/pstack-copilot/SKILL.md", ADAPTER_SKILL);
	write(dir, "overlays/com.github.copilot/rules/pstack.instructions.md", '---\napplyTo: "**"\n---\nTest instruction.\n');
}

export interface World {
	readonly upstream: string;
	readonly repo: string;
	readonly home: string;
	readonly paths: Paths;
	readonly env: NodeJS.ProcessEnv;
}

/** A fresh monorepo, upstream, and pair of homes, isolated from the real ones through the manager's environment overrides. */
export function makeWorld(): World {
	const upstream = makeUpstream();
	const repo = tempDir("repo");
	makeAdapter(repo);
	const home = tempDir("home");
	const env = { ...process.env, PSTACK_REPO: repo, PSTACK_HOME: join(home, ".pstack"), COPILOT_HOME: join(home, ".copilot"), PSTACK_DIST: join(repo, "dist") };
	return { upstream, repo, home, paths: resolvePaths(env), env };
}

/** Runs the real CLI entry point and returns its exit code with stdout and stderr together. */
export function cli(world: World, ...args: string[]): { code: number; out: string } {
	const result = spawnSync(join(MANAGER, "bin", "pstack"), args, { env: world.env, encoding: "utf8" });
	return { code: result.status === null ? -1 : result.status, out: `${result.stdout}${result.stderr}` };
}
