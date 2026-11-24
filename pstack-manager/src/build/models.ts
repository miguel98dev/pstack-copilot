import type { ModelRules } from "./adapter.ts";

export type Budget = "large" | "medium" | "small";

const BUDGET_STEPS: Record<Budget, number> = { large: 0, medium: 1, small: 2 };
const BUDGET_LABEL: Record<Budget, string> = { large: "xhigh", medium: "high", small: "medium" };

/** Maps one Cursor slug to a Copilot role value, `<model> @<effort>`, optionally lowering the effort for a budget. */
export function copilotValue(slug: string, rules: ModelRules, budget: Budget = "large"): string {
	if (slug === "auto" || slug === "inherit-parent") return slug;
	for (const rule of rules.slugs) {
		const match = new RegExp(rule.pattern).exec(slug);
		if (!match) continue;
		const effort = match[1];
		const index = rules.ladder.indexOf(effort);
		if (index < 0) throw new Error(`effort ${effort} of ${slug} is not on the ladder`);
		const lowered = rules.ladder[Math.max(0, index - BUDGET_STEPS[budget])];
		return `${rule.model} @${lowered}`;
	}
	throw new Error(`no Copilot mapping for Cursor model slug ${slug}`);
}

export function renderModelsInstruction(rules: ModelRules, budget: Budget): string {
	const lines = rules.roles.map((role) => `${role.role}: ${role.cursor.map((slug) => copilotValue(slug, rules, budget)).join(", ")}`);
	return [
		"---",
		'applyTo: "**"',
		'description: "pstack per-role model choices for GitHub Copilot (overrides skill defaults)"',
		"---",
		"# pstack model configuration. One line per role. Delete a line to fall back to the skill default.",
		"# Values are Copilot model ids with a reasoning effort, `<model> @<effort>`. `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit `model` and spawn `general-purpose`). Alias entries in a panel list still count toward its fan-out.",
		"# Written by `pstack models init`; `/setup-pstack` rewrites it with detected models.",
		"# defaults: 3",
		`# budget: ${budget} (${BUDGET_LABEL[budget]})`,
		...lines,
		"",
	].join("\n");
}

export function parseBudget(value: string | undefined): Budget {
	const budget = value || "large";
	if (budget !== "large" && budget !== "medium" && budget !== "small") throw new Error(`budget must be large, medium, or small, not ${budget}`);
	return budget;
}
