import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remove } from "../lib/fs.ts";
import { currentBranch, isRepoRoot, run } from "../lib/git.ts";
import type { Paths } from "../paths.ts";
import { runSync, type SyncOptions, type SyncOutcome } from "./pipeline.ts";
import { renderPrBody } from "./report.ts";
import { type RollbackOptions, type RollbackOutcome, rollbackSync } from "./rollback.ts";
import { countChanges } from "./diff.ts";
import { countByAction } from "./impact.ts";

export interface PublishOptions {
	readonly sync: SyncOptions;
	/** Branch the pull request targets. Default: the branch that is checked out. */
	readonly base?: string;
	readonly remote?: string;
	readonly push?: boolean;
	/** The GitHub CLI binary. Default: the PSTACK_GH environment variable, then `gh`. */
	readonly gh?: string;
	readonly author?: { readonly name: string; readonly email: string };
}

export type PublishAction = "none" | "pull-request" | "issue" | "dry-run";

export interface PublishOutcome {
	readonly sync: SyncOutcome;
	readonly action: PublishAction;
	readonly branch?: string;
	readonly pullRequest?: string;
	readonly draft?: boolean;
	readonly issue?: string;
	readonly note?: string;
}

const LABELS: Record<string, { color: string; description: string }> = {
	"upstream-sync": { color: "1d76db", description: "Synchronization with upstream pstack" },
	"needs-adapter-work": { color: "d93f0b", description: "The Copilot adaptation needs a human before this can merge" },
	"sync-conflict": { color: "b60205", description: "An upstream sync stopped on a conflict" },
};

