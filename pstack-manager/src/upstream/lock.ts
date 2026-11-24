import { join } from "node:path";
import { fileMode, readJson, readText, sha256, walkFiles } from "../lib/fs.ts";
import { readFileSync } from "node:fs";
import type { FetchedUpstream } from "./fetch.ts";
import type { UpstreamVocabulary, VocabularyTerm } from "./vocabulary.ts";

export interface LockedFile {
	readonly sha256: string;
	readonly size: number;
	readonly mode: "644" | "755";
}

export interface UpstreamLock {
	readonly schema: 1;
	readonly repository: string;
	readonly path: string;
	readonly ref: string;
	readonly commit: string;
	readonly committedAt: string;
	readonly tree: string;
	readonly name: string;
	readonly version: string;
	readonly license: { readonly spdx: string; readonly holder: string; readonly file: string };
	readonly vocabulary: UpstreamVocabulary;
	readonly fetchedWith: string;
	readonly files: Readonly<Record<string, LockedFile>>;
}

export function hashTree(root: string): Record<string, LockedFile> {
	const files: Record<string, LockedFile> = {};
	for (const rel of walkFiles(root)) {
		const abs = join(root, rel);
		const bytes = readFileSync(abs);
		files[rel] = { sha256: sha256(bytes), size: bytes.length, mode: fileMode(abs) };
	}
	return files;
}

export function readLicenseHolder(licenseText: string): { spdx: string; holder: string } {
	const spdx = /^MIT License/m.test(licenseText) ? "MIT" : "UNKNOWN";
	const holder = /Copyright \(c\) \d{4} (.+)$/m.exec(licenseText);
	if (!holder) throw new Error("upstream LICENSE has no copyright line");
	return { spdx, holder: holder[1].trim() };
}

export function computeLock(fetched: FetchedUpstream, vocabulary: UpstreamVocabulary, path: string, fetchedWith: string): UpstreamLock {
	const manifest = readJson(join(fetched.pstackDir, "plugin.json")) as { name?: unknown; version?: unknown };
	if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error("upstream plugin.json has no name or version");
	const license = readLicenseHolder(readText(join(fetched.pstackDir, "LICENSE")));
	return {
		schema: 1,
		repository: fetched.repository,
		path,
		ref: fetched.ref,
		commit: fetched.commit,
		committedAt: fetched.committedAt,
		tree: fetched.tree,
		name: manifest.name,
		version: manifest.version,
		license: { ...license, file: "LICENSE" },
		vocabulary,
		fetchedWith,
		files: hashTree(fetched.pstackDir),
	};
}

function fail(message: string): never {
	throw new Error(`invalid UPSTREAM.lock.json: ${message}`);
}

function str(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "") fail(`${name} must be a non-empty string`);
	return value;
}

/** Parses the lock at the boundary so the rest of the manager can trust its shape. */
export function parseLock(value: unknown): UpstreamLock {
	if (typeof value !== "object" || value === null) fail("not an object");
	const v = value as Record<string, unknown>;
	if (v.schema !== 1) fail("schema must be 1");
	const license = v.license as Record<string, unknown> | undefined;
	if (!license) fail("license missing");
	const vocabulary = v.vocabulary as Record<string, unknown> | undefined;
	if (!vocabulary || !Array.isArray(vocabulary.terms)) fail("vocabulary.terms missing");
	const terms: VocabularyTerm[] = vocabulary.terms.map((term: Record<string, unknown>, index: number) => ({
		key: str(term.key, `vocabulary.terms[${index}].key`),
		pattern: str(term.pattern, `vocabulary.terms[${index}].pattern`),
		flags: typeof term.flags === "string" ? term.flags : fail(`vocabulary.terms[${index}].flags`),
	}));
	const files = v.files as Record<string, Record<string, unknown>> | undefined;
	if (!files || typeof files !== "object") fail("files missing");
	const parsedFiles: Record<string, LockedFile> = {};
	for (const [path, entry] of Object.entries(files)) {
		const mode = entry.mode === "755" ? "755" : entry.mode === "644" ? "644" : fail(`files.${path}.mode`);
		if (typeof entry.size !== "number") fail(`files.${path}.size`);
		parsedFiles[path] = { sha256: str(entry.sha256, `files.${path}.sha256`), size: entry.size, mode };
	}
	return {
		schema: 1,
		repository: str(v.repository, "repository"),
		path: str(v.path, "path"),
		ref: str(v.ref, "ref"),
		commit: str(v.commit, "commit"),
		committedAt: str(v.committedAt, "committedAt"),
		tree: str(v.tree, "tree"),
		name: str(v.name, "name"),
		version: str(v.version, "version"),
		license: { spdx: str(license.spdx, "license.spdx"), holder: str(license.holder, "license.holder"), file: str(license.file, "license.file") },
		vocabulary: { source: str(vocabulary.source, "vocabulary.source"), routeKey: str(vocabulary.routeKey, "vocabulary.routeKey"), terms },
		fetchedWith: str(v.fetchedWith, "fetchedWith"),
		files: parsedFiles,
	};
}

export function readLock(path: string): UpstreamLock {
	return parseLock(readJson(path));
}

/** Lists every way the tree at `root` differs from the lock. An empty list means byte-identical upstream content. */
export function verifyTree(root: string, lock: UpstreamLock): string[] {
	const problems: string[] = [];
	const actual = hashTree(root);
	for (const [path, want] of Object.entries(lock.files)) {
		const have = actual[path];
		if (!have) problems.push(`missing ${path}`);
		else if (have.sha256 !== want.sha256) problems.push(`modified ${path}`);
		else if (have.mode !== want.mode) problems.push(`mode ${path}: ${have.mode}, locked ${want.mode}`);
	}
	for (const path of Object.keys(actual)) if (!lock.files[path]) problems.push(`unexpected ${path}`);
	return problems;
}
