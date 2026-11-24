import { join, resolve } from "node:path";
import { options, paths, print, warn } from "../cli.ts";
import { buildProject, loadProject } from "../build/project.ts";
import { exists, isSymlink, linkTarget } from "../lib/fs.ts";
import type { Paths } from "../paths.ts";
import { activate, currentLink, deactivate, installedVersions, storeVersion } from "../install/user.ts";
import { readState } from "../install/state.ts";
import { installWorkspace, uninstallWorkspace } from "../install/workspace.ts";
import { failedChecks } from "../upstream/analysis.ts";
import { runSync } from "../upstream/pipeline.ts";
import { problemsOf, validateAll } from "../validate/index.ts";

/** Builds the current project and refuses to go further unless every check passes. */
function buildValidated(p: Paths, adapterId: string, scripts: boolean): string {
	const result = buildProject(p, adapterId);
	const project = loadProject(p, adapterId);
	const problems = problemsOf(validateAll({ coreDir: p.coreUpstream, distDir: result.outDir, adapter: project.adapter, lock: project.lock, scripts }));
	if (problems.length > 0) throw new Error(`build ${result.version} failed validation, nothing installed:\n${problems.join("\n")}`);
	return result.outDir;
}

function report(prefix: string, items: readonly string[]): void {
	if (items.length === 0) return;
	warn(`${prefix} (${items.length}):`);
	for (const item of items) warn(`  ${item}`);
}

export function install(args: string[]): number {
	const { values } = options(args, {
		adapter: { type: "string" },
		scope: { type: "string" },
		repo: { type: "string" },
		force: { type: "boolean" },
		"skip-scripts": { type: "boolean" },
	});
	const p = paths();
	const scope = values.scope || "user";
	const distDir = buildValidated(p, values.adapter || "copilot", !values["skip-scripts"]);
	if (scope === "workspace") {
		const repo = resolve(values.repo || process.cwd());
		const result = installWorkspace(repo, distDir, Boolean(values.force));
		print(`installed pstack ${result.version} into ${repo}/.github: ${result.written.length} files written, ${result.removed.length} stale files removed`);
		report("kept because you changed them", result.kept);
		report("skipped because they are not pstack's (use --force)", result.skipped);
		print("Commit .github/skills, .github/agents, .github/instructions, and .github/pstack-install.json to share it.");
		return 0;
	}
	if (scope !== "user") throw new Error(`scope must be user or workspace, not ${scope}`);
	const stored = storeVersion(p, distDir, Boolean(values.force));
	const result = activate(p, stored.version, Boolean(values.force));
	print(`installed pstack ${stored.version}${stored.reused ? " (already stored)" : ""} at ${stored.dir}`);
	print(`${result.links.length} links in ${p.copilotHome} point through ${currentLink(p)}`);
	report("left alone because something else owns the path (use --force to back it up and replace it)", result.skipped);
	report("backed up", result.backedUp);
	print("Start a new chat (VS Code) or session (Copilot CLI) to load it. Run /setup-pstack or `pstack models init` to choose models.");
	return 0;
}

export function uninstall(args: string[]): number {
	const { values } = options(args, { scope: { type: "string" }, repo: { type: "string" } });
	const p = paths();
	if ((values.scope || "user") === "workspace") {
		const repo = resolve(values.repo || process.cwd());
		const result = uninstallWorkspace(repo);
		print(`removed ${result.removed.length} pstack files from ${repo}/.github`);
		report("kept because you changed them", result.kept);
		return 0;
	}
	const removed = deactivate(p);
	print(`removed ${removed.length} links and the current pointer. Stored versions stay in ${join(p.pstackHome, "versions")}.`);
	return 0;
}

export function update(args: string[]): number {
	const { values } = options(args, {
		adapter: { type: "string" },
		ref: { type: "string" },
		source: { type: "string" },
		repository: { type: "string" },
		force: { type: "boolean" },
		"skip-scripts": { type: "boolean" },
	});
	const p = paths();
	const adapterId = values.adapter || "copilot";
	const sync = runSync(p, { source: values.source, ref: values.ref, repository: values.repository, adapterId, trigger: "local" });
	if (sync.status === "conflict" || sync.status === "blocked") {
		warn(`upstream ${sync.analysis.lock.version} (${sync.analysis.lock.commit.slice(0, 12)}) cannot be installed yet. Your installed version is unchanged.`);
		for (const conflict of sync.analysis.conflicts.filter((c) => c.severity === "blocking")) warn(`  - ${conflict.kind}: ${conflict.message}`);
		for (const check of failedChecks(sync.analysis)) warn(`  - failing check: ${check}`);
		return 1;
	}
	print(`upstream: ${sync.status} (${sync.analysis.lock.version} at ${sync.analysis.lock.commit.slice(0, 12)})`);
	const before = readState(p).active;
	const distDir = buildValidated(p, adapterId, !values["skip-scripts"]);
	const stored = storeVersion(p, distDir, Boolean(values.force));
	const result = activate(p, stored.version, Boolean(values.force));
	print(before === stored.version ? `already on ${stored.version}; links refreshed (${result.links.length})` : `updated ${before || "nothing"} -> ${stored.version}. Roll back with: pstack rollback ${before || ""}`.trim());
	report("left alone because something else owns the path", result.skipped);
	return 0;
}

export function rollback(args: string[]): number {
	const { values, positionals } = options(args, { force: { type: "boolean" } });
	const p = paths();
	const state = readState(p);
	const target = positionals[0] || state.history[state.history.length - 1];
	if (!target) throw new Error("no earlier version to roll back to");
	const result = activate(p, target, Boolean(values.force));
	print(`active version: ${target} (was ${state.active || "none"}); ${result.links.length} links`);
	report("left alone because something else owns the path", result.skipped);
	return 0;
}

export function status(): number {
	const p = paths();
	const state = readState(p);
	const current = currentLink(p);
	print(`pstack home: ${p.pstackHome}`);
	print(`active: ${state.active || "none"}${isSymlink(current) ? ` -> ${linkTarget(current)}` : ""}`);
	if (state.user) {
		const dangling = state.user.links.filter((link) => !exists(link));
		print(`links: ${state.user.links.length} in ${p.copilotHome} (${dangling.length} dangling)`);
		for (const link of dangling) warn(`  dangling: ${link}`);
		if (state.user.skipped.length > 0) print(`left alone: ${state.user.skipped.join(", ")}`);
	}
	const models = join(p.copilotHome, "instructions", "pstack-models.instructions.md");
	print(`models: ${exists(models) ? models : "not configured; roles use the Copilot defaults (run /setup-pstack or pstack models init)"}`);
	print(`history: ${state.history.join(" -> ") || "none"}`);
	return 0;
}

export function versions(): number {
	const p = paths();
	const state = readState(p);
	const all = installedVersions(p);
	if (all.length === 0) print("no stored versions");
	for (const version of all) print(`${version === state.active ? "*" : " "} ${version}`);
	return 0;
}
