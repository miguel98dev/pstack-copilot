import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadAdapter } from "../../pstack-manager/src/build/adapter.ts";
import { exists, sha256, walkFiles } from "../../pstack-manager/src/lib/fs.ts";
import { transaction } from "../../pstack-manager/src/lib/tx.ts";
import { detectRenames, diffLocks, similarity } from "../../pstack-manager/src/upstream/diff.ts";
import { type SyncHistory } from "../../pstack-manager/src/upstream/history.ts";
import { readLock } from "../../pstack-manager/src/upstream/lock.ts";
import { cli, commitUpstream, evolveUpstream, git, makeGitWorld, readState, tempDir, write, type GitWorld } from "../helpers.ts";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const history = (world: GitWorld): SyncHistory => json(world.paths.historyFile);
const features = (world: GitWorld): { id: string; status: string; validation: string; limits?: string }[] => json(join(world.repo, "pstack-copilot/mappings/features.json")).features;
const feature = (world: GitWorld, id: string) => features(world).find((entry) => entry.id === id);
const overlayHashes = (world: GitWorld) => {
	const root = join(world.repo, "pstack-copilot");
	const files = [...walkFiles(join(root, "overlays")).map((p) => `overlays/${p}`), "mappings/terms.json", "mappings/models.json"];
	return Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))]));
};
const commitAll = (world: GitWorld, message: string) => {
	git(world.repo, "add", "-A");
	git(world.repo, "commit", "-q", "-m", message);
};

test("similarity pairs a moved and edited file but not two unrelated ones", () => {
	const a = "# Feature\n\nBuild it.\n\n1. Trace.\n2. Name the shape.\n";
	assert.ok(similarity(a, `${a}3. Verify.\n`) >= 0.6);
	assert.ok(similarity(a, "# Other\n\nNothing alike.\n") < 0.3);
	const lock = (files: Record<string, string>) => ({ files: Object.fromEntries(Object.entries(files).map(([p, h]) => [p, { sha256: h, size: 1, mode: "644" }])) }) as never;
	const pairs = detectRenames(["a/one.md", "b/one.md"], ["c/one.md"], lock({ "a/one.md": "h", "b/one.md": "h" }), lock({ "c/one.md": "h" }));
	assert.equal(pairs.length, 1, "identical files pair one to one");
});

test("diff reports added, modified, deleted, renamed, and mode-changed files with the items they belong to", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	const result = cli(world, "upstream", "check", "--source", world.upstream, "--json");
	assert.equal(result.code, 0, result.out);
	const report = JSON.parse(result.out);
	const by = (kind: string) => report.changes.filter((c: { kind: string }) => c.kind === kind).map((c: { path: string }) => c.path);
	assert.deepEqual(by("added"), ["agents/scout.md", "skills/gamma/SKILL.md"]);
	assert.deepEqual(by("deleted"), ["automations/benny/README.md"]);
	assert.deepEqual(by("modified"), ["README.md", "plugin.json", "skills/beta/SKILL.md"]);
	const renamed = report.changes.filter((c: { kind: string }) => c.kind === "renamed");
	const script = renamed.find((c: { path: string }) => c.path.endsWith("exec.sh"));
	assert.equal(script.from, "skills/alpha/scripts/run.sh");
	assert.equal(script.similarity, 1);
	const playbook = renamed.find((c: { path: string }) => c.path.endsWith("build.md"));
	assert.equal(playbook.from, "skills/poteto-mode/playbooks/feature.md");
	assert.ok(playbook.similarity >= 0.6 && playbook.similarity < 1);
	assert.deepEqual(report.counts, { added: 2, modified: 3, deleted: 1, renamed: 2, "mode-changed": 0 });
	const item = (kind: string, name: string) => report.items.find((i: { kind: string; name: string }) => i.kind === kind && i.name === name);
	assert.equal(item("skill", "gamma").change, "added");
	assert.equal(item("agent", "scout").change, "added");
	assert.equal(item("skill", "beta").change, "modified");
	assert.equal(item("automation", "benny").change, "removed");
	assert.equal(item("playbook", "build").from, "feature");
	assert.equal(item("script", "skills/alpha/scripts/exec.sh").from, "skills/alpha/scripts/run.sh");
	assert.equal(report.status, "dry-run");
	assert.equal(git(world.repo, "status", "--porcelain"), "", "check writes nothing");
});

