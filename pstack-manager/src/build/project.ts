import { join } from "node:path";
import { adapterDir, type Paths } from "../paths.ts";
import { readLock, type UpstreamLock } from "../upstream/lock.ts";
import { type Adapter, adapterVersion, loadAdapter } from "./adapter.ts";
import { buildDist, type BuildResult } from "./engine.ts";

export interface LoadedProject {
	readonly lock: UpstreamLock;
	readonly adapter: Adapter;
	readonly version: string;
	readonly outDir: string;
}

export function loadProject(paths: Paths, adapterId: string): LoadedProject {
	const lock = readLock(paths.lockFile);
	const adapter = loadAdapter(adapterDir(paths, adapterId));
	const version = adapterVersion(lock.version, adapter);
	return { lock, adapter, version, outDir: join(paths.distRoot, adapter.id, version) };
}

export function buildProject(paths: Paths, adapterId: string): BuildResult {
	const project = loadProject(paths, adapterId);
	return buildDist({ coreDir: paths.coreUpstream, lock: project.lock, adapter: project.adapter, outDir: project.outDir });
}