function ghRun(binary: string, cwd: string, args: readonly string[]) {
	const result = spawnSync(binary, args, { cwd, encoding: "utf8" });
	return { code: result.status === null ? -1 : result.status, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

export function branchFor(commit: string): string {
	return `sync/upstream-${commit.slice(0, 12)}`;
}

function title(outcome: SyncOutcome): string {
	const { lock, previous } = outcome.analysis;
	return `chore(sync): pstack ${previous ? `${previous.version} to ${lock.version}` : lock.version} (${lock.commit.slice(0, 12)})`;
}

function bodyFile(dir: string, text: string): string {
	const file = join(dir, "body.md");
	writeFileSync(file, text);
	return file;
}

function ensureLabels(binary: string, cwd: string, names: readonly string[]): void {
	for (const name of names) {
		const label = LABELS[name];
		ghRun(binary, cwd, ["label", "create", name, "--force", "--color", label.color, "--description", label.description]);
	}
}

function json<T>(text: string, fallback: T): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

interface Proposal {
	readonly branch: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
	readonly commitMessage: string;
	readonly labels: readonly string[];
	readonly draft: boolean;
}

/**
 * Moves the working-tree changes onto a branch, commits them, pushes, and opens or updates the pull request.
 * The base branch is checked out again at the end and holds none of the changes.
 */
function propose(repo: string, binary: string, options: Pick<PublishOptions, "remote" | "push" | "author">, scratch: string, proposal: Proposal): { url: string } {
	const remote = options.remote || "origin";
	const identity = options.author ? ["-c", `user.name=${options.author.name}`, "-c", `user.email=${options.author.email}`] : [];
	const switched = run(repo, ["switch", "-C", proposal.branch]);
	if (switched.code !== 0) throw new Error(`git switch -C ${proposal.branch} failed: ${switched.err}`);
	try {
		run(repo, ["add", "-A", "pstack-core", "pstack-copilot", "docs/sync"]);
		const committed = run(repo, [...identity, "commit", "-q", "-m", proposal.commitMessage]);
		if (committed.code !== 0) throw new Error(`git commit failed: ${committed.err}`);
		if (options.push !== false) {
			const pushed = run(repo, ["push", "--force-with-lease", "-u", remote, proposal.branch]);
			if (pushed.code !== 0) throw new Error(`git push failed: ${pushed.err}`);
		}
		ensureLabels(binary, repo, proposal.labels);
		const body = bodyFile(scratch, proposal.body);
		const open = json<{ number: number; url: string }[]>(ghRun(binary, repo, ["pr", "list", "--head", proposal.branch, "--state", "open", "--json", "number,url"]).out, []);
		let url: string;
		if (open.length > 0) {
			const edited = ghRun(binary, repo, ["pr", "edit", String(open[0].number), "--title", proposal.title, "--body-file", body]);
			if (edited.code !== 0) throw new Error(`gh pr edit failed: ${edited.err}`);
			url = open[0].url;
		} else {
			const created = ghRun(binary, repo, ["pr", "create", "--base", proposal.base, "--head", proposal.branch, "--title", proposal.title, "--body-file", body, ...proposal.labels.flatMap((label) => ["--label", label]), ...(proposal.draft ? ["--draft"] : [])]);
			if (created.code !== 0) throw new Error(`gh pr create failed: ${created.err}`);
			url = created.out.split("\n").pop() as string;
		}
		const others = json<{ number: number; headRefName: string }[]>(ghRun(binary, repo, ["pr", "list", "--label", "upstream-sync", "--state", "open", "--json", "number,headRefName"]).out, []);
		for (const other of others) {
			if (other.headRefName !== proposal.branch && other.headRefName.startsWith("sync/upstream-")) ghRun(binary, repo, ["pr", "comment", String(other.number), "--body", `A newer upstream state is proposed in ${url}. Review that one, then close this one.`]);
		}
		return { url };
	} finally {
		run(repo, ["switch", proposal.base]);
	}
}

/**
 * Runs a sync and puts the result in front of a reviewer: a branch and a pull request when pstack changed, an
 * issue when a conflict stopped the sync. It never merges, never enables auto-merge, and leaves the base
 * branch exactly as it found it.
 */
export function publishSync(paths: Paths, options: PublishOptions): PublishOutcome {
	const repo = paths.repoRoot;
	if (!isRepoRoot(repo)) throw new Error("publishing needs the pstack repository as a git checkout");
	const binary = options.gh || process.env.PSTACK_GH || "gh";
	const base = options.base || currentBranch(repo);
	if (base === "HEAD") throw new Error("check out the branch the pull request should target; HEAD is detached");

	const outcome = runSync(paths, { ...options.sync, prepare: true });
	const scratch = mkdtempSync(join(tmpdir(), "pstack-publish-"));
	try {
		if (outcome.status === "unchanged") return { sync: outcome, action: "none", note: "pstack has not changed upstream" };
		if (outcome.status === "dry-run") return { sync: outcome, action: "dry-run" };

		if (outcome.status === "conflict" || outcome.status === "blocked") {
			const conflicts = outcome.analysis.conflicts.filter((conflict) => conflict.severity === "blocking");
			if (conflicts.length > 0 && conflicts.every((conflict) => conflict.kind === "previously-rolled-back")) return { sync: outcome, action: "none", note: "a reviewer already rolled this upstream state back" };
			const heading = `Upstream sync blocked: pstack ${outcome.analysis.lock.version} (${outcome.analysis.lock.commit.slice(0, 12)})`;
			ensureLabels(binary, repo, ["upstream-sync", "sync-conflict"]);
			const existing = json<{ number: number; url: string }[]>(ghRun(binary, repo, ["issue", "list", "--state", "open", "--label", "sync-conflict", "--search", `"${outcome.analysis.lock.commit.slice(0, 12)}" in:title`, "--json", "number,url"]).out, []);
			if (existing.length > 0) return { sync: outcome, action: "issue", issue: existing[0].url, note: "an open issue already tracks this upstream commit" };
			const created = ghRun(binary, repo, ["issue", "create", "--title", heading, "--body-file", bodyFile(scratch, renderPrBody(outcome.report, undefined)), "--label", "upstream-sync", "--label", "sync-conflict"]);
			if (created.code !== 0) throw new Error(`gh issue create failed: ${created.err}`);
			return { sync: outcome, action: "issue", issue: created.out.split("\n").pop() };
		}

		const branch = branchFor(outcome.analysis.lock.commit);
		const draft = outcome.status === "needs-adapter-work";
		const counts = countChanges(outcome.analysis.diff);
		const actions = countByAction(outcome.analysis.impact);
		const proposed = propose(repo, binary, options, scratch, {
			branch,
			base,
			title: title(outcome),
			body: renderPrBody(outcome.report, outcome.reportPath || undefined),
			commitMessage: `${title(outcome)}\n\nUpstream ${outcome.analysis.lock.repository} at ${outcome.analysis.lock.commit}.\n${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.renamed} renamed. ${actions.manual} adaptations need a human, ${actions.review} to review.\nStatus: ${outcome.status}. Report: ${outcome.reportPath}.`,
			labels: ["upstream-sync", ...(draft ? ["needs-adapter-work"] : [])],
			draft,
		});
		return { sync: outcome, action: "pull-request", branch, pullRequest: proposed.url, draft };
	} finally {
		remove(scratch);
	}
}

export interface RollbackPublishOutcome {
	readonly rollback: RollbackOutcome;
	readonly pullRequest?: string;
	readonly branch?: string;
}

/** Reverts the newest sync and opens a pull request with the revert, so a rollback is reviewed like the sync was. */
export function publishRollback(paths: Paths, rollback: RollbackOptions, options: Omit<PublishOptions, "sync">): RollbackPublishOutcome {
	const repo = paths.repoRoot;
	const binary = options.gh || process.env.PSTACK_GH || "gh";
	const base = options.base || currentBranch(repo);
	const result = rollbackSync(paths, { ...rollback, commit: false, dryRun: false });
	if (result.status !== "reverted") return { rollback: result };
	const scratch = mkdtempSync(join(tmpdir(), "pstack-publish-"));
	try {
		const branch = `rollback/upstream-${result.target.to.commit.slice(0, 12)}`;
		const heading = `revert(sync): restore pstack ${result.target.from ? result.target.from.version : ""} (${result.target.from ? result.target.from.commit.slice(0, 12) : ""})`;
		const body = `Rolls back the sync of upstream \`${result.target.to.commit}\` (pstack ${result.target.to.version}), which arrived in \`${result.syncCommit}\`.\n\nThe revert restores pstack-core, the lock, the mapping files, and the history together, and marks the sync as rolled back. That upstream commit is not proposed again until upstream moves on.\n\nNever merged by automation. A person reviews and merges.\n`;
		const proposed = propose(repo, binary, options, scratch, { branch, base, title: heading, body, commitMessage: `${heading}\n\nReverts ${result.syncCommit}.`, labels: ["upstream-sync"], draft: false });
		return { rollback: result, pullRequest: proposed.url, branch };
	} finally {
		remove(scratch);
	}
}