test("mode changes are reported without a content change", () => {
	const world = makeGitWorld();
	const before = readLock(world.paths.lockFile);
	const after = JSON.parse(JSON.stringify(before));
	after.files["skills/beta/SKILL.md"].mode = "755";
	const diff = diffLocks(before, after);
	assert.deepEqual(diff.changes, [{ kind: "mode-changed", path: "skills/beta/SKILL.md", oldMode: "644", newMode: "755" }]);
});

test("a full sync keeps upstream exact, prepares the migration, keeps Copilot files, and records history", () => {
	const world = makeGitWorld();
	const hashes = overlayHashes(world);
	const marked = json(join(world.repo, "pstack-copilot/mappings/features.json"));
	marked.features.find((f: { id: string }) => f.id === "skill:beta").validation = "vscode-validated";
	marked.features.find((f: { id: string }) => f.id === "skill:beta").evidence = "tests/e2e/RESULTS.md beta";
	writeFileSync(join(world.repo, "pstack-copilot/mappings/features.json"), `${JSON.stringify(marked, null, "\t")}\n`);
	commitAll(world, "validate beta");
	evolveUpstream(world.upstream);

	const result = cli(world, "upstream", "sync", "--source", world.upstream, "--trigger", "schedule", "--report-out", join(world.home, "out.md"));
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /status: prepared/);

	assert.equal(cli(world, "core", "verify").code, 0, "core is still byte-identical to the new lock");
	for (const path of ["skills/gamma/SKILL.md", "agents/scout.md", "skills/alpha/scripts/exec.sh"]) {
		assert.equal(sha256(readFileSync(join(world.paths.coreUpstream, path))), sha256(readFileSync(join(world.upstream, "pstack", path))), path);
	}
	assert.ok(!exists(join(world.paths.coreUpstream, "skills/alpha/scripts/run.sh")));
	assert.deepEqual(overlayHashes(world), hashes, "overlays and hand-written mappings are untouched");

	assert.equal(feature(world, "skill:gamma")?.status, "pending");
	assert.equal(feature(world, "agent:scout")?.status, "pending");
	assert.ok(feature(world, "playbook:build"), "the playbook entry follows the rename");
	assert.ok(!feature(world, "playbook:feature"));
	assert.ok(feature(world, "script:skills/alpha/scripts/exec.sh"));
	assert.ok(!feature(world, "automation:benny"));
	assert.equal(feature(world, "skill:beta")?.validation, "stale");
	assert.match(feature(world, "skill:beta")?.limits || "", /Upstream changed this in 1\.1\.0/);
	const agents = json(join(world.repo, "pstack-copilot/mappings/agents.json")).agents;
	assert.deepEqual(agents.scout.drop, ["is_background", "model"]);
	assert.equal(agents.scout.set.model, "claude-opus-5.5");
	assert.equal(agents.scout.set["reasoning-effort"], "high");
	assert.equal(agents.scout.set["user-invocable"], false);
	const adapter = json(join(world.repo, "pstack-copilot/adapter.json"));
	assert.deepEqual(adapter.coreVersions, ["1.1.0"]);
	assert.equal(adapter.revision, 2);
	assert.match(readFileSync(join(world.repo, "pstack-copilot/docs/COMPATIBILITY.md"), "utf8"), /Pending review/);
	assert.equal(loadAdapter(join(world.repo, "pstack-copilot")).features.length, features(world).length);

	const entries = history(world).entries;
	assert.equal(entries.length, 2);
	const record = entries[1];
	assert.equal(record.kind, "sync");
	assert.equal(record.status, "prepared");
	assert.equal(record.trigger, "schedule");
	assert.equal(record.from?.version, "1.0.0");
	assert.equal(record.to.version, "1.1.0");
	assert.equal(record.to.commit, git(world.upstream, "rev-parse", "HEAD"));
	assert.equal(record.to.tree, git(world.upstream, "rev-parse", "HEAD:pstack"));
	assert.deepEqual(record.counts, { added: 2, modified: 3, deleted: 1, renamed: 2, "mode-changed": 0 });
	assert.equal(record.adapter.revisionAfter, 2);
	assert.equal(record.validation.passed, true);
	assert.deepEqual(record.conflicts, []);
	assert.ok(record.migration.length > 5);
	assert.equal(readLock(world.paths.lockFile).commit, record.to.commit);

	const report = readFileSync(join(world.repo, record.report as string), "utf8");
	assert.equal(report, readFileSync(join(world.home, "out.md"), "utf8"));
	for (const heading of ["# Upstream sync: pstack 1.0.0 to 1.1.0", "## Changed files", "## Impact on the Copilot adaptation", "## Migration prepared", "## Compatibility checks", "## Roll back"]) assert.match(report, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(report, /\| renamed \| `skills\/poteto-mode\/playbooks\/feature\.md` \| `skills\/poteto-mode\/playbooks\/build\.md` \| \d+% similar/);
	assert.match(report, /VS Code validations now stale: `skill:beta`/);
	assert.match(report, /Review: upstream changed what the adaptation depends on/);
	assert.match(report, /skills\/pstack-copilot\/SKILL\.md/, "the watch rule names the adapter skill that mentions beta");
	assert.match(readFileSync(join(world.paths.coreDir, "CHANGELOG.upstream.md"), "utf8"), /## 1\.1\.0/);
	assert.ok(exists(join(world.repo, record.report as string).replace(/\.md$/, ".json")));
	assert.equal(json(join(world.repo, record.report as string).replace(/\.md$/, ".json")).status, "prepared");
});

test("a new Cursor name without an adapter row blocks a plain sync and needs adapter work under --prepare", () => {
	const world = makeGitWorld();
	const generator = join(world.upstream, "scripts/generate-pstack-harness-trees.mjs");
	commitUpstream(world.upstream, "scripts/generate-pstack-harness-trees.mjs", readFileSync(generator, "utf8").replace("];\nconst ROUTE_KEY", '  { key: "Canvas", re: /Canvas/ },\n];\nconst ROUTE_KEY'));
	commitUpstream(world.upstream, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta now draws on a Canvas. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nOpen a Canvas.\n");
	const blocked = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.equal(blocked.code, 1, blocked.out);
	assert.match(blocked.out, /status: blocked/);
	assert.match(blocked.out, /failing check: adapter maps every Cursor term in use/);
	assert.equal(cli(world, "core", "verify").code, 0);
	assert.equal(git(world.repo, "status", "--porcelain"), "", "a blocked sync writes nothing");
	assert.equal(history(world).entries.length, 1);

	const prepared = cli(world, "upstream", "sync", "--source", world.upstream, "--prepare");
	assert.equal(prepared.code, 0, prepared.out);
	assert.match(prepared.out, /status: needs-adapter-work/);
	assert.equal(cli(world, "core", "verify").code, 0, "the core is updated to the new upstream");
	const record = history(world).entries[1];
	assert.equal(record.status, "needs-adapter-work");
	assert.ok(record.validation.failed.includes("adapter maps every Cursor term in use"));
	const report = readFileSync(join(world.repo, record.report as string), "utf8");
	assert.match(report, /## What a human has to do/);
	assert.match(report, /- \[ \] `skills\/pstack-copilot\/SKILL\.md`: Cursor name Canvas has no row in the adapter skill/);
	assert.match(report, /- \[ \] Fix the failing check \*\*adapter maps every Cursor term in use\*\*/);
	assert.ok(feature(world, "term:Canvas"), "a pending entry exists for the new term");
});

test("conflicts stop the sync before anything is written", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	const run = (...extra: string[]) => cli(world, "upstream", "sync", "--source", world.upstream, ...extra);
	const untouched = () => {
		assert.equal(readLock(world.paths.lockFile).version, "1.0.0");
		assert.equal(history(world).entries.length, 1);
	};

	writeFileSync(join(world.paths.coreUpstream, "skills/beta/SKILL.md"), "tampered");
	let result = run();
	assert.equal(result.code, 1);
	assert.match(result.out, /CONFLICT core-modified/);
	assert.equal(readFileSync(join(world.paths.coreUpstream, "skills/beta/SKILL.md"), "utf8"), "tampered", "local edits are never overwritten");
	untouched();
	git(world.repo, "checkout", "-q", "--", "pstack-core");

	appendFileSync(join(world.repo, "pstack-copilot/mappings/skills.json"), "\n");
	result = run();
	assert.match(result.out, /CONFLICT uncommitted-changes/);
	assert.equal(result.code, 1);
	untouched();
	git(world.repo, "checkout", "-q", "--", "pstack-copilot");

	write(world.upstream, "pstack/skills/pstack-copilot/SKILL.md", "---\nname: pstack-copilot\ndescription: Upstream grabs the adapter's name.\n---\n\n# Upstream\n");
	git(world.upstream, "add", "-A");
	git(world.upstream, "commit", "-q", "-m", "collide");
	result = run();
	assert.match(result.out, /CONFLICT overlay-collision/);
	assert.match(result.out, /overlay-collision/);
	assert.equal(result.code, 1);
	assert.match(readFileSync(join(world.repo, "pstack-copilot/overlays/skills/pstack-copilot/SKILL.md"), "utf8"), /# Adapter/, "the custom Copilot skill is untouched");
	untouched();
});

test("a rewritten upstream history and a version downgrade are blocking, with their own overrides", () => {
	const world = makeGitWorld();
	const locked = readLock(world.paths.lockFile).commit;
	git(world.upstream, "reset", "-q", "--hard", `${locked}~0`);
	git(world.upstream, "checkout", "-q", "--orphan", "rewritten");
	commitUpstream(world.upstream, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Rewritten. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nRewritten history.\n");
	let result = cli(world, "upstream", "check", "--source", world.upstream);
	assert.match(result.out, /CONFLICT history-diverged/);
	assert.equal(result.code, 1);
	result = cli(world, "upstream", "check", "--source", world.upstream, "--allow-rewrite");
	assert.doesNotMatch(result.out, /CONFLICT history-diverged/);
	assert.match(result.out, /warning history-diverged/);

	const world2 = makeGitWorld();
	evolveUpstream(world2.upstream, "0.9.0");
	result = cli(world2, "upstream", "check", "--source", world2.upstream);
	assert.match(result.out, /CONFLICT version-downgrade/);
	result = cli(world2, "upstream", "check", "--source", world2.upstream, "--allow-downgrade");
	assert.doesNotMatch(result.out, /CONFLICT version-downgrade/);
});

test("when only upstream's other folders change, nothing is proposed", () => {
	const world = makeGitWorld();
	commitUpstream(world.upstream, "other-plugin/README.md", "# unrelated\n");
	const result = cli(world, "upstream", "check", "--source", world.upstream, "--exit-code");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /status: unchanged/);
});

test("check signals changes with exit code 10 and writes nothing", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	const result = cli(world, "upstream", "check", "--source", world.upstream, "--exit-code");
	assert.equal(result.code, 10, result.out);
	assert.equal(git(world.repo, "status", "--porcelain"), "");
	assert.equal(readLock(world.paths.lockFile).version, "1.0.0");
});

test("run opens a pull request on a branch, never touches the base branch, and never merges", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	const baseHead = git(world.repo, "rev-parse", "HEAD");
	const result = cli(world, "upstream", "run", "--source", world.upstream, "--trigger", "schedule", "--author-name", "sync-bot", "--author-email", "bot@example.com");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /action: pull-request: https:\/\/example\.test\/pull\/1/);

	const to = git(world.upstream, "rev-parse", "HEAD").slice(0, 12);
	const branch = `sync/upstream-${to}`;
	assert.equal(git(world.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
	assert.equal(git(world.repo, "rev-parse", "HEAD"), baseHead, "the base branch has no new commit");
	assert.equal(git(world.repo, "status", "--porcelain"), "", "the base working tree is clean again");
	assert.equal(readLock(world.paths.lockFile).version, "1.0.0", "main still holds the old lock until a person merges");
	assert.match(git(world.repo, "ls-remote", "--heads", "origin", branch), /^[0-9a-f]{40}\trefs\/heads\/sync\/upstream-/, "the branch is on the remote");
	assert.equal(git(world.repo, "log", "-1", "--format=%an <%ae>", branch), "sync-bot <bot@example.com>");
	const changed = git(world.repo, "diff", "--name-only", `main..${branch}`).split("\n");
	assert.ok(changed.includes("pstack-core/UPSTREAM.lock.json") && changed.includes("docs/sync/history.json") && changed.includes("pstack-copilot/mappings/features.json"));
	assert.ok(changed.some((file) => file.startsWith("docs/sync/reports/")));
	assert.ok(!changed.some((file) => file.startsWith("pstack-copilot/overlays/")), "no custom Copilot file is part of the sync commit");

	const state = readState(world.gh.state);
	assert.equal(state.prs.length, 1);
	const pr = state.prs[0];
	assert.equal(pr.base, "main");
	assert.equal(pr.head, branch);
	assert.equal(pr.draft, false);
	assert.deepEqual(pr.labels, ["upstream-sync"]);
	assert.match(pr.title, /^chore\(sync\): pstack 1\.0\.0 to 1\.1\.0 \(/);
	assert.match(pr.body, /# Upstream sync: pstack 1\.0\.0 to 1\.1\.0/);
	assert.match(pr.body, /Never merged by automation\. A person reviews and merges\./);

	const verbs = world.gh.calls().map((call) => call.slice(0, 2).join(" "));
	assert.ok(verbs.includes("pr create"));
	assert.ok(!verbs.some((verb) => /merge|close|ready/.test(verb)), `gh calls: ${verbs.join(", ")}`);
	assert.ok(!world.gh.calls().some((call) => call.includes("--auto")));

	const again = cli(world, "upstream", "run", "--source", world.upstream, "--author-name", "sync-bot", "--author-email", "bot@example.com");
	assert.equal(again.code, 0, again.out);
	assert.equal(readState(world.gh.state).prs.length, 1, "a second run updates the pull request instead of opening another");
	assert.ok(world.gh.calls().some((call) => call[0] === "pr" && call[1] === "edit"));
});

test("a sync that needs adapter work opens a draft pull request labeled for it", () => {
	const world = makeGitWorld();
	const generator = join(world.upstream, "scripts/generate-pstack-harness-trees.mjs");
	commitUpstream(world.upstream, "scripts/generate-pstack-harness-trees.mjs", readFileSync(generator, "utf8").replace("];\nconst ROUTE_KEY", '  { key: "Canvas", re: /Canvas/ },\n];\nconst ROUTE_KEY'));
	commitUpstream(world.upstream, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta draws on a Canvas. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nOpen a Canvas.\n");
	const result = cli(world, "upstream", "run", "--source", world.upstream, "--author-name", "b", "--author-email", "b@example.com");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /draft, needs adapter work/);
	const pr = readState(world.gh.state).prs[0];
	assert.equal(pr.draft, true);
	assert.deepEqual(pr.labels, ["upstream-sync", "needs-adapter-work"]);
	assert.match(pr.body, /What a human has to do/);
});

test("a conflict opens one issue and no branch, and a repeat run does not open another", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	writeFileSync(join(world.paths.coreUpstream, "skills/beta/SKILL.md"), "tampered");
	const run = () => cli(world, "upstream", "run", "--source", world.upstream);
	let result = run();
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /action: issue: https:\/\/example\.test\/issues\/1/);
	let state = readState(world.gh.state);
	assert.equal(state.issues.length, 1);
	assert.deepEqual(state.issues[0].labels, ["upstream-sync", "sync-conflict"]);
	assert.match(state.issues[0].body, /core-modified/);
	assert.equal(state.prs.length, 0);
	assert.equal(git(world.repo, "branch", "--list", "sync/*"), "");
	result = run();
	state = readState(world.gh.state);
	assert.equal(state.issues.length, 1, "an open issue already tracks it");
	assert.equal(readFileSync(join(world.paths.coreUpstream, "skills/beta/SKILL.md"), "utf8"), "tampered");
});

test("rollback reverts the newest sync with git, records it, and stops proposing that upstream state", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	assert.equal(cli(world, "upstream", "run", "--source", world.upstream, "--author-name", "b", "--author-email", "b@example.com").code, 0);
	const branch = `sync/upstream-${git(world.upstream, "rev-parse", "HEAD").slice(0, 12)}`;
	git(world.repo, "merge", "-q", "--no-ff", "-m", "merge sync", branch);
	assert.equal(readLock(world.paths.lockFile).version, "1.1.0");

	const dry = cli(world, "upstream", "rollback", "--dry-run");
	assert.match(dry.out, /dry-run: would revert/);
	assert.equal(readLock(world.paths.lockFile).version, "1.1.0");

	const result = cli(world, "upstream", "rollback", "--commit");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /reverted: restored upstream 1\.0\.0/);
	assert.equal(readLock(world.paths.lockFile).version, "1.0.0");
	assert.equal(cli(world, "core", "verify").code, 0, "the restored core matches the restored lock");
	assert.ok(exists(join(world.paths.coreUpstream, "skills/alpha/scripts/run.sh")));
	assert.ok(!exists(join(world.paths.coreUpstream, "skills/gamma")));
	assert.equal(loadAdapter(join(world.repo, "pstack-copilot")).revision, 1);
	assert.equal(git(world.repo, "status", "--porcelain"), "");

	const entries = history(world).entries;
	assert.deepEqual(entries.map((e) => `${e.kind}:${e.status}`), ["sync:prepared", "sync:rolled-back", "rollback:rollback"]);
	assert.equal(entries[1].rolledBackBy, entries[2].id);
	assert.equal(entries[2].from?.version, "1.1.0");
	assert.equal(entries[2].to.version, "1.0.0");

	const again = cli(world, "upstream", "check", "--source", world.upstream);
	assert.match(again.out, /CONFLICT previously-rolled-back/);
	const run = cli(world, "upstream", "run", "--source", world.upstream);
	assert.match(run.out, /action: none \(a reviewer already rolled this upstream state back\)/);
	assert.equal(readState(world.gh.state).prs.length, 1, "no second pull request for a rolled-back state");
	const force = cli(world, "upstream", "check", "--source", world.upstream, "--include-rolled-back");
	assert.doesNotMatch(force.out, /CONFLICT previously-rolled-back/);
});

