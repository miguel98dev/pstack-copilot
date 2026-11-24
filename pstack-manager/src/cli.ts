import { parseArgs } from "node:util";
import { MANAGER_VERSION, resolvePaths } from "./paths.ts";

type Handler = (args: string[]) => Promise<number> | number;

const HELP = `pstack-manager ${MANAGER_VERSION}

Usage: pstack <command> [options]

Upstream and core
  upstream check [--ref R] [--repository URL] [--source DIR]   Show what a sync would change
  upstream sync  [--ref R] [--repository URL] [--source DIR] [--force] [--no-gate]
  core verify                                                  Check pstack-core against UPSTREAM.lock.json

Adapters
  build    [--adapter copilot]                                 Build dist/<adapter>/<version>
  validate [--adapter copilot] [--skip-scripts]                Prove the build is core + declared transforms
  matrix   [--adapter copilot]                                 Regenerate the compatibility matrix
  lint-skill <dir>...                                          Check SKILL.md folders against the Agent Skills rules

Installation
  install   [--adapter copilot] [--scope user|workspace] [--repo DIR] [--force]
  uninstall [--scope user|workspace] [--repo DIR]
  update    [--ref R] [--source DIR]                           Sync, build, validate, install, keep the old version
  rollback  [version]                                          Switch back to an installed version
  status | versions | doctor
  models init [--budget large|medium|small] [--scope user|workspace] [--repo DIR] [--force]
`;

const COMMANDS: Record<string, () => Promise<Handler>> = {
	upstream: async () => (await import("./commands/upstream.ts")).upstream,
	core: async () => (await import("./commands/core.ts")).core,
	build: async () => (await import("./commands/build.ts")).build,
	validate: async () => (await import("./commands/validate.ts")).validate,
	matrix: async () => (await import("./commands/matrix.ts")).matrix,
	"lint-skill": async () => (await import("./commands/lint-skill.ts")).lintSkill,
	install: async () => (await import("./commands/install.ts")).install,
	uninstall: async () => (await import("./commands/install.ts")).uninstall,
	update: async () => (await import("./commands/install.ts")).update,
	rollback: async () => (await import("./commands/install.ts")).rollback,
	status: async () => (await import("./commands/install.ts")).status,
	versions: async () => (await import("./commands/install.ts")).versions,
	doctor: async () => (await import("./commands/doctor.ts")).doctor,
	models: async () => (await import("./commands/models.ts")).models,
};

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP);
		return 0;
	}
	if (command === "--version" || command === "-v") {
		process.stdout.write(`${MANAGER_VERSION}\n`);
		return 0;
	}
	const load = COMMANDS[command];
	if (!load) {
		process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
		return 2;
	}
	try {
		return await (await load())(rest);
	} catch (error) {
		process.stderr.write(`pstack ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export function options<T extends Record<string, { type: "string" | "boolean"; short?: string }>>(args: string[], spec: T) {
	return parseArgs({ args, options: spec, allowPositionals: true, strict: true });
}

export const paths = () => resolvePaths();

export function print(line = ""): void {
	process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
	process.stderr.write(`${line}\n`);
}
