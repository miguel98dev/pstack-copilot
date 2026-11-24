/**
 * Minimal YAML-frontmatter reader for SKILL.md and agent files. It supports the subset pstack uses:
 * plain, single-quoted and double-quoted scalars, booleans, inline string arrays, and folded or literal
 * block scalars. Unsupported syntax throws, so a new construct upstream fails the build instead of
 * being misread.
 */

export type FrontValue = string | boolean | string[];

export interface FrontmatterEntry {
	readonly key: string;
	readonly value: FrontValue;
	/** Raw source lines of this entry, without trailing newline characters. */
	readonly lines: readonly string[];
}

export interface Frontmatter {
	readonly entries: readonly FrontmatterEntry[];
	/** Text before the body: the opening fence, the entries, and the closing fence with its newline. */
	readonly head: string;
	readonly body: string;
}

const FENCE = /^---\r?\n/;
const KEY = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*)|[ \t]*)$/;

export function hasFrontmatter(text: string): boolean {
	return FENCE.test(text);
}

export function parseFrontmatter(text: string): Frontmatter {
	if (!FENCE.test(text)) return { entries: [], head: "", body: text };
	const close = text.indexOf("\n---", 3);
	if (close < 0) throw new Error("frontmatter has no closing fence");
	const afterClose = text.indexOf("\n", close + 4);
	const headEnd = afterClose < 0 ? text.length : afterClose + 1;
	const inner = text.slice(text.indexOf("\n") + 1, close + 1);
	const lines = inner.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const entries: FrontmatterEntry[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "" || line.trimStart().startsWith("#")) {
			i++;
			continue;
		}
		const match = KEY.exec(line);
		if (!match) throw new Error(`unsupported frontmatter line: ${JSON.stringify(line)}`);
		const key = match[1];
		const rawValue = (match[2] ?? "").trim();
		const raw = [line];
		i++;
		if (/^[>|][-+]?$/.test(rawValue)) {
			const block: string[] = [];
			while (i < lines.length && (lines[i].startsWith(" ") || lines[i].startsWith("\t") || lines[i] === "")) {
				block.push(lines[i]);
				raw.push(lines[i]);
				i++;
			}
			entries.push({ key, value: blockScalar(rawValue, block), lines: raw });
			continue;
		}
		entries.push({ key, value: scalarOrArray(rawValue), lines: raw });
	}
	return { entries, head: text.slice(0, headEnd), body: text.slice(headEnd) };
}

function blockScalar(indicator: string, block: string[]): string {
	const content = block.filter((line) => line.trim() !== "");
	const indent = Math.min(...content.map((line) => line.length - line.trimStart().length));
	const stripped = block.map((line) => line.slice(indent));
	const text = indicator.startsWith(">")
		? stripped.join("\n").replace(/([^\n])\n(?!\n)/g, "$1 ").trim()
		: stripped.join("\n").trimEnd();
	return text;
}

function scalarOrArray(raw: string): FrontValue {
	if (raw.startsWith("[")) {
		if (!raw.endsWith("]")) throw new Error(`unsupported array: ${raw}`);
		const inner = raw.slice(1, -1).trim();
		if (inner === "") return [];
		return splitArray(inner).map((item) => {
			const value = scalarOrArray(item.trim());
			if (typeof value !== "string") throw new Error(`unsupported array item: ${item}`);
			return value;
		});
	}
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw.startsWith('"')) {
		if (!raw.endsWith('"') || raw.length < 2) throw new Error(`unterminated string: ${raw}`);
		return JSON.parse(raw) as string;
	}
	if (raw.startsWith("'")) {
		if (!raw.endsWith("'") || raw.length < 2) throw new Error(`unterminated string: ${raw}`);
		return raw.slice(1, -1).replace(/''/g, "'");
	}
	return raw;
}

function splitArray(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const char of inner) {
		if (quote) {
			current += char;
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (char === ",") {
			items.push(current);
			current = "";
		} else current += char;
	}
	items.push(current);
	return items;
}

export function frontValue(fm: Frontmatter, key: string): FrontValue | undefined {
	const entry = fm.entries.find((candidate) => candidate.key === key);
	return entry ? entry.value : undefined;
}

export function frontString(fm: Frontmatter, key: string): string | undefined {
	const value = frontValue(fm, key);
	return typeof value === "string" ? value : undefined;
}

/** Serializes one generated key. Strings are always double quoted so no value needs YAML escaping rules. */
export function serializeEntry(key: string, value: FrontValue): string {
	if (typeof value === "boolean") return `${key}: ${value}`;
	if (Array.isArray(value)) return `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]`;
	return `${key}: ${JSON.stringify(value)}`;
}