test("rollback stops on a conflict with later Copilot work and changes nothing", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	assert.equal(cli(world, "upstream", "run", "--source", world.upstream, "--author-name", "b", "--author-email", "b@example.com").code, 0);
	git(world.repo, "merge", "-q", "--no-ff", "-m", "merge sync", `sync/upstream-${git(world.upstream, "rev-parse", "HEAD").slice(0, 12)}`);
	const doc = json(join(world.repo, "pstack-copilot/adapter.json"));
	doc.revision = 7;
	writeFileSync(join(world.repo, "pstack-copilot/adapter.json"), `${JSON.stringify(doc, null, "\t")}\n`);
	commitAll(world, "custom: bump the adapter revision by hand");
	const head = git(world.repo, "rev-parse", "HEAD");

	const result = cli(world, "upstream", "rollback");
	assert.equal(result.code, 1, result.out);
	assert.match(result.out, /conflict: reverting .* collides with later changes/);
	assert.match(result.out, /pstack-copilot\/adapter\.json/);
	assert.equal(git(world.repo, "rev-parse", "HEAD"), head);
	assert.equal(git(world.repo, "status", "--porcelain"), "", "the aborted revert leaves the tree as it was");
	assert.equal(readLock(world.paths.lockFile).version, "1.1.0");
	assert.equal(json(join(world.repo, "pstack-copilot/adapter.json")).revision, 7, "the custom change survives");
});

