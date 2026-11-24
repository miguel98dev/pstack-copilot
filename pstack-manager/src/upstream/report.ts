import { countByAction, type Action } from "./impact.ts";
import { countChanges, type FileChange } from "./diff.ts";
import { type Analysis, failedChecks, type SyncStatus, validationPassed } from "./analysis.ts";

export interface ReportContext {
	readonly status: SyncStatus;
	readonly trigger: string;
	readonly date: string;
	readonly repository: string;
	/** Repository-relative path of the committed report, when there is one. */
	readonly reportPath?: string;
	readonly adapterRevision?: { readonly before: number; readonly after: number };
	readonly runUrl?: string;
}

const MAX_FILE_ROWS = 300;
const MAX_LINES = 40;

function short(sha: string): string {
	return sha.slice(0, 12);
}

function compareUrl(repository: string, from: string, to: string): string | null {
	const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(repository);
	return match ? `https://github.com/${match[1]}/compare/${from}...${to}` : null;
}

function fileRow(change: FileChange): string {
	const mode = change.kind === "mode-changed" || (change.oldMode && change.newMode && change.oldMode !== change.newMode) ? ` (mode ${change.oldMode} to ${change.newMode})` : "";
	if (change.kind === "renamed") return `| renamed | \`${change.from}\` | \`${change.path}\` | ${Math.round((change.similarity || 1) * 100)}% similar${mode} |`;
	return `| ${change.kind} | \`${change.path}\` | | ${mode.trim()} |`;
}

const ACTION_TITLE: Record<Action, string> = {
	manual: "Needs a human before merging",
	review: "Review: upstream changed what the adaptation depends on",
	migrated: "Prepared by the sync, check the diff",
	automatic: "Handled by the build",
};

const ORDER: Action[] = ["manual", "review", "migrated", "automatic"];

export function statusLine(status: SyncStatus): string {
	switch (status) {
		case "unchanged": return "No change in pstack. Nothing to sync.";
		case "dry-run": return "Dry run. Nothing was written.";
		case "conflict": return "Blocked by conflicts. Nothing was written.";
		case "blocked": return "Blocked: the migrated adapter fails validation. Nothing was written.";
		case "prepared": return "Ready for review. The migrated adapter passes every check.";
		case "needs-adapter-work": return "Needs adapter work. The core is updated and the checks listed below fail until a human finishes the Copilot side.";
	}
}

