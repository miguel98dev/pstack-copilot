import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
	readonly code: number;
	readonly out: string;
	readonly err: string;
}

/** Runs git and returns its exit code and output instead of throwing. */
export function run(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): GitResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
	return { code: result.status === null ? -1 : result.status, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

/** Runs git and returns trimmed stdout, throwing with git's message when it fails. */
export function out(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function isRepoRoot(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

/** Paths under `paths` with uncommitted changes, including untracked files. */
export function dirtyPaths(repo: string, paths: readonly string[]): string[] {
	const result = run(repo, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
	if (result.code !== 0) return [];
	return result.out === "" ? [] : result.out.split("\n").map((line) => line.slice(3));
}

export function currentBranch(repo: string): string {
	return out(repo, "rev-parse", "--abbrev-ref", "HEAD");
}

export function conflictedFiles(repo: string): string[] {
	const result = run(repo, ["diff", "--name-only", "--diff-filter=U"]);
	return result.out === "" ? [] : result.out.split("\n");
}
