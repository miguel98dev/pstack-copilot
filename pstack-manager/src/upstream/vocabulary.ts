import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";

export interface VocabularyTerm {
	readonly key: string;
	readonly pattern: string;
	readonly flags: string;
}

export interface UpstreamVocabulary {
	/** Repository-relative path of the upstream file the terms were read from. */
	readonly source: string;
	readonly routeKey: string;
	readonly terms: readonly VocabularyTerm[];
}

export const GENERATOR = "scripts/generate-pstack-harness-trees.mjs";
const TERM_LINE = /\{\s*key:\s*"((?:[^"\\]|\\.)*)",\s*re:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)\s*\}/g;
const ROUTE = /const ROUTE_KEY = "((?:[^"\\]|\\.)*)"/;

/**
 * Reads the Cursor vocabulary from the upstream harness generator, the list upstream itself uses to decide
 * which skills need an adapter. Keeping it in the lock means an upstream vocabulary change shows up as a
 * diff on sync, and the adapter coverage check fails until the Copilot adapter maps the new term.
 */
export function readUpstreamVocabulary(repoRoot: string): UpstreamVocabulary {
	const file = join(repoRoot, GENERATOR);
	if (!existsSync(file)) throw new Error(`upstream vocabulary source missing: ${file}`);
	const text = readText(file);
	const termsBlock = text.slice(text.indexOf("const TERMS = ["), text.indexOf("];", text.indexOf("const TERMS = [")));
	const terms: VocabularyTerm[] = [];
	for (const match of termsBlock.matchAll(TERM_LINE)) {
		const pattern = match[2];
		new RegExp(pattern, match[3]);
		terms.push({ key: JSON.parse(`"${match[1]}"`) as string, pattern, flags: match[3] });
	}
	const route = ROUTE.exec(text);
	if (terms.length === 0 || !route) throw new Error(`could not read TERMS or ROUTE_KEY from ${GENERATOR}`);
	return { source: GENERATOR, routeKey: JSON.parse(`"${route[1]}"`) as string, terms };
}
