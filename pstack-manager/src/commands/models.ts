import { join, resolve } from "node:path";
import { options, paths, print, warn } from "../cli.ts";
import { parseBudget, renderModelsInstruction } from "../build/models.ts";
import { loadProject } from "../build/project.ts";
import { exists, writeFile } from "../lib/fs.ts";

/**
 * Writes the pstack-models instruction from the Copilot defaults, for a terminal or CI setup without the
 * interactive /setup-pstack skill. It refuses to overwrite choices the user made unless asked.
 */
export function models(args: string[]): number {
	const [sub, ...rest] = args;
	const { values } = options(rest, {
		adapter: { type: "string" },
		budget: { type: "string" },
		scope: { type: "string" },
		repo: { type: "string" },
		force: { type: "boolean" },
		print: { type: "boolean" },
	});
	if (sub !== "init") {
		warn("usage: pstack models init [--budget large|medium|small] [--scope user|workspace] [--repo DIR] [--force] [--print]");
		return 2;
	}
	const p = paths();
	const { adapter } = loadProject(p, values.adapter || "copilot");
	const text = renderModelsInstruction(adapter.models, parseBudget(values.budget));
	if (values.print) {
		process.stdout.write(text);
		return 0;
	}
	const target =
		(values.scope || "user") === "workspace"
			? join(resolve(values.repo || process.cwd()), ".github", "instructions", "pstack-models.instructions.md")
			: join(p.copilotHome, "instructions", "pstack-models.instructions.md");
	if (exists(target) && !values.force) {
		warn(`${target} exists and holds your model choices. Re-run /setup-pstack to change them, or pass --force to replace them with defaults.`);
		return 1;
	}
	writeFile(target, text);
	print(`wrote ${target}. New sessions load it.`);
	return 0;
}
