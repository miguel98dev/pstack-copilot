import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Paths {
	readonly repoRoot: string;
	readonly coreDir: string;
	readonly coreUpstream: string;
	readonly lockFile: string;
	readonly changelog: string;
	readonly distRoot: string;
	readonly pstackHome: string;
	readonly copilotHome: string;
}

const MANAGER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolves every location the manager reads or writes. Environment overrides exist so tests never touch real homes. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
	const repoRoot = resolve(env.PSTACK_REPO || join(MANAGER_ROOT, ".."));
	const coreDir = join(repoRoot, "pstack-core");
	return {
		repoRoot,
		coreDir,
		coreUpstream: join(coreDir, "upstream"),
		lockFile: join(coreDir, "UPSTREAM.lock.json"),
		changelog: join(coreDir, "CHANGELOG.upstream.md"),
		distRoot: resolve(env.PSTACK_DIST || join(repoRoot, "dist")),
		pstackHome: resolve(env.PSTACK_HOME || join(homedir(), ".pstack")),
		copilotHome: resolve(env.COPILOT_HOME || join(homedir(), ".copilot")),
	};
}

export function adapterDir(paths: Paths, id: string): string {
	return join(paths.repoRoot, `pstack-${id}`);
}

export const MANAGER_VERSION = "0.1.0";
