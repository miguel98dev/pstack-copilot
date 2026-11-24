import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

/** Names the upstream harness generator also skips. */
const SKIPPED = new Set([".DS_Store", "node_modules", ".git"]);

/** Returns every regular file below `root` as sorted POSIX paths relative to `root`. */
export function walkFiles(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (SKIPPED.has(name)) continue;
			const abs = join(dir, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			const stat = statSync(abs);
			if (stat.isDirectory()) visit(abs, rel);
			else if (stat.isFile()) out.push(rel);
		}
	};
	visit(root, "");
	return out.sort();
}

export function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function isExecutable(path: string): boolean {
	return (statSync(path).mode & 0o111) !== 0;
}

export function fileMode(path: string): "644" | "755" {
	return isExecutable(path) ? "755" : "644";
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export function writeFile(path: string, bytes: Buffer | string, mode: "644" | "755" = "644"): void {
	ensureDir(dirname(path));
	writeFileSync(path, bytes);
	chmodSync(path, mode === "755" ? 0o755 : 0o644);
}

export function copyFile(src: string, dest: string): void {
	ensureDir(dirname(dest));
	copyFileSync(src, dest);
	chmodSync(dest, isExecutable(src) ? 0o755 : 0o644);
}

export function copyTree(srcRoot: string, destRoot: string): string[] {
	const files = walkFiles(srcRoot);
	for (const rel of files) copyFile(join(srcRoot, rel), join(destRoot, rel));
	return files;
}

export function readText(path: string): string {
	return readFileSync(path, "utf8");
}

export function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path: string, value: unknown): void {
	writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function remove(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function exists(path: string): boolean {
	return existsSync(path);
}

/** True when `path` is a symlink, whether or not its target exists. */
export function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

export function linkTarget(path: string): string | null {
	return isSymlink(path) ? readlinkSync(path) : null;
}

/** Points `linkPath` at `target`, replacing an existing link atomically through a rename. */
export function replaceSymlink(target: string, linkPath: string): void {
	ensureDir(dirname(linkPath));
	const temp = `${linkPath}.pstack-tmp-${process.pid}`;
	rmSync(temp, { force: true });
	symlinkSync(target, temp);
	renameSync(temp, linkPath);
}

export function toPosix(path: string): string {
	return path.split(sep).join("/");
}

export function moveDir(from: string, to: string): void {
	ensureDir(dirname(to));
	renameSync(from, to);
}
