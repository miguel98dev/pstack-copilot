import assert from "node:assert/strict";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../../pstack-manager/src/build/project.ts";
import { readManifest } from "../../pstack-manager/src/build/engine.ts";
import { problemsOf, validateAll } from "../../pstack-manager/src/validate/index.ts";
import { cli, commitUpstream, git, makeAdapter, makeWorld, type World } from "../helpers.ts";

function synced(): World {
	const world = makeWorld();
	const sync = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.equal(sync.code, 0, sync.out);
	return world;
}

function built(): World & { dist: string } {
	const world = synced();
	const build = cli(world, "build");
	assert.equal(build.code, 0, build.out);
	return { ...world, dist: loadProject(world.paths, "copilot").outDir };
}

function problems(world: World, dist: string): string[] {
	const project = loadProject(world.paths, "copilot");
	return problemsOf(validateAll({ coreDir: world.paths.coreUpstream, distDir: dist, adapter: project.adapter, lock: project.lock, scripts: false }));
}

test("sync copies upstream byte for byte and records provenance", () => {
	const world = synced();
	const lock = JSON.parse(readFileSync(world.paths.lockFile, "utf8"));
	assert.equal(lock.commit, git(world.upstream, "rev-parse", "HEAD"));
	assert.equal(lock.tree, git(world.upstream, "rev-parse", "HEAD:pstack"));
	assert.equal(lock.version, "1.0.0");
	assert.equal(lock.license.holder, "Lauren Tan");
	assert.deepEqual(lock.vocabulary.terms.map((t: { key: string }) => t.key), ["`Task`", '`environment: "cloud"`', "~/.cursor/plugins/"]);
	assert.equal(lock.files["skills/alpha/scripts/run.sh"].mode, "755");
	assert.equal(cli(world, "core", "verify").code, 0);
	assert.match(cli(world, "upstream", "sync", "--source", world.upstream).out, /status: unchanged/);
});

test("sync refuses a dirty upstream checkout, because its files match no commit", () => {
	const world = makeWorld();
	appendFileSync(join(world.upstream, "pstack/README.md"), "local edit\n");
	const result = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.notEqual(result.code, 0);
	assert.match(result.out, /uncommitted changes/);
});

test("core verify catches an edited, added, or chmod-ed core file", () => {
	const world = synced();
	writeFileSync(join(world.paths.coreUpstream, "skills/beta/SKILL.md"), "tampered");
	writeFileSync(join(world.paths.coreUpstream, "extra.md"), "x");
	const result = cli(world, "core", "verify");
	assert.equal(result.code, 1);
	assert.match(result.out, /modified skills\/beta\/SKILL\.md/);
	assert.match(result.out, /unexpected extra\.md/);
});

test("the build ships untouched files byte-identical and adapts only what uses Cursor names", () => {
	const { dist, paths } = built();
	const core = (rel: string) => readFileSync(join(paths.coreUpstream, rel), "utf8");
	const out = (rel: string) => readFileSync(join(dist, rel), "utf8");
	assert.equal(out("skills/beta/SKILL.md"), core("skills/beta/SKILL.md"));
	const alpha = out("skills/alpha/SKILL.md");
	assert.match(alpha, /# Alpha\n\nOn Copilot, read \[the adapter\]\(\.\.\/pstack-copilot\/SKILL\.md\)\.\n\n/);
	assert.match(alpha, /argument-hint: "<task>"\n---/);
	assert.match(alpha, /\]\(\.\.\/pstack-copilot\/upstream\/docs\/guide\/README\.md\)/);
	const readme = out("skills/pstack-copilot/upstream/README.md");
	assert.match(readme, /\]\(\.\.\/\.\.\/alpha\/SKILL\.md\)/);
	const commit = JSON.parse(readFileSync(paths.lockFile, "utf8")).commit;
	assert.ok(readme.includes(`](https://github.com/cursor/plugins/blob/${commit}/pstack/automations/benny/README.md)`), "a link to an excluded file points at GitHub, pinned to the locked commit");
	assert.ok(!existsSync(join(dist, "automations")));
	assert.equal(lstatSync(join(dist, "skills/alpha/scripts/run.sh")).mode & 0o111, 0o111);
	const agent = out("com.github.copilot/agents/helper.agent.md");
	assert.match(agent, /^---\nname: helper\ndescription: A delegate that searches ~\/\.cursor\/plugins\/ for skills\.\nmodel: "claude-opus-5\.5"\nreasoning-effort: "xhigh"\nuser-invocable: false\n---\n/);
	assert.doesNotMatch(agent, /is_background/);
	assert.match(agent, /# Helper\n\nOn Copilot, read the pstack-copilot skill\.\n/);
	const plugin = JSON.parse(out("plugin.json"));
	assert.equal(plugin.version, "1.0.0+copilot.1");
	assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
});

test("validate passes on a clean build and proves every transform reversible", () => {
	const { dist, ...world } = built();
	assert.deepEqual(problems(world, dist), []);
});

test("validate catches a hand-edited build file and an undeclared extra file", () => {
	const { dist, ...world } = built();
	appendFileSync(join(dist, "skills/beta/SKILL.md"), "\nsneaky\n");
	writeFileSync(join(dist, "skills/beta/notes.md"), "extra");
	const found = problems(world, dist).join("\n");
	assert.match(found, /dist file changed after build: skills\/beta\/SKILL\.md/);
	assert.match(found, /skills\/beta\/SKILL\.md is not skills\/beta\/SKILL\.md plus its declared transforms/);
	assert.match(found, /dist file not in manifest: skills\/beta\/notes\.md/);
});

