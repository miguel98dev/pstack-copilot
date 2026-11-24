import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { remove } from "../lib/fs.ts";
import { GENERATOR } from "./vocabulary.ts";

export interface UpstreamCommit {
	readonly sha: string;
	readonly subject: string;
	readonly author: string;
	readonly date: string;
	/** Files this commit touched under pstack/, with git's own rename detection. */
	readonly files: readonly { readonly status: string; readonly path: string; readonly from?: string }[];
}

export interface UpstreamHistory {
	/** Whether `from` is an ancestor of the fetched commit; null when its history could not be read. */
	readonly ancestor: boolean | null;
	readonly commits: readonly UpstreamCommit[];
}

export interface FetchedUpstream {
	readonly repoRoot: string;
	readonly pstackDir: string;
	readonly repository: string;
	readonly ref: string;
	readonly commit: string;
	readonly committedAt: string;
	readonly tree: string;
	/** Reads upstream history from `from` (a locked commit and its date) to the fetched commit. Best effort. */
	readonly history: (from: { commit: string; committedAt: string }) => UpstreamHistory;
	readonly cleanup: () => void;
}

export interface FetchOptions {
	/** A local checkout: the cursor/plugins root or its `pstack/` folder. Omit to fetch `repository`. */
	readonly source?: string;
	readonly repository: string;
	readonly ref: string;
	readonly path: string;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env }).trim();
}

/** In a partial clone, asking for a missing commit fetches it alone, unconnected to the history. This keeps checks honest. */
const OFFLINE = { GIT_NO_LAZY_FETCH: "1" };

function provenance(repoRoot: string, path: string) {
	return {
		commit: git(repoRoot, ["rev-parse", "HEAD"]),
		committedAt: git(repoRoot, ["log", "-1", "--format=%cI"]),
		tree: git(repoRoot, ["rev-parse", `HEAD:${path}`]),
	};
}

const LOG_FORMAT = "%x1e%H%x1f%an%x1f%aI%x1f%s";

function readHistory(repoRoot: string, path: string, from: { commit: string; committedAt: string }, deepen: boolean): UpstreamHistory {
	const present = () => {
		try {
			git(repoRoot, ["cat-file", "-e", `${from.commit}^{commit}`], OFFLINE);
			return true;
		} catch {
			return false;
		}
	};
	if (!present() && deepen) {
		const since = new Date(new Date(from.committedAt).getTime() - 2 * 86_400_000).toISOString();
		try {
			git(repoRoot, ["fetch", "-q", "--filter=blob:none", `--shallow-since=${since}`, "origin", "HEAD"]);
		} catch {
			/* history stays unreadable and the caller reports it */
		}
	}
	if (!present()) return { ancestor: null, commits: [] };
	let ancestor = false;
	try {
		git(repoRoot, ["merge-base", "--is-ancestor", from.commit, "HEAD"], OFFLINE);
		ancestor = true;
	} catch {
		ancestor = false;
	}
	if (!ancestor) return { ancestor, commits: [] };
	const raw = git(repoRoot, ["log", "--no-merges", "-M", "--name-status", `--format=${LOG_FORMAT}`, `${from.commit}..HEAD`, "--", path]);
	const commits: UpstreamCommit[] = [];
	for (const block of raw.split("\x1e").slice(1).slice(0, 200)) {
		const [head, ...rest] = block.split("\n");
		const [sha, author, date, subject] = head.split("\x1f");
		const files = rest
			.filter((line) => line.trim() !== "")
			.map((line) => {
				const [status, a, b] = line.split("\t");
				const rel = (file: string) => (file.startsWith(`${path}/`) ? file.slice(path.length + 1) : file);
				return status.startsWith("R") ? { status, path: rel(b), from: rel(a) } : { status, path: rel(a) };
			});
		commits.push({ sha, author, date, subject, files });
	}
	return { ancestor, commits };
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
	return { repoRoot, pstackDir, repository, ref: options.ref, ...provenance(repoRoot, options.path), history: (from) => readHistory(repoRoot, options.path, from, false), cleanup: () => {} };
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
			history: (from) => readHistory(repoRoot, options.path, from, true),
			cleanup: () => remove(repoRoot),
		};
	} catch (error) {
		remove(repoRoot);
		throw error;
	}
}
