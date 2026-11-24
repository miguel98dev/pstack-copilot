import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { remove } from "../lib/fs.ts";
import { GENERATOR } from "./vocabulary.ts";

export interface FetchedUpstream {
	readonly repoRoot: string;
	readonly pstackDir: string;
	readonly repository: string;
	readonly ref: string;
	readonly commit: string;
	readonly committedAt: string;
	readonly tree: string;
	readonly cleanup: () => void;
}

export interface FetchOptions {
	/** A local checkout: the cursor/plugins root or its `pstack/` folder. Omit to fetch `repository`. */
	readonly source?: string;
	readonly repository: string;
	readonly ref: string;
	readonly path: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function provenance(repoRoot: string, path: string) {
	return {
		commit: git(repoRoot, ["rev-parse", "HEAD"]),
		committedAt: git(repoRoot, ["log", "-1", "--format=%cI"]),
		tree: git(repoRoot, ["rev-parse", `HEAD:${path}`]),
	};
}

export function fetchUpstream(options: FetchOptions): FetchedUpstream {
	return options.source ? fromLocal(options) : fromRemote(options);
}

function fromLocal(options: FetchOptions): FetchedUpstream {
	const source = resolve(options.source as string);
	const repoRoot = existsSync(join(source, options.path, "plugin.json")) ? source : dirname(source);
	const pstackDir = join(repoRoot, options.path);
	if (!existsSync(join(pstackDir, "plugin.json"))) throw new Error(`no ${options.path}/plugin.json under ${source}`);
	const dirty = git(repoRoot, ["status", "--porcelain", "--", options.path, GENERATOR]);
	if (dirty) throw new Error(`local upstream checkout has uncommitted changes, so its files do not match a commit:\n${dirty}`);
	let repository = repoRoot;
	try {
		repository = git(repoRoot, ["remote", "get-url", "origin"]);
	} catch {
		repository = repoRoot;
	}
	return { repoRoot, pstackDir, repository, ref: options.ref, ...provenance(repoRoot, options.path), cleanup: () => {} };
}

function fromRemote(options: FetchOptions): FetchedUpstream {
	const repoRoot = mkdtempSync(join(tmpdir(), "pstack-upstream-"));
	try {
		git(repoRoot, ["init", "-q"]);
		git(repoRoot, ["remote", "add", "origin", options.repository]);
		git(repoRoot, ["config", "core.sparseCheckout", "true"]);
		writeFileSync(join(repoRoot, ".git", "info", "sparse-checkout"), `/${options.path}/\n/${GENERATOR}\n`);
		git(repoRoot, ["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", options.ref]);
		git(repoRoot, ["checkout", "-q", "FETCH_HEAD"]);
		return {
			repoRoot,
			pstackDir: join(repoRoot, options.path),
			repository: options.repository,
			ref: options.ref,
			...provenance(repoRoot, options.path),
			cleanup: () => remove(repoRoot),
		};
	} catch (error) {
		remove(repoRoot);
		throw error;
	}
}
