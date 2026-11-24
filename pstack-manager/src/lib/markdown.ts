import { posix } from "node:path";

/** Same link pattern the upstream harness generator rewrites, so both ports treat the same links. */
export const LINK = /\]\(([^)\s]+)\)/g;

export interface LinkRewrite {
	readonly from: string;
	readonly to: string;
}

/**
 * Rewrites every relative Markdown link in `text`. `map` receives the link target and returns the new
 * target, or undefined to keep the link. Returns the new text and the rewrites in document order.
 */
export function rewriteLinks(text: string, map: (href: string) => string | undefined): { text: string; rewrites: LinkRewrite[] } {
	const rewrites: LinkRewrite[] = [];
	const out = text.replace(LINK, (whole, href: string) => {
		const next = map(href);
		if (next === undefined || next === href) return whole;
		rewrites.push({ from: href, to: next });
		return `](${next})`;
	});
	return { text: out, rewrites };
}

/** Reverses `rewriteLinks` given its recorded rewrites. */
export function reverseLinks(text: string, rewrites: readonly LinkRewrite[]): string {
	let index = 0;
	return text.replace(LINK, (whole, href: string) => {
		const rewrite = rewrites[index];
		if (rewrite && rewrite.to === href) {
			index++;
			return `](${rewrite.from})`;
		}
		return whole;
	});
}

export function isRelativeHref(href: string): boolean {
	const target = href.replace(/[#?].*/, "");
	return target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("/") && !target.startsWith("~");
}

/** Splits `path#anchor` or `path?query` into the path and its suffix. */
export function splitHref(href: string): { path: string; suffix: string } {
	const at = href.search(/[#?]/);
	return at < 0 ? { path: href, suffix: "" } : { path: href.slice(0, at), suffix: href.slice(at) };
}

export function resolveRelative(fromFile: string, hrefPath: string): string {
	return posix.normalize(posix.join(posix.dirname(fromFile), hrefPath)).replace(/\/$/, "");
}

export function relativeHref(fromFile: string, toPath: string): string {
	const rel = posix.relative(posix.dirname(fromFile), toPath);
	return rel === "" ? posix.basename(toPath) : rel;
}

export interface Injection {
	/** Character offset where the inserted text starts. */
	readonly at: number;
	readonly inserted: string;
}

/**
 * Inserts `line` as its own paragraph right after the first H1 outside a code fence, or after the
 * frontmatter when the file has no H1. The insertion is a pure addition, so removing `inserted` at `at`
 * restores the original bytes.
 */
export function injectAfterH1(text: string, bodyStart: number, line: string): { text: string; injection: Injection } {
	const h1End = firstH1End(text, bodyStart);
	if (h1End >= 0) {
		const inserted = `\n${line}\n`;
		return { text: text.slice(0, h1End) + inserted + text.slice(h1End), injection: { at: h1End, inserted } };
	}
	const inserted = `${line}\n\n`;
	return { text: text.slice(0, bodyStart) + inserted + text.slice(bodyStart), injection: { at: bodyStart, inserted } };
}

export function removeInjection(text: string, injection: Injection): string {
	const found = text.slice(injection.at, injection.at + injection.inserted.length);
	if (found !== injection.inserted) throw new Error("injected text is not where the manifest says");
	return text.slice(0, injection.at) + text.slice(injection.at + injection.inserted.length);
}

/** Offset just past the newline that ends the first H1 line, or -1. */
function firstH1End(text: string, bodyStart: number): number {
	let fenced = false;
	let offset = bodyStart;
	for (const line of text.slice(bodyStart).split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const end = offset + line.length + 1;
		if (!fenced && /^# /.test(line)) return Math.min(end, text.length);
		offset = end;
	}
	return -1;
}
