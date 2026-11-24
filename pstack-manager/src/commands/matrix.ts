import { join } from "node:path";
import { options, paths, print } from "../cli.ts";
import { renderMatrix } from "../build/matrix.ts";
import { loadProject } from "../build/project.ts";
import { writeFile } from "../lib/fs.ts";

/** Writes the compatibility matrix to the adapter's docs folder for reading on GitHub; the build ships the same text. */
export function matrix(args: string[]): number {
	const { values } = options(args, { adapter: { type: "string" } });
	const p = paths();
	const project = loadProject(p, values.adapter || "copilot");
	const out = join(project.adapter.dir, "docs", "COMPATIBILITY.md");
	writeFile(out, renderMatrix(project.adapter, project.lock, project.version));
	print(`wrote ${out}`);
	return 0;
}
