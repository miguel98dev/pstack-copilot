import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildDist } from "../../pstack-manager/src/build/engine.ts";
import { loadProject } from "../../pstack-manager/src/build/project.ts";
import { remove } from "../../pstack-manager/src/lib/fs.ts";
import { resolvePaths } from "../../pstack-manager/src/paths.ts";
import { verifyTree } from "../../pstack-manager/src/upstream/lock.ts";
import { problemsOf, validateAll } from "../../pstack-manager/src/validate/index.ts";
import { REPO, tempDir } from "../helpers.ts";

const paths = resolvePaths({ ...process.env, PSTACK_REPO: REPO });
const project = loadProject(paths, "copilot");
const dist = join(tempDir("real-dist"), "dist");
const build = buildDist({ coreDir: paths.coreUpstream, lock: project.lock, adapter: project.adapter, outDir: dist });

test.after(() => remove(join(dist, "..")));

test("pstack-core is byte-identical to the locked upstream commit", () => {
	assert.deepEqual(verifyTree(paths.coreUpstream, project.lock), []);
	assert.equal(project.lock.repository, "https://github.com/cursor/plugins");
	assert.equal(project.lock.license.holder, "Lauren Tan");
});

test("the Copilot build passes every structural check", () => {
	assert.deepEqual(problemsOf(validateAll({ coreDir: paths.coreUpstream, distDir: dist, adapter: project.adapter, lock: project.lock, scripts: false })), []);
});

test("every skill upstream adapts for Claude Code is adapted for Copilot too", () => {
	const upstreamClaudeWrapped = ["architect", "arena", "automate-me", "create-formal-verification-skill", "create-verification-skill", "figure-it-out", "how", "interrogate", "maintain-formal-verification-skill", "maintain-verification-skill", "make-bot-ui", "no-comments", "poteto-help", "poteto-mode", "principle-type-system-discipline", "recall", "reflect", "setup-pstack", "show-me-your-work", "swarm", "teach", "technical-writing"];
	const wrapped = new Set(build.manifest.files.filter((f) => f.transforms.some((t) => t.type === "inject-adapter-line")).map((f) => f.path));
	for (const skill of upstreamClaudeWrapped) assert.ok(wrapped.has(`skills/${skill}/SKILL.md`), `${skill} lacks the adapter line`);
});

test("principles and plain skills reach Copilot unchanged", () => {
	for (const skill of ["principle-prove-it-works", "principle-laziness-protocol", "bro", "in-your-own-words", "correct"]) {
		const rel = `skills/${skill}/SKILL.md`;
		assert.equal(readFileSync(join(dist, rel), "utf8"), readFileSync(join(paths.coreUpstream, rel), "utf8"), skill);
	}
});

test("the workflows the port must carry are shipped as slash skills with the adapter", () => {
	for (const skill of ["poteto-mode", "tdd", "architect", "arena", "swarm", "interrogate"]) {
		const text = readFileSync(join(dist, "skills", skill, "SKILL.md"), "utf8");
		assert.match(text, /disable-model-invocation: true/, skill);
	}
	for (const skill of ["poteto-mode", "architect", "arena", "swarm", "interrogate"]) {
		assert.match(readFileSync(join(dist, "skills", skill, "SKILL.md"), "utf8"), /read \[the Copilot adapter\]\(\.\.\/pstack-copilot\/SKILL\.md\)/, skill);
	}
	assert.match(readFileSync(join(dist, "com.github.copilot/agents/poteto-mode.agent.md"), "utf8"), /skills: \["pstack-copilot", "poteto-mode"\]/);
});

test("the agents keep upstream's text and gain Copilot's model fields", () => {
	const agent = readFileSync(join(dist, "com.github.copilot/agents/poteto-agent.agent.md"), "utf8");
	assert.match(agent, /\nmodel: "claude-opus-5\.5"\nreasoning-effort: "xhigh"\nuser-invocable: false\n/);
	assert.doesNotMatch(agent, /is_background|claude-opus-5-5-xhigh-fast/);
});