test("rollback --pr opens a pull request with the revert and does not merge it", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	assert.equal(cli(world, "upstream", "run", "--source", world.upstream, "--author-name", "b", "--author-email", "b@example.com").code, 0);
	git(world.repo, "merge", "-q", "--no-ff", "-m", "merge sync", `sync/upstream-${git(world.upstream, "rev-parse", "HEAD").slice(0, 12)}`);
	const result = cli(world, "upstream", "rollback", "--pr", "--author-name", "b", "--author-email", "b@example.com");
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /pull request: https:\/\/example\.test\/pull\/2/);
	const pr = readState(world.gh.state).prs[1];
	assert.match(pr.head, /^rollback\/upstream-/);
	assert.match(pr.title, /^revert\(sync\): restore pstack 1\.0\.0/);
	assert.equal(readLock(world.paths.lockFile).version, "1.1.0", "main keeps the sync until the revert is merged");
	assert.equal(git(world.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
	assert.ok(!world.gh.calls().some((call) => /merge/.test(call.slice(0, 2).join(" "))));
});

test("only the newest sync can be rolled back", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	assert.equal(cli(world, "upstream", "sync", "--source", world.upstream).code, 0);
	commitAll(world, "sync 1.1.0");
	commitUpstream(world.upstream, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta again. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nOnce more.\n");
	assert.equal(cli(world, "upstream", "sync", "--source", world.upstream).code, 0);
	commitAll(world, "sync 1.1.0 again");
	const first = history(world).entries[1].id;
	const result = cli(world, "upstream", "rollback", "--to", first);
	assert.equal(result.code, 1);
	assert.match(result.out, /is not the newest sync/);
});

