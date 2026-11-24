import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapter } from "../build/adapter.ts";
import { buildDist } from "../build/engine.ts";
import { remove } from "../lib/fs.ts";
import { adapterDir, type Paths } from "../paths.ts";
import type { UpstreamLock } from "../upstream/lock.ts";
import { problemsOf, validateAll } from "./index.ts";

/** Builds and validates an adapter against a staged core, so an upstream sync never lands a core the adapter cannot serve. */
export function makeGate(paths: Paths, adapterId: string) {
	return (stagedCore: string, lock: UpstreamLock): string[] => {
		const scratch = mkdtempSync(join(tmpdir(), "pstack-gate-"));
		try {
			const adapter = loadAdapter(adapterDir(paths, adapterId));
			const distDir = join(scratch, "dist");
			buildDist({ coreDir: stagedCore, lock, adapter, outDir: distDir });
			return problemsOf(validateAll({ coreDir: stagedCore, distDir, adapter, lock, scripts: false }));
		} catch (error) {
			return [(error as Error).message];
		} finally {
			remove(scratch);
		}
	};
}
