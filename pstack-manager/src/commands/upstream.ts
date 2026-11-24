import { options, paths, print, warn } from "../cli.ts";
import { renderDiff } from "../upstream/diff.ts";
import { syncUpstream } from "../upstream/sync.ts";

export async function upstream(args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	const { values } = options(rest, {
		ref: { type: "string" },
		repository: { type: "string" },
		source: { type: "string" },
		force: { type: "boolean" },
		"no-gate": { type: "boolean" },
		adapter: { type: "string" },
	});
	if (sub !== "check" && sub !== "sync") {
		warn("usage: pstack upstream check|sync [--ref R] [--repository URL] [--source DIR]");
		return 2;
	}
	const p = paths();
	const gate =
		sub === "sync" && !values["no-gate"]
			? (await import("../validate/gate.ts")).makeGate(p, values.adapter || "copilot")
			: undefined;
	const result = syncUpstream(p, {
		source: values.source,
		repository: values.repository,
		ref: values.ref,
		force: values.force,
		dryRun: sub === "check",
		gate,
	});
	print(`upstream ${result.lock.name} ${result.lock.version} at ${result.lock.commit} (tree ${result.lock.tree})`);
	print(`status: ${result.status}`);
	if (result.status !== "unchanged") print(renderDiff(result.diff, new Date().toISOString().slice(0, 10)));
	if (result.problems.length > 0) {
		warn(`${result.problems.length} adapter problem(s) against this upstream:`);
		for (const problem of result.problems) warn(`  - ${problem}`);
	}
	return result.status === "blocked" ? 1 : 0;
}