test("a failure part way through restores every file and the old core", () => {
	const dir = tempDir("tx");
	write(dir, "core/a.txt", "old core");
	write(dir, "stage/a.txt", "new core");
	write(dir, "lock.json", "old lock");
	const tx = transaction();
	tx.swapDir(join(dir, "core"), join(dir, "stage"));
	tx.writeFile(join(dir, "lock.json"), "new lock");
	tx.writeFile(join(dir, "created.json"), "created");
	assert.equal(readFileSync(join(dir, "core/a.txt"), "utf8"), "new core");
	tx.rollback();
	assert.equal(readFileSync(join(dir, "core/a.txt"), "utf8"), "old core");
	assert.equal(readFileSync(join(dir, "lock.json"), "utf8"), "old lock");
	assert.ok(!existsSync(join(dir, "created.json")));
});

test("a link that is already dead in upstream does not block the sync", () => {
	const world = makeGitWorld();
	commitUpstream(world.upstream, "pstack/README.md", "# pstack\n\nSee [gone](./skills/gone/SKILL.md) and [alpha](./skills/alpha/SKILL.md).\n");
	const result = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /status: prepared/);
});

test("rollback finds the right commit when the same upstream state was locked twice", () => {
	const world = makeGitWorld();
	const first = git(world.upstream, "rev-parse", "HEAD");
	const branch = git(world.upstream, "rev-parse", "--abbrev-ref", "HEAD");
	evolveUpstream(world.upstream);
	const sync = (...flags: string[]) => {
		const result = cli(world, "upstream", "sync", "--source", world.upstream, ...flags);
		assert.equal(result.code, 0, result.out);
		commitAll(world, "sync");
	};
	sync();
	git(world.upstream, "checkout", "-q", first);
	sync("--allow-downgrade", "--allow-rewrite", "--prepare");
	git(world.upstream, "checkout", "-q", branch);
	sync("--allow-downgrade", "--allow-rewrite", "--include-rolled-back");
	assert.equal(readLock(world.paths.lockFile).version, "1.1.0");

	const result = cli(world, "upstream", "rollback", "--commit");
	assert.equal(result.code, 0, result.out);
	assert.equal(readLock(world.paths.lockFile).version, "1.0.0", "the last sync is reverted, not the first commit that mentioned the sha");
	assert.equal(cli(world, "core", "verify").code, 0);
	assert.deepEqual(history(world).entries.map((entry) => `${entry.kind}:${entry.status}`), ["sync:prepared", "sync:prepared", "sync:prepared", "sync:rolled-back", "rollback:rollback"]);
});

