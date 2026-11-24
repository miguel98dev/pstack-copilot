import type { VocabularyTerm } from "../upstream/vocabulary.ts";

export interface Vocabulary {
	readonly terms: readonly VocabularyTerm[];
	readonly routeKey: string;
}

export interface Classification {
	readonly keys: Set<string>;
}

/**
 * Finds the Cursor vocabulary a unit (a skill folder or an agent file) uses. It mirrors upstream's
 * harness generator: every term pattern, plus the route rule that flags a bare reference to another
 * skill ("the **name** skill" or `/name`) unless the same line links to that skill's folder.
 */
export function classify(texts: readonly string[], vocabulary: Vocabulary, otherSkills: readonly string[]): Classification {
	const keys = new Set<string>();
	const patterns = vocabulary.terms.map((term) => ({ key: term.key, re: new RegExp(term.pattern, term.flags) }));
	const escaped = otherSkills.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const route = escaped ? new RegExp(`the \\*\\*(?<bold>${escaped})\\*\\* skill|\`/(?<command>${escaped})\``, "g") : null;
	for (const text of texts) {
		for (const { key, re } of patterns) if (re.test(text)) keys.add(key);
		if (!route) continue;
		for (const line of text.split("\n")) {
			for (const match of line.matchAll(route)) {
				const groups = match.groups as { bold?: string; command?: string };
				const name = groups.bold || groups.command || "";
				if (!line.includes(`(../${name}/`)) {
					keys.add(vocabulary.routeKey);
					break;
				}
			}
		}
	}
	return { keys };
}
