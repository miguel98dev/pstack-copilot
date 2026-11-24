import { exists, readJson, writeJson } from "../lib/fs.ts";
import type { Paths } from "../paths.ts";
import type { ChangeKind } from "./diff.ts";

export type RecordKind = "sync" | "rollback";
export type RecordStatus = "prepared" | "needs-adapter-work" | "rolled-back" | "rollback";

export interface LockRef {
	readonly commit: string;
	readonly version: string;
	readonly tree: string;
}

export interface SyncRecord {
	readonly id: string;
	readonly kind: RecordKind;
	readonly at: string;
	readonly trigger: string;
	readonly status: RecordStatus;
	readonly from: LockRef | null;
	readonly to: LockRef;
	readonly counts: Readonly<Record<ChangeKind, number>>;
	readonly adapter: { readonly revisionBefore: number; readonly revisionAfter: number; readonly coreVersionsAfter: readonly string[] };
	readonly impact: { readonly affected: number; readonly needsManual: number };
	readonly conflicts: readonly string[];
	readonly migration: readonly string[];
	readonly validation: { readonly passed: boolean; readonly failed: readonly string[] };
	readonly report: string | null;
	readonly branch?: string;
	readonly pullRequest?: string;
	readonly rolledBackBy?: string;
	readonly note?: string;
}

export interface SyncHistory {
	readonly schema: 1;
	readonly entries: readonly SyncRecord[];
}

const STATUSES = new Set(["prepared", "needs-adapter-work", "rolled-back", "rollback"]);

function fail(message: string): never {
	throw new Error(`invalid docs/sync/history.json: ${message}`);
}

function ref(value: unknown, name: string): LockRef {
	const o = value as Record<string, unknown> | null;
	if (!o || typeof o.commit !== "string" || typeof o.version !== "string" || typeof o.tree !== "string") fail(`${name} needs commit, version, and tree`);
	return { commit: o.commit, version: o.version, tree: o.tree };
}

/** Parses the history at the boundary so every consumer can trust its shape. */
export function parseHistory(value: unknown): SyncHistory {
	const v = value as { schema?: unknown; entries?: unknown } | null;
	if (!v || v.schema !== 1 || !Array.isArray(v.entries)) fail("expected { schema: 1, entries: [] }");
	const ids = new Set<string>();
	const entries = v.entries.map((raw: Record<string, unknown>, index): SyncRecord => {
		if (typeof raw.id !== "string" || ids.has(raw.id)) fail(`entries[${index}].id must be unique`);
		ids.add(raw.id);
		if (raw.kind !== "sync" && raw.kind !== "rollback") fail(`entries[${index}].kind`);
		if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) fail(`entries[${index}].status`);
		if (typeof raw.at !== "string" || typeof raw.trigger !== "string") fail(`entries[${index}] needs at and trigger`);
		return { ...(raw as unknown as SyncRecord), from: raw.from === null ? null : ref(raw.from, `entries[${index}].from`), to: ref(raw.to, `entries[${index}].to`) };
	});
	return { schema: 1, entries };
}

export function readHistory(paths: Paths): SyncHistory {
	return exists(paths.historyFile) ? parseHistory(readJson(paths.historyFile)) : { schema: 1, entries: [] };
}

export function writeHistory(paths: Paths, history: SyncHistory): void {
	writeJson(paths.historyFile, history);
}

export function recordId(kind: RecordKind, to: LockRef, history: SyncHistory): string {
	const base = `${kind}-${to.commit.slice(0, 12)}`;
	const taken = history.entries.filter((entry) => entry.id === base || entry.id.startsWith(`${base}-`)).length;
	return taken === 0 ? base : `${base}-${taken + 1}`;
}

export function appendRecord(paths: Paths, record: SyncRecord): SyncHistory {
	const history = readHistory(paths);
	const next: SyncHistory = { schema: 1, entries: [...history.entries, record] };
	writeHistory(paths, next);
	return next;
}

export function updateRecord(paths: Paths, id: string, patch: Partial<SyncRecord>): SyncHistory {
	const history = readHistory(paths);
	if (!history.entries.some((entry) => entry.id === id)) throw new Error(`no sync record ${id}`);
	const next: SyncHistory = { schema: 1, entries: history.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) };
	writeHistory(paths, next);
	return next;
}

/** The newest sync that was not rolled back, which is the state the lock should describe. */
export function currentRecord(history: SyncHistory): SyncRecord | null {
	for (let i = history.entries.length - 1; i >= 0; i--) {
		const entry = history.entries[i];
		if (entry.kind === "sync" && entry.status !== "rolled-back") return entry;
	}
	return null;
}

export function findRecord(history: SyncHistory, query: string): SyncRecord | null {
	return history.entries.find((entry) => entry.id === query || (entry.kind === "sync" && (entry.to.commit.startsWith(query) || entry.to.version === query))) || null;
}

export function renderHistory(history: SyncHistory): string {
	if (history.entries.length === 0) return "no synchronizations recorded";
	return history.entries
		.map((entry) => {
			const from = entry.from ? `${entry.from.version} ${entry.from.commit.slice(0, 12)}` : "(first sync)";
			const link = entry.pullRequest ? ` ${entry.pullRequest}` : "";
			return `${entry.at.slice(0, 16)}  ${entry.kind.padEnd(8)} ${entry.status.padEnd(18)} ${from} -> ${entry.to.version} ${entry.to.commit.slice(0, 12)}${link}`;
		})
		.join("\n");
}

/**
 * Records the state the lock already describes as the first history entry, for a repository whose core was
 * vendored before the history existed. It does nothing when the history already has entries.
 */
export function adoptCurrent(paths: Paths, adapterRevision: number, coreVersions: readonly string[], problems: readonly string[], now: Date): SyncRecord | null {
	const history = readHistory(paths);
	if (history.entries.length > 0 || !exists(paths.lockFile)) return null;
	const lock = readJson(paths.lockFile) as { commit: string; version: string; tree: string; files: Record<string, unknown> };
	const to: LockRef = { commit: lock.commit, version: lock.version, tree: lock.tree };
	const record: SyncRecord = {
		id: recordId("sync", to, history),
		kind: "sync",
		at: now.toISOString(),
		trigger: "adopted",
		status: "prepared",
		from: null,
		to,
		counts: { added: Object.keys(lock.files).length, modified: 0, deleted: 0, renamed: 0, "mode-changed": 0 },
		adapter: { revisionBefore: adapterRevision, revisionAfter: adapterRevision, coreVersionsAfter: coreVersions },
		impact: { affected: 0, needsManual: 0 },
		conflicts: [],
		migration: [],
		validation: { passed: problems.length === 0, failed: problems.length === 0 ? [] : ["core matches UPSTREAM.lock.json"] },
		report: null,
		note: "Recorded from the existing lock. This state was vendored before the synchronization history existed.",
	};
	writeHistory(paths, { schema: 1, entries: [record] });
	return record;
}