test("when upstream sets a frontmatter key the adapter adds, the Copilot hint is dropped and upstream wins", () => {
	const world = makeGitWorld();
	assert.ok(json(join(world.repo, "pstack-copilot/mappings/skills.json")).skills.alpha, "the fixture adds a hint for alpha");
	commitUpstream(world.upstream, "pstack/skills/alpha/SKILL.md", '---\nname: alpha\ndescription: "Alpha spawns a Task subagent. Use for /alpha."\nargument-hint: "<upstream wording>"\ndisable-model-invocation: true\n---\n\n# Alpha\n\nSpawn one `Task` with `environment: "cloud"`, then run the **beta** skill.\n\nSee [the guide](../../docs/guide/README.md).\n');
	const result = cli(world, "upstream", "sync", "--source", world.upstream);
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /status: prepared/);
	assert.match(result.out, /warning frontmatter-collision/);
	assert.equal(json(join(world.repo, "pstack-copilot/mappings/skills.json")).skills.alpha, undefined);
	const record = history(world).entries[1];
	assert.ok(record.migration.some((op) => /dropped the argument-hint hint for alpha/.test(op)));
});

test("an older open pull request is pointed at the newer one and never closed", () => {
	const world = makeGitWorld();
	evolveUpstream(world.upstream);
	const author = ["--author-name", "b", "--author-email", "b@example.com"];
	assert.equal(cli(world, "upstream", "run", "--source", world.upstream, ...author).code, 0);
	commitUpstream(world.upstream, "pstack/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta again. Use for /beta.\ndisable-model-invocation: true\n---\n\n# Beta\n\nOne more change.\n");
	assert.equal(cli(world, "upstream", "run", "--source", world.upstream, ...author).code, 0);
	const state = readState(world.gh.state);
	assert.equal(state.prs.length, 2);
	assert.notEqual(state.prs[0].head, state.prs[1].head);
	const comment = world.gh.calls().find((call) => call[0] === "pr" && call[1] === "comment");
	assert.ok(comment, "the first pull request got a comment");
	assert.equal(comment[2], "1");
	assert.match(comment[4], /newer upstream state is proposed in https:\/\/example\.test\/pull\/2/);
	assert.ok(!world.gh.calls().some((call) => call[0] === "pr" && /close|merge/.test(call[1])));
});

test("history --adopt records an existing lock once and a rollback refuses to undo it", () => {
	const world = makeGitWorld();
	git(world.repo, "rm", "-q", "docs/sync/history.json");
	assert.ok(!exists(world.paths.historyFile));
	const adopted = cli(world, "upstream", "history", "--adopt");
	assert.equal(adopted.code, 0, adopted.out);
	assert.match(adopted.out, /recorded 1\.0\.0 \(.{12}\) as the first history entry/);
	const entries = history(world).entries;
	assert.equal(entries.length, 1);
	assert.equal(entries[0].trigger, "adopted");
	assert.equal(entries[0].to.commit, readLock(world.paths.lockFile).commit);
	assert.equal(entries[0].validation.passed, true);
	assert.match(cli(world, "upstream", "history", "--adopt").out, /already has entries/);
	assert.equal(history(world).entries.length, 1);
	commitAll(world, "adopt");
	const rollback = cli(world, "upstream", "rollback");
	assert.equal(rollback.code, 1);
	assert.match(rollback.out, /first sync created pstack-core/);
});
