import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Creates the git repositories the VS Code validation runs in, one per scenario in scenarios.json.
 * Each repository carries a repository-level pstack-models instruction with inexpensive models from
 * three vendors, so the runs exercise per-role models, vendor checks, and the repository override.
 */

const MODELS = `---
applyTo: "**"
description: "pstack per-role model choices for GitHub Copilot (overrides skill defaults)"
---
# pstack model configuration for the e2e fixtures: inexpensive models from three vendors.
# defaults: 3
# budget: small (medium)
feature, refactoring: claude-haiku-5.5 @medium
bug-fix: claude-haiku-5.5 @medium
perf-issue: claude-haiku-5.5 @medium
hillclimb: claude-haiku-5.5 @medium
judgment and prose: claude-sonnet-5.5 @medium
arena runners: claude-haiku-5.5 @low, gpt-5.6-luna @low, gemini-3.8-flash @low
arena cross-judge pool: gemini-3.8-flash @low, gpt-5.6-luna @low
swarm workers: claude-haiku-5.5 @low
interrogate reviewers: claude-haiku-5.5 @low, gpt-5.6-luna @low, gemini-3.8-flash @low
`;

const PACKAGE = `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`;

type Files = Record<string, string | { text: string; mode: number }>;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repo(root: string, name: string, files: Files, message: string): string {
	const dir = join(root, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "e2e@pstack.invalid");
	git(dir, "config", "user.name", "pstack e2e");
	add(dir, { "package.json": PACKAGE, ".github/instructions/pstack-models.instructions.md": MODELS, ...files });
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return dir;
}

function add(dir: string, files: Files): void {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		const { text, mode } = typeof content === "string" ? { text: content, mode: 0o644 } : content;
		writeFileSync(path, text);
		chmodSync(path, mode);
	}
}

export function makeFixtures(root: string): string[] {
	const made: string[] = [];
	made.push(
		repo(root, "tdd", {
			"src/slug.js": 'export function slugify(text) {\n\treturn text.trim().toLowerCase().replace(/ /g, "-").replace(/[^a-z0-9-]/g, "");\n}\n',
			"test/slug.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { slugify } from "../src/slug.js";\n\ntest("lowercases and hyphenates words", () => {\n\tassert.equal(slugify("Hello World"), "hello-world");\n});\n',
		}, "add slugify"),
	);
	made.push(
		repo(root, "architect", {
			"src/client.js": 'export async function request(url, options = {}) {\n\tconst response = await fetch(url, options);\n\tif (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);\n\treturn response.json();\n}\n',
			"src/users.js": 'import { request } from "./client.js";\n\nexport const getUser = (id) => request(`https://api.example.com/users/${id}`);\nexport const listUsers = () => request("https://api.example.com/users");\n',
			"src/orders.js": 'import { request } from "./client.js";\n\nexport const getOrder = (id) => request(`https://api.example.com/orders/${id}`);\nexport async function getOrdersFor(userIds) {\n\treturn Promise.all(userIds.map((id) => request(`https://api.example.com/users/${id}/orders`)));\n}\n',
		}, "add API client"),
	);
	made.push(repo(root, "arena", { "src/.keep": "", "test/.keep": "" }, "empty project"));
	const check = (body: string) => ({ text: `#!/bin/sh\nset -e\ncd "$(dirname "$0")"\n${body}\n`, mode: 0o755 });
	made.push(
		repo(root, "swarm", {
			"packages/alpha/package.json": '{ "name": "alpha", "version": "1.0.0" }\n',
			"packages/alpha/check.sh": check('grep -q \'"version"\' package.json && echo "alpha ok"'),
			"packages/beta/package.json": '{ "name": "beta" }\n',
			"packages/beta/check.sh": check('grep -q \'"version"\' package.json || { echo "beta: package.json has no version" >&2; exit 1; }\necho "beta ok"'),
			"packages/gamma/package.json": '{ "name": "gamma", "version": "0.3.1" }\n',
			"packages/gamma/check.sh": check('grep -q \'"version"\' package.json && echo "gamma ok"'),
		}, "add packages"),
	);
	const interrogate = repo(root, "interrogate", { "src/index.js": 'export { paginate } from "./paginate.js";\n', "src/paginate.js": "export function paginate() {\n\tthrow new Error(\"not implemented\");\n}\n" }, "scaffold paginate");
	git(interrogate, "checkout", "-q", "-b", "feature/paginate");
	add(interrogate, {
		"src/paginate.js": "/** Returns one 1-based page of items. The last page may be partial. */\nexport function paginate(items, page, size) {\n\tconst totalPages = Math.floor(items.length / size);\n\tconst start = (page - 1) * size;\n\treturn { items: items.slice(start, start + size), page, totalPages };\n}\n",
		"test/paginate.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { paginate } from "../src/paginate.js";\n\ntest("first page", () => {\n\tassert.deepEqual(paginate([1, 2, 3, 4], 1, 2), { items: [1, 2], page: 1, totalPages: 2 });\n});\n',
	});
	git(interrogate, "add", "-A");
	git(interrogate, "commit", "-q", "-m", "feat(paginate): return one 1-based page with totalPages\n\nIntent: paginate(items, page, size) returns the items of a 1-based page, the page number, and totalPages, the number of pages needed to show every item. The last page may be partial.");
	made.push(interrogate);
	made.push(
		repo(root, "poteto-mode", {
			"src/stats.js": "export function median(values) {\n\tconst sorted = values.sort();\n\tconst middle = Math.floor(sorted.length / 2);\n\treturn sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];\n}\n",
			"test/stats.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { median } from "../src/stats.js";\n\ntest("median of one-digit values", () => {\n\tassert.equal(median([3, 1, 2]), 2);\n});\n',
		}, "add median"),
	);
	const noComments = repo(root, "no-comments", { "src/total.js": "export function total(items) {\n\treturn items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n}\n" }, "add total");
	git(noComments, "checkout", "-q", "-b", "feature/discount");
	add(noComments, {
		"src/total.js": "// This function calculates the total price of all items in the cart.\nexport function total(items, discount = 0) {\n\t// Loop over every item and add up price times quantity.\n\tconst sum = items.reduce((acc, item) => acc + item.price * item.quantity, 0);\n\t// IMPORTANT: do not remove this clamp, it is too risky.\n\tconst safe = Math.max(0, discount);\n\t// Apply the discount.\n\t// const old = sum * discount;\n\treturn sum - sum * safe;\n}\n",
	});
	git(noComments, "add", "-A");
	git(noComments, "commit", "-q", "-m", "feat(total): apply a fractional discount");
	made.push(noComments);
	made.push(repo(root, "loop", { "README.md": "# loop fixture\n\nA background job writes `ready.txt` when it finishes.\n" }, "add readme"));
	return made;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const root = resolve(process.argv[2] || "/tmp/pstack-e2e");
	for (const dir of makeFixtures(root)) process.stdout.write(`${dir}\n`);
}
