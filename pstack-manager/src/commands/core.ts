import { paths, print, warn } from "../cli.ts";
import { readLock, verifyTree } from "../upstream/lock.ts";

export function core(args: string[]): number {
	if (args[0] !== "verify") {
		warn("usage: pstack core verify");
		return 2;
	}
	const p = paths();
	const lock = readLock(p.lockFile);
	const problems = verifyTree(p.coreUpstream, lock);
	if (problems.length > 0) {
		for (const problem of problems) warn(problem);
		warn(`pstack-core differs from ${lock.repository}@${lock.commit} in ${problems.length} place(s).`);
		return 1;
	}
	print(`pstack-core matches ${lock.name} ${lock.version} at ${lock.commit}: ${Object.keys(lock.files).length} files, byte-identical.`);
	return 0;
}
