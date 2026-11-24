import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
		watch: [{ upstream: ["skills/beta/**"], adaptation: ["skills/pstack-copilot/SKILL.md"], why: "The adapter skill mentions beta." }],
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

/** A fake `gh` that records every call and keeps pull requests and issues in a JSON file, so tests can read what a run opened. */
export function makeFakeGh(dir: string): { bin: string; log: string; state: string; calls: () => string[][] } {
	const bin = join(dir, "gh");
	const log = join(dir, "gh.log");
	const state = join(dir, "gh-state.json");
	write(dir, "gh", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const file = process.env.GH_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { prs: [], issues: [] };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const [area, verb] = args;
if (area === "pr" && verb === "list") {
  const head = flag("--head");
  const rows = state.prs.filter((p) => !head || p.head === head).map((p) => ({ number: p.number, url: p.url, headRefName: p.head }));
  console.log(JSON.stringify(rows));
} else if (area === "pr" && verb === "create") {
  const number = state.prs.length + 1;
  const url = "https://example.test/pull/" + number;
  state.prs.push({ number, url, head: flag("--head"), base: flag("--base"), title: flag("--title"), body: fs.readFileSync(flag("--body-file"), "utf8"), draft: args.includes("--draft"), labels: args.flatMap((a, i) => (a === "--label" ? [args[i + 1]] : [])) });
  save();
  console.log(url);
} else if (area === "pr" && verb === "edit") {
  const pr = state.prs.find((p) => String(p.number) === args[2]);
  pr.title = flag("--title"); pr.body = fs.readFileSync(flag("--body-file"), "utf8"); save();
} else if (area === "issue" && verb === "list") {
  console.log(JSON.stringify(state.issues.map((i) => ({ number: i.number, url: i.url }))));
} else if (area === "issue" && verb === "create") {
  const number = state.issues.length + 1;
  const url = "https://example.test/issues/" + number;
  state.issues.push({ number, url, title: flag("--title"), body: fs.readFileSync(flag("--body-file"), "utf8"), labels: args.flatMap((a, i) => (a === "--label" ? [args[i + 1]] : [])) });
  save();
  console.log(url);
} else { console.log("[]"); }
`, 0o755);
	return {
		bin,
		log,
		state,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []),
	};
}

export function readState(file: string): { prs: { number: number; url: string; head: string; base: string; title: string; body: string; draft: boolean; labels: string[] }[]; issues: { number: number; url: string; title: string; body: string; labels: string[] }[] } {
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { prs: [], issues: [] };
}

export interface GitWorld extends World {
	readonly remote: string;
	readonly gh: ReturnType<typeof makeFakeGh>;
}

/**
 * A monorepo that is a real git checkout with the first sync already committed on `main` and a bare remote, so
 * branches, pull requests, conflicts, and rollbacks run against real git. The CLI uses a fake `gh`.
 */
export function makeGitWorld(): GitWorld {
	const world = makeWorld();
	write(world.repo, ".gitignore", "dist/\n.staging-*/\n.previous-*/\n");
	git(world.repo, "init", "-q", "-b", "main");
	git(world.repo, "config", "user.email", "test@example.com");
	git(world.repo, "config", "user.name", "test");
	git(world.repo, "add", "-A");
	git(world.repo, "commit", "-q", "-m", "add the adapter");
	const tools = tempDir("gh");
	const gh = makeFakeGh(tools);
	const env = { ...world.env, PSTACK_GH: gh.bin, GH_LOG: gh.log, GH_STATE: gh.state };
	const made: World = { ...world, env };
	const first = cli(made, "upstream", "sync", "--source", world.upstream, "--trigger", "test");
	if (first.code !== 0) throw new Error(`initial sync failed: ${first.out}`);
	git(world.repo, "add", "-A");
	git(world.repo, "commit", "-q", "-m", "initial sync");
	const remote = tempDir("remote");
	git(remote, "init", "-q", "--bare", "-b", "main");
	git(world.repo, "remote", "add", "origin", remote);
	git(world.repo, "push", "-q", "-u", "origin", "main");
	return { ...made, remote, gh };
}

/** One upstream commit that touches every kind of change: modify, add, delete, exact rename, edited rename, and a version bump. */
export function evolveUpstream(root: string, version = "1.1.0"): void {
	const plugin = JSON.parse(readFileSync(join(root, "pstack/plugin.json"), "utf8"));
	write(root, "pstack/plugin.json", JSON.stringify({ ...plugin, version }, null, "\t"));
	write(root, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta is plain. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nNothing platform-specific here, and now it says a bit more.\n");
	write(root, "pstack/skills/gamma/SKILL.md", "---\nname: gamma\ndescription: Gamma is new. Use for /gamma.\ndisable-model-invocation: true\n---\n\n# Gamma\n\nRun a loop with the `/loop` command.\n");
	write(root, "pstack/agents/scout.md", "---\nname: scout\ndescription: A new read-only delegate.\nis_background: true\nmodel: claude-opus-5-5-high-fast\n---\n\n# Scout\n\nLook around and report.\n");
	git(root, "mv", "pstack/skills/alpha/scripts/run.sh", "pstack/skills/alpha/scripts/exec.sh");
	git(root, "mv", "pstack/skills/poteto-mode/playbooks/feature.md", "pstack/skills/poteto-mode/playbooks/build.md");
	write(root, "pstack/skills/poteto-mode/playbooks/build.md", "### Feature\n\nBuild it.\n\nVerify it.\n");
	write(root, "pstack/README.md", "# pstack\n\nSee [alpha](./skills/alpha/SKILL.md) and [the guide](./docs/guide/README.md).\n");
	git(root, "rm", "-q", "pstack/automations/benny/README.md");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "evolve pstack");
}
