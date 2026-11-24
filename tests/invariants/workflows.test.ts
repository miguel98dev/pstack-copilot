import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "../helpers.ts";

const dir = join(REPO, ".github", "workflows");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

test("the upstream sync runs every day and on demand, and delegates to pstack", () => {
	const sync = read("upstream-sync.yml");
	assert.match(sync, /schedule:\n\s+- cron: "\d+ \d+ \* \* \*"/, "a daily cron");
	assert.match(sync, /workflow_dispatch:/);
	for (const input of ["ref:", "dry_run:", "include_rolled_back:", "allow_downgrade:"]) assert.ok(sync.includes(input), input);
	assert.match(sync, /pstack upstream check .*--exit-code/s);
	assert.match(sync, /pstack upstream run /);
	assert.match(sync, /--scripts/, "upstream's script tests run as part of the compatibility checks");
	assert.match(sync, /concurrency:\n\s+group: upstream-sync/);
});

test("no workflow or source file merges, auto-merges, or approves anything", () => {
	const sources = [...readdirSync(dir).map((name) => join(dir, name)), join(REPO, "pstack-manager/src/upstream/publish.ts"), join(REPO, "pstack-manager/src/commands/upstream.ts")];
	for (const file of sources) {
		const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		assert.doesNotMatch(text, /pr merge|--auto\b|--admin|enablePullRequestAutoMerge|merge_method|gh pr review|--approve/, file);
		assert.doesNotMatch(text, /\["merge"|'merge'|"pulls\/\d+\/merge"|\/merge`/, file);
	}
});

test("the sync workflows ask for the permissions they use and no more", () => {
	assert.match(read("upstream-sync.yml"), /permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+issues: write\n/);
	assert.match(read("upstream-rollback.yml"), /permissions:\n\s+contents: write\n\s+pull-requests: write\n(?!\s+issues)/);
	assert.doesNotMatch(read("ci.yml"), /permissions:\s*\n\s+(contents|pull-requests): write/, "ci stays read only");
});

test("the rollback workflow opens a pull request and does not merge it", () => {
	const rollback = read("upstream-rollback.yml");
	assert.match(rollback, /workflow_dispatch:/);
	assert.match(rollback, /pstack upstream rollback --pr/);
	assert.match(rollback, /fetch-depth: 0/, "git revert needs the history");
});
