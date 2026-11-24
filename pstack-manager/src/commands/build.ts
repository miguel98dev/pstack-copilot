import { options, paths, print } from "../cli.ts";
import { buildProject } from "../build/project.ts";

export function build(args: string[]): number {
	const { values } = options(args, { adapter: { type: "string" } });
	const result = buildProject(paths(), values.adapter || "copilot");
	const files = result.manifest.files;
	const count = (origin: string) => files.filter((file) => file.origin === origin).length;
	const injected = files.filter((file) => file.transforms.some((t) => t.type === "inject-adapter-line")).length;
	const identical = files.filter((file) => file.origin === "core" && file.transforms.length === 0).length;
	print(`built ${result.version} in ${result.outDir}`);
	print(`${files.length} files: ${count("core")} from core (${identical} byte-identical, ${injected} with the adapter line), ${count("overlay")} overlay, ${count("generated")} generated`);
	return 0;
}
