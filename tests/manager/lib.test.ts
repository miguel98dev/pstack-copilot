import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../../pstack-manager/src/build/classify.ts";
import { copilotValue, renderModelsInstruction } from "../../pstack-manager/src/build/models.ts";
import { frontString, frontValue, parseFrontmatter } from "../../pstack-manager/src/lib/frontmatter.ts";
import { injectAfterH1, removeInjection, reverseLinks, rewriteLinks } from "../../pstack-manager/src/lib/markdown.ts";

test("frontmatter reads the scalar forms pstack uses", () => {
	const fm = parseFrontmatter('---\nname: arena\ndescription: "Say \\"hi\\": now"\nflag: true\nlist: ["a", \'b\']\nfolded: >-\n  one\n  two\n---\n# Body\n');
	assert.equal(frontString(fm, "name"), "arena");
	assert.equal(frontString(fm, "description"), 'Say "hi": now');
	assert.equal(frontValue(fm, "flag"), true);
	assert.deepEqual(frontValue(fm, "list"), ["a", "b"]);
	assert.equal(frontString(fm, "folded"), "one two");
	assert.equal(fm.body, "# Body\n");
});

test("frontmatter rejects syntax it does not understand instead of misreading it", () => {
	assert.throws(() => parseFrontmatter("---\n- item\n---\n"), /unsupported frontmatter line/);
});

test("link rewrites reverse to the original bytes", () => {
	const text = "See [a](../../README.md#top), [b](https://x.y), and [c](../beta/SKILL.md).";
	const { text: out, rewrites } = rewriteLinks(text, (href) => (href.startsWith("../../") ? href.replace("../../", "../pstack-copilot/upstream/") : undefined));
	assert.equal(out, "See [a](../pstack-copilot/upstream/README.md#top), [b](https://x.y), and [c](../beta/SKILL.md).");
	assert.equal(reverseLinks(out, rewrites), text);
});

test("the adapter line is a pure insertion after the first H1 outside a code fence", () => {
	const original = "---\nname: x\n---\n\n```md\n# not a heading\n```\n# Title\n\nBody\n";
	const head = original.indexOf("\n---\n") + 5;
	const { text, injection } = injectAfterH1(original, head, "LINE");
	assert.match(text, /# Title\n\nLINE\n\nBody/);
	assert.equal(removeInjection(text, injection), original);
});

test("a file with no H1 gets the line after its frontmatter", () => {
	const original = "---\nname: bro\n---\nRestate it.\n";
	const { text, injection } = injectAfterH1(original, original.indexOf("Restate"), "LINE");
	assert.equal(text, "---\nname: bro\n---\nLINE\n\nRestate it.\n");
	assert.equal(removeInjection(text, injection), original);
});

test("classify finds terms and bare skill routes but accepts a linked route", () => {
	const vocabulary = { terms: [{ key: "`Task`", pattern: "`Task`", flags: "" }], routeKey: "Run another pstack skill" };
	assert.deepEqual([...classify(["Spawn a `Task`."], vocabulary, ["beta"]).keys], ["`Task`"]);
	assert.deepEqual([...classify(["Run the **beta** skill."], vocabulary, ["beta"]).keys], ["Run another pstack skill"]);
	assert.deepEqual([...classify(["Run the **beta** skill ([link](../beta/SKILL.md))."], vocabulary, ["beta"]).keys], []);
});

const RULES = {
	ladder: ["low", "medium", "high", "xhigh"],
	slugs: [
		{ pattern: "^claude-opus-5-5-(low|medium|high|xhigh)(-fast)?$", model: "claude-opus-5.5" },
		{ pattern: "^gemini-4-neon-(low|medium|high|xhigh)$", model: "gemini-4-neon" },
	],
	roles: [{ role: "swarm workers", cursor: ["claude-opus-5-5-high-fast"] }],
	panelRoles: [],
};

test("Cursor slugs map to Copilot ids with the effort split out, lowered by the budget", () => {
	assert.equal(copilotValue("claude-opus-5-5-xhigh-fast", RULES), "claude-opus-5.5 @xhigh");
	assert.equal(copilotValue("claude-opus-5-5-high-fast", RULES, "medium"), "claude-opus-5.5 @medium");
	assert.equal(copilotValue("gemini-4-neon-xhigh", RULES, "small"), "gemini-4-neon @medium");
	assert.equal(copilotValue("claude-opus-5-5-low-fast", RULES, "small"), "claude-opus-5.5 @low");
	assert.equal(copilotValue("inherit-parent", RULES), "inherit-parent");
	assert.throws(() => copilotValue("claude-fable-5-2-high", RULES), /no Copilot mapping/);
});

test("the models instruction is always-applied and keeps setup-pstack's markers", () => {
	const text = renderModelsInstruction(RULES, "large");
	assert.match(text, /^---\napplyTo: "\*\*"\n/);
	assert.match(text, /\n# defaults: 3\n# budget: large \(xhigh\)\nswarm workers: claude-opus-5.5 @high\n$/);
});
