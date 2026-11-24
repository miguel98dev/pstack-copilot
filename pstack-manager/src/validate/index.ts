import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../build/adapter.ts";
import { copyTree, exists, remove } from "../lib/fs.ts";
import type { UpstreamLock } from "../upstream/lock.ts";
import { verifyTree } from "../upstream/lock.ts";
import { checkAdapterCoverage, checkDeterminism, checkDistProof, checkFeatureCoverage, checkLinks, checkModels, checkSchemas } from "./checks.ts";

export interface CheckResult {
	readonly name: string;
	readonly problems: readonly string[];
	readonly skipped?: string;
}

export interface ValidateInput {
	readonly coreDir: string;
	readonly distDir: string;
	readonly adapter: Adapter;
	readonly lock: UpstreamLock;
	readonly scripts: boolean;
}

function run(name: string, fn: () => string[]): CheckResult {
	try {
		return { name, problems: fn() };
	} catch (error) {
		return { name, problems: [`check crashed: ${(error as Error).message}`] };
	}
}

function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs upstream's own script tests against the built copy of each skill folder, in a scratch folder so installed
 * dependencies never land in the build. A missing runtime is reported as skipped, not as a pass.
 */
export function runScriptTests(distDir: string): CheckResult[] {
	const results: CheckResult[] = [];
	const suites = [
		{
			name: "upstream tests: watch-pr (bun test)",
			skill: "skills/poteto-mode",
			needs: "bun",
			steps: [
				["bun", ["install", "--frozen-lockfile"]],
				["bun", ["test", "watch-pr"]],
			],
		},
		{
			name: "upstream tests: statechart (node --test)",
			skill: "skills/statechart",
			needs: "npm",
			steps: [
				["npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]],
				["node", ["--disable-warning=ExperimentalWarning", "--test", "test/*.test.ts"]],
			],
		},
	] as const;
	for (const suite of suites) {
		if (!exists(join(distDir, suite.skill, "scripts"))) continue;
		if (!hasCommand(suite.needs)) {
			results.push({ name: suite.name, problems: [], skipped: `${suite.needs} is not installed` });
			continue;
		}
		const scratch = mkdtempSync(join(tmpdir(), "pstack-scripts-"));
		try {
			copyTree(join(distDir, suite.skill), scratch);
			const cwd = join(scratch, "scripts");
			const problems: string[] = [];
			for (const [command, args] of suite.steps) {
				try {
					execFileSync(command, [...args], { cwd, stdio: "pipe", encoding: "utf8", timeout: 600_000 });
				} catch (error) {
					const e = error as { stdout?: string; stderr?: string; message: string };
					const tail = `${e.stdout || ""}\n${e.stderr || ""}`.trim().split("\n").slice(-25).join("\n");
					problems.push(`${command} ${args.join(" ")} failed:\n${tail || e.message}`);
					break;
				}
			}
			results.push({ name: suite.name, problems });
		} finally {
			remove(scratch);
		}
	}
	return results;
}

export function validateAll(input: ValidateInput): CheckResult[] {
	const { coreDir, distDir, adapter, lock } = input;
	const results = [
		run("core matches UPSTREAM.lock.json", () => verifyTree(coreDir, lock)),
		run("build is core + declared transforms", () => checkDistProof(coreDir, distDir, adapter, lock)),
		run("build is deterministic", () => checkDeterminism(coreDir, distDir, adapter, lock)),
		run("adapter maps every Cursor term in use", () => checkAdapterCoverage(coreDir, distDir, adapter, lock)),
		run("every upstream feature is traced", () => checkFeatureCoverage(adapter, lock)),
		run("skills, agents, instructions follow Copilot schemas", () => checkSchemas(distDir, adapter)),
		run("relative links resolve inside the build", () => checkLinks(distDir)),
		run("model defaults agree with the adapter skill", () => checkModels(distDir, adapter)),
	];
	return input.scripts ? [...results, ...runScriptTests(distDir)] : results;
}

export function problemsOf(results: readonly CheckResult[]): string[] {
	return results.flatMap((result) => result.problems.map((problem) => `[${result.name}] ${problem}`));
}
