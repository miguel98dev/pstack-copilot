import { join } from "node:path";
import { exists, readJson, writeJson } from "../lib/fs.ts";
import type { Paths } from "../paths.ts";

export interface UserInstall {
	readonly version: string;
	readonly installedAt: string;
	/** Absolute paths of the symlinks pstack created in the Copilot home. */
	readonly links: readonly string[];
	/** Paths pstack wanted but left alone because something else owns them. */
	readonly skipped: readonly string[];
}

export interface InstallState {
	readonly schema: 1;
	readonly adapter: string;
	readonly active: string | null;
	/** Versions activated before, most recent last; rollback walks this list. */
	readonly history: readonly string[];
	readonly user: UserInstall | null;
}

export function statePath(paths: Paths): string {
	return join(paths.pstackHome, "state.json");
}

export function emptyState(adapter: string): InstallState {
	return { schema: 1, adapter, active: null, history: [], user: null };
}

export function readState(paths: Paths, adapter = "copilot"): InstallState {
	const file = statePath(paths);
	if (!exists(file)) return emptyState(adapter);
	const value = readJson(file) as Record<string, unknown>;
	if (value.schema !== 1) throw new Error(`${file}: unknown schema`);
	return value as unknown as InstallState;
}

export function writeState(paths: Paths, state: InstallState): void {
	writeJson(statePath(paths), state);
}
