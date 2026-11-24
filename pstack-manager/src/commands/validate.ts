import { options, paths, print, warn } from "../cli.ts";
import { loadProject } from "../build/project.ts";
import { exists } from "../lib/fs.ts";
import { validateAll } from "../validate/index.ts";

export function validate(args: string[]): number {
	const { values } = options(args, { adapter: { type: "string" }, "skip-scripts": { type: "boolean" }, dist: { type: "string" } });
	const p = paths();
	const project = loadProject(p, values.adapter || "copilot");
	const distDir = values.dist || project.outDir;
	if (!exists(distDir)) {
		warn(`no build at ${distDir}; run pstack build first`);
		return 1;
	}
	const results = validateAll({ coreDir: p.coreUpstream, distDir, adapter: project.adapter, lock: project.lock, scripts: !values["skip-scripts"] });
	let failed = 0;
	for (const result of results) {
		if (result.skipped) {
			print(`SKIP ${result.name}: ${result.skipped}`);
			continue;
		}
		print(`${result.problems.length === 0 ? "PASS" : "FAIL"} ${result.name}`);
		for (const problem of result.problems) warn(`     ${problem}`);
		if (result.problems.length > 0) failed++;
	}
	print(failed === 0 ? `valid: ${project.version}` : `${failed} check(s) failed`);
	return failed === 0 ? 0 : 1;
}