test("a new upstream skill gets a pending entry and the sync prepares it; a new Cursor name blocks it", () => {
	const world = synced();
	assert.equal(cli(world, "build").code, 0);
	commitUpstream(world.upstream, "pstack/skills/gamma/SKILL.md", "---\nname: gamma\ndescription: New. Use for /gamma.\n---\n\n# Gamma\n\nUse the `/loop` command with Plan.\n");
	const prepared = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.equal(prepared.code, 0, prepared.out);
	assert.match(prepared.out, /status: prepared/);
	assert.ok(existsSync(join(world.paths.coreUpstream, "skills/gamma/SKILL.md")));
	assert.match(readFileSync(join(world.repo, "pstack-copilot/mappings/features.json"), "utf8"), /"id": "skill:gamma",\n\t\t\t"kind": "skill",\n\t\t\t"status": "pending"/);
	assert.equal(cli(world, "core", "verify").code, 0);
});

test("an adapter that does not list the core version refuses to build", () => {
	const world = synced();
	makeAdapter(world.repo, "2.0.0");
	const result = cli(world, "build");
	assert.equal(result.code, 1);
	assert.match(result.out, /supports core 2\.0\.0, not 1\.0\.0/);
});

test("install links skills, agents, and instructions, and leaves foreign paths alone", () => {
	const world = synced();
	const foreign = join(world.paths.copilotHome, "skills", "beta");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "SKILL.md"), "mine");
	const result = cli(world, "install", "--skip-scripts");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /left alone.*\n.*skills\/beta/);
	assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "mine");
	const alpha = join(world.paths.copilotHome, "skills", "alpha");
	assert.equal(readlinkSync(alpha), join(world.paths.pstackHome, "current", "skills", "alpha"));
	assert.ok(existsSync(join(alpha, "SKILL.md")));
	assert.ok(existsSync(join(world.paths.copilotHome, "agents", "helper.agent.md")));
	assert.ok(existsSync(join(world.paths.copilotHome, "instructions", "pstack.instructions.md")));
	assert.equal(cli(world, "install", "--skip-scripts").code, 0, "reinstalling the same version is idempotent");
	const removed = cli(world, "uninstall");
	assert.equal(removed.code, 0);
	assert.ok(!existsSync(alpha) && !lstatSync(join(world.paths.copilotHome, "skills")).isSymbolicLink());
	assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "mine", "uninstall never deletes what pstack did not create");
});

test("update to a new adapter revision keeps the old version for rollback", () => {
	const world = synced();
	assert.equal(cli(world, "install", "--skip-scripts").code, 0);
	makeAdapter(world.repo, "1.0.0", 2);
	const updated = cli(world, "update", "--source", world.upstream, "--skip-scripts");
	assert.equal(updated.code, 0, updated.out);
	assert.match(updated.out, /1\.0\.0\+copilot\.1 -> 1\.0\.0\+copilot\.2/);
	assert.match(cli(world, "versions").out, /\* 1\.0\.0\+copilot\.2/);
	const back = cli(world, "rollback");
	assert.equal(back.code, 0, back.out);
	assert.match(back.out, /active version: 1\.0\.0\+copilot\.1/);
	assert.equal(readlinkSync(join(world.paths.pstackHome, "current")), join(world.paths.pstackHome, "versions", "1.0.0+copilot.1"));
	assert.equal(readManifest(join(world.paths.pstackHome, "current")).version, "1.0.0+copilot.1");
});

test("a stored version is immutable: different bytes under the same version need --force", () => {
	const world = synced();
	assert.equal(cli(world, "install", "--skip-scripts").code, 0);
	writeFileSync(join(world.repo, "pstack-copilot/overlays/skills/pstack-copilot/extra.md"), "changed overlay");
	const result = cli(world, "install", "--skip-scripts");
	assert.equal(result.code, 1);
	assert.match(result.out, /already installed with different content/);
});

test("workspace install copies into .github, keeps files the team edited, and uninstalls only its own", () => {
	const world = synced();
	const repo = join(world.home, "project");
	mkdirSync(repo);
	git(repo, "init", "-q");
	const install = cli(world, "install", "--scope", "workspace", "--repo", repo, "--skip-scripts");
	assert.equal(install.code, 0, install.out);
	const skill = join(repo, ".github/skills/alpha/SKILL.md");
	assert.ok(existsSync(skill));
	assert.ok(existsSync(join(repo, ".github/agents/helper.agent.md")));
	assert.ok(existsSync(join(repo, ".github/instructions/pstack.instructions.md")));
	appendFileSync(skill, "\nteam note\n");
	const again = cli(world, "install", "--scope", "workspace", "--repo", repo, "--skip-scripts");
	assert.match(again.out, /kept because you changed them \(1\)/);
	assert.match(readFileSync(skill, "utf8"), /team note/);
	const removed = cli(world, "uninstall", "--scope", "workspace", "--repo", repo);
	assert.equal(removed.code, 0, removed.out);
	assert.ok(existsSync(skill), "the edited skill stays");
	assert.ok(!existsSync(join(repo, ".github/skills/beta")));
	assert.ok(!existsSync(join(repo, ".github/pstack-install.json")));
});

test("models init writes the always-applied instruction and will not clobber choices", () => {
	const world = synced();
	assert.equal(cli(world, "models", "init", "--budget", "small").code, 0);
	const file = join(world.paths.copilotHome, "instructions", "pstack-models.instructions.md");
	assert.match(readFileSync(file, "utf8"), /feature, refactoring: claude-opus-5\.5 @medium/);
	assert.equal(cli(world, "models", "init").code, 1);
});
