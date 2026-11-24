import { resolve } from "node:path";
import { options, print, warn } from "../cli.ts";
import { lintSkillFolder } from "../validate/checks.ts";

export function lintSkill(args: string[]): number {
	const { positionals } = options(args, {});
	if (positionals.length === 0) {
		warn("usage: pstack lint-skill <skill folder>...");
		return 2;
	}
	let failed = 0;
	for (const dir of positionals) {
		const problems = lintSkillFolder(resolve(dir));
		print(`${problems.length === 0 ? "PASS" : "FAIL"} ${dir}`);
		for (const problem of problems) warn(`     ${problem}`);
		if (problems.length > 0) failed++;
	}
	return failed === 0 ? 0 : 1;
}