export function renderReport(analysis: Analysis, context: ReportContext): string {
	const { lock, previous, diff, impact, conflicts, upstream, migration } = analysis;
	const counts = countChanges(diff);
	const actions = countByAction(impact);
	const link = previous ? compareUrl(lock.repository, previous.commit, lock.commit) : null;
	let out = `# Upstream sync: pstack ${previous ? `${previous.version} to ${lock.version}` : lock.version}\n\n`;
	out += `${statusLine(context.status)}\n\n`;
	out += "| | |\n| --- | --- |\n";
	out += `| Upstream | ${lock.repository.replace(/\.git$/, "")}, \`${lock.path}/\` |\n`;
	out += `| Commit | ${previous ? `\`${short(previous.commit)}\` to ` : ""}\`${lock.commit}\`${link ? ` ([compare](${link}))` : ""} |\n`;
	out += `| Tree | ${previous ? `\`${short(previous.tree)}\` to ` : ""}\`${short(lock.tree)}\` |\n`;
	out += `| Upstream version | ${previous ? `${previous.version} to ` : ""}${lock.version} |\n`;
	if (context.adapterRevision) out += `| Copilot adapter revision | ${context.adapterRevision.before} to ${context.adapterRevision.after} (build \`${lock.version}+copilot.${context.adapterRevision.after}\`) |\n`;
	out += `| Files | ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.renamed} renamed, ${counts["mode-changed"]} mode changes |\n`;
	out += `| Copilot adaptations | ${actions.manual} need a human, ${actions.review} to review, ${actions.migrated} prepared, ${actions.automatic} handled by the build |\n`;
	out += `| Trigger | ${context.trigger}, ${context.date}${context.runUrl ? ` ([run](${context.runUrl}))` : ""} |\n\n`;

	if (conflicts.length > 0) {
		out += "## Conflicts\n\n";
		for (const conflict of conflicts) {
			out += `- **${conflict.severity === "blocking" ? "Blocking" : "Warning"}, ${conflict.kind}.** ${conflict.message}${conflict.override ? ` Override: \`${conflict.override}\`.` : ""}\n`;
			for (const file of conflict.files.slice(0, MAX_LINES)) out += `  - \`${file}\`\n`;
		}
		out += "\n";
	}

	const manual = impact.affected.filter((item) => item.action === "manual");
	if (context.status === "needs-adapter-work" || context.status === "blocked" || manual.length > 0) {
		out += "## What a human has to do\n\n";
		if (manual.length === 0 && validationPassed(analysis)) out += "Nothing is required.\n\n";
		for (const item of manual) out += `- [ ] \`${item.adaptation}\`: ${item.because}\n`;
		for (const check of analysis.validation || []) {
			if (check.problems.length === 0) continue;
			out += `- [ ] Fix the failing check **${check.name}**:\n`;
			for (const problem of check.problems.slice(0, 8)) out += `  - ${problem.split("\n")[0]}\n`;
			if (check.problems.length > 8) out += `  - and ${check.problems.length - 8} more\n`;
		}
		if (analysis.buildError) out += `- [ ] The build stopped: ${analysis.buildError.split("\n")[0]}\n`;
		out += "\nAfter the changes, run `pstack build && pstack validate && npm test`, then `pstack matrix`.\n\n";
	}

	out += "## Changed files\n\n";
	if (diff.changes.length === 0) out += "No file changed. Only upstream's Cursor vocabulary did.\n\n";
	else {
		out += "| Change | Path | New path | Detail |\n| --- | --- | --- | --- |\n";
		for (const change of diff.changes.slice(0, MAX_FILE_ROWS)) out += `${fileRow(change)}\n`;
		if (diff.changes.length > MAX_FILE_ROWS) out += `\n${diff.changes.length - MAX_FILE_ROWS} more files are in the JSON report.\n`;
		out += "\n";
	}

	const items = diff.items;
	if (items.length > 0) {
		out += "## Changed skills, playbooks, agents, scripts, and automations\n\n| Item | Change | Files |\n| --- | --- | --- |\n";
		for (const item of items) out += `| ${item.kind} \`${item.name}\` | ${item.change}${item.from ? ` (was \`${item.from}\`)` : ""} | ${item.files.length} |\n`;
		out += "\n";
	}
	const v = diff.vocabulary;
	if (v.added.length + v.removed.length + v.modified.length > 0) {
		out += "## Cursor vocabulary\n\nUpstream's own list of Cursor-specific names changed.\n\n";
		for (const key of v.added) out += `- added ${key}\n`;
		for (const key of v.removed) out += `- removed ${key}\n`;
		for (const key of v.modified) out += `- pattern changed for ${key}\n`;
		out += "\n";
	}
	if (impact.unitTerms.length > 0) {
		out += "## Cursor names used by each skill or agent\n\n";
		for (const unit of impact.unitTerms) out += `- \`${unit.unit}\`: ${[...unit.added.map((k) => `now uses ${k}`), ...unit.removed.map((k) => `no longer uses ${k}`)].join("; ")}\n`;
		out += "\n";
	}

	if (upstream.commits.length > 0) {
		out += `## Upstream commits that touch pstack (${upstream.commits.length})\n\n`;
		for (const commit of upstream.commits.slice(0, 60)) out += `- \`${short(commit.sha)}\` ${commit.subject} (${commit.author}, ${commit.date.slice(0, 10)}, ${commit.files.length} files)\n`;
		if (upstream.commits.length > 60) out += `- and ${upstream.commits.length - 60} more\n`;
		out += "\n";
	} else if (previous) {
		out += `## Upstream commits\n\n${upstream.ancestor === null ? "Upstream history could not be read back to the locked commit." : "No commit list is available."}\n\n`;
	}

	out += "## Impact on the Copilot adaptation\n\n";
	if (impact.affected.length === 0) out += "No adaptation is affected.\n\n";
	for (const action of ORDER) {
		const rows = impact.affected.filter((item) => item.action === action);
		if (rows.length === 0) continue;
		out += `### ${ACTION_TITLE[action]} (${rows.length})\n\n`;
		for (const item of rows.slice(0, 80)) out += `- \`${item.adaptation}\`: ${item.because}\n`;
		if (rows.length > 80) out += `- and ${rows.length - 80} more\n`;
		out += "\n";
	}
	if (impact.staleValidations.length > 0) out += `VS Code validations now stale: ${impact.staleValidations.map((id) => `\`${id}\``).join(", ")}. Rerun their scenarios in \`tests/e2e\`.\n\n`;

	if (migration) {
		out += "## Migration prepared\n\nOnly mapping data changed: `adapter.json`, `features.json`, `agents.json`, and `skills.json`. Overlays, the adapter skill, `terms.json`, `models.json`, and the docs are custom Copilot work and were not touched.\n\n";
		for (const op of migration.ops.slice(0, 120)) out += `- ${op}\n`;
		if (migration.ops.length > 120) out += `- and ${migration.ops.length - 120} more\n`;
		if (migration.kept.length > 0) {
			out += "\nKept as they were, because Copilot-side work already exists:\n\n";
			for (const kept of migration.kept) out += `- ${kept}\n`;
		}
		out += "\n";
	}

	out += "## Compatibility checks\n\n";
	if (analysis.validation === null && !analysis.buildError) out += "Not run.\n\n";
	for (const check of analysis.validation || []) out += `- ${check.skipped ? "SKIP" : check.problems.length === 0 ? "PASS" : "FAIL"} ${check.name}${check.skipped ? `: ${check.skipped}` : ""}\n`;
	if (analysis.buildError) out += `- FAIL build: ${analysis.buildError.split("\n")[0]}\n`;
	out += "\n";

	if (context.status === "prepared" || context.status === "needs-adapter-work") {
		out += `## Roll back\n\nBefore the merge, close the pull request. After it, run \`pstack upstream rollback\`, or revert the merge commit with git. Both restore pstack-core, the lock, and the mapping files together and keep your later Copilot changes: a revert that conflicts with them stops and lists the files.\n\n`;
	}
	out += `Never merged by automation. A person reviews and merges.${context.reportPath ? ` The committed copy of this report is \`${context.reportPath}\`.` : ""}\n`;
	return out;
}

const PR_LIMIT = 60000;

/** The pull request body: the report, trimmed to GitHub's limit with a pointer to the committed copy. */
export function renderPrBody(report: string, reportPath: string | undefined): string {
	if (report.length <= PR_LIMIT) return report;
	return `${report.slice(0, PR_LIMIT - 400)}\n\n...\n\nThe report was shortened for GitHub. The full text is ${reportPath ? `\`${reportPath}\`` : "in the workflow run"}.\n`;
}

export function reportFileName(date: string, version: string, commit: string): string {
	return `${date}-${version}-${commit.slice(0, 12)}`;
}

export interface ReportJson {
	readonly status: SyncStatus;
	readonly trigger: string;
	readonly from: { commit: string; version: string; tree: string } | null;
	readonly to: { commit: string; version: string; tree: string };
	readonly counts: ReturnType<typeof countChanges>;
	readonly changes: readonly FileChange[];
	readonly items: Analysis["diff"]["items"];
	readonly vocabulary: Analysis["diff"]["vocabulary"];
	readonly impact: Analysis["impact"];
	readonly conflicts: Analysis["conflicts"];
	readonly migration: { ops: readonly string[]; kept: readonly string[] } | null;
	readonly validation: { name: string; passed: boolean; skipped?: string; problems: readonly string[] }[];
	readonly failedChecks: string[];
}

export function reportJson(analysis: Analysis, status: SyncStatus, trigger: string): ReportJson {
	const ref = (lock: { commit: string; version: string; tree: string }) => ({ commit: lock.commit, version: lock.version, tree: lock.tree });
	return {
		status,
		trigger,
		from: analysis.previous ? ref(analysis.previous) : null,
		to: ref(analysis.lock),
		counts: countChanges(analysis.diff),
		changes: analysis.diff.changes,
		items: analysis.diff.items,
		vocabulary: analysis.diff.vocabulary,
		impact: analysis.impact,
		conflicts: analysis.conflicts,
		migration: analysis.migration ? { ops: analysis.migration.ops, kept: analysis.migration.kept } : null,
		validation: (analysis.validation || []).map((check) => ({ name: check.name, passed: check.problems.length === 0 && !check.skipped, skipped: check.skipped, problems: check.problems })),
		failedChecks: failedChecks(analysis),
	};
}
