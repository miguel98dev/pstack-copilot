import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths, print } from "../cli.ts";
import { readManifest } from "../build/engine.ts";
import { exists, isSymlink, linkTarget, sha256 } from "../lib/fs.ts";
import { readState } from "../install/state.ts";
import { currentLink, versionsDir } from "../install/user.ts";
import { WORKSPACE_LOCK } from "../install/workspace.ts";

type Level = "OK" | "WARN" | "FAIL";

/** First line a tool prints for its version, from stdout or stderr (java prints to stderr), or null when absent. */
function version(command: string, args = ["--version"]): string | null {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
	return `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n")[0] || null;
}

const TOOLS: readonly { command: string; args?: string[]; level: Level; why: string }[] = [
	{ command: "git", level: "FAIL", why: "every playbook, worktrees, and pstack upstream sync" },
	{ command: "gh", level: "WARN", why: "babysit, shipping, opening-a-pr, why, recall, and watch-pr" },
	{ command: "bun", level: "WARN", why: "the watch-pr script used by babysit and shipping" },
	{ command: "npm", level: "WARN", why: "the statechart script's test dependencies and Pele rendering" },
	{ command: "mise", level: "WARN", why: "statechart, which installs Java and TLC through it" },
	{ command: "java", args: ["-version"], level: "WARN", why: "statechart's TLC model checker" },
	{ command: "rg", level: "WARN", why: "worktree-audit.sh" },
];

/** Diagnoses what limits pstack on this machine: runtimes, the installed copy, and conflicts with other skill sources. */
export function doctor(): number {
	const p = paths();
	const lines: [Level, string][] = [];
	const add = (level: Level, text: string) => lines.push([level, text]);

	const [major, minor] = process.versions.node.split(".").map(Number);
	add(major > 22 || (major === 22 && minor >= 18) ? "OK" : "FAIL", `node ${process.versions.node} (needs 22.18+)`);
	for (const tool of TOOLS) {
		const found = version(tool.command, tool.args);
		if (!found) add(tool.level, `${tool.command} not found; needed by ${tool.why}`);
		else if (tool.command === "java" && /version "1\.[0-8]\.|version "(?:9|10)[".]/.test(found)) add("WARN", `${tool.command}: ${found}; TLC needs Java 11 or later, so statechart installs its own through mise`);
		else add("OK", `${tool.command}: ${found}`);
	}

	add(exists(p.copilotHome) ? "OK" : "FAIL", `Copilot home ${p.copilotHome}${exists(p.copilotHome) ? "" : " is missing"}`);
	const state = readState(p);
	const current = currentLink(p);
	if (!state.active) add("WARN", "pstack is not installed for this user (pstack install)");
	else if (!isSymlink(current) || !exists(current)) add("FAIL", `${current} is missing or dangling; run pstack rollback ${state.active}`);
	else {
		const dir = join(versionsDir(p), state.active);
		const manifest = readManifest(dir);
		const edited = manifest.files.filter((file) => !exists(join(dir, file.path)) || sha256(readFileSync(join(dir, file.path))) !== file.sha256).map((file) => file.path);
		add(edited.length === 0 ? "OK" : "FAIL", edited.length === 0 ? `installed ${state.active} matches its build manifest (${manifest.files.length} files)` : `installed copy was edited: ${edited.slice(0, 5).join(", ")}; reinstall with pstack install --force`);
		const links = state.user ? state.user.links : [];
		const dangling = links.filter((link) => !exists(link));
		add(dangling.length === 0 ? "OK" : "FAIL", `${links.length} Copilot links, ${dangling.length} dangling`);
		if (state.user && state.user.skipped.length > 0) add("WARN", `paths owned by something else, so pstack did not link them: ${state.user.skipped.join(", ")}`);
		const ours = new Set(links.filter((link) => link.includes(`${join(p.copilotHome, "skills")}/`)).map((link) => link.split("/").pop() as string));

		const configFile = join(p.copilotHome, "config.json");
		if (exists(configFile)) {
			try {
				const raw = readFileSync(configFile, "utf8").replace(/^\s*\/\/.*$/gm, "");
				const plugins = ((JSON.parse(raw) as { installedPlugins?: { name: string; enabled?: boolean; cache_path?: string }[] }).installedPlugins || []);
				for (const plugin of plugins) {
					const skillsDir = plugin.cache_path ? join(plugin.cache_path, "skills") : "";
					const overlap = skillsDir && exists(skillsDir) ? readdirSync(skillsDir).filter((name) => ours.has(name)) : [];
					if (overlap.length > 0) add(plugin.enabled ? "FAIL" : "WARN", `plugin ${plugin.name} (${plugin.enabled ? "enabled" : "disabled"}) also ships ${overlap.length} pstack skill names, e.g. ${overlap.slice(0, 3).join(", ")}${plugin.enabled ? "; disable it so each name loads once" : ""}`);
				}
			} catch (error) {
				add("WARN", `could not read ${configFile}: ${(error as Error).message}`);
			}
		}
		const agentsSkills = join(process.env.HOME || "", ".agents", "skills");
		if (exists(agentsSkills)) {
			const overlap = readdirSync(agentsSkills).filter((name) => ours.has(name));
			if (overlap.length > 0) add("WARN", `~/.agents/skills also has ${overlap.join(", ")}; both copies load`);
		}
		const lockHere = join(process.cwd(), WORKSPACE_LOCK);
		if (exists(lockHere)) add("WARN", `this repository also has a workspace install (${WORKSPACE_LOCK}); each pstack skill loads twice here`);
	}

	const models = join(p.copilotHome, "instructions", "pstack-models.instructions.md");
	add(exists(models) ? "OK" : "WARN", exists(models) ? `model roles: ${models}` : "no pstack-models instruction; roles use the Copilot defaults (run /setup-pstack or pstack models init)");
	const legacy = join(p.copilotHome, "pstack-models.md");
	if (exists(legacy)) add("WARN", `${legacy} from another Copilot port exists; /setup-pstack reads it as an older setup, and Copilot does not load it by itself`);
	const instructions = join(p.copilotHome, "instructions");
	if (exists(instructions)) {
		for (const name of readdirSync(instructions)) {
			const path = join(instructions, name);
			if (isSymlink(path) && !exists(path)) add("FAIL", `dangling instruction link ${path} -> ${linkTarget(path)}`);
		}
	}
	for (const [level, text] of lines) print(`${level.padEnd(4)} ${text}`);
	return lines.some(([level]) => level === "FAIL") ? 1 : 0;
}
