import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Summarizes the Copilot sessions that ran in a scenario repository, straight from
 * ~/.copilot/session-state/<id>/events.jsonl, so RESULTS.md cites what the agent did rather than what it said.
 * Usage: node tests/e2e/inspect.ts <scenario repository>...
 */

interface ToolCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const stateDir = join(home, "session-state");

function sessionsFor(cwd: string): string[] {
	return readdirSync(stateDir)
		.filter((id) => {
			const file = join(stateDir, id, "workspace.yaml");
			return existsSync(file) && new RegExp(`^cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(readFileSync(file, "utf8"));
		})
		.sort((a, b) => statSync(join(stateDir, a)).mtimeMs - statSync(join(stateDir, b)).mtimeMs);
}

function toolCalls(id: string): { calls: ToolCall[]; skills: string[] } {
	const calls: ToolCall[] = [];
	const skills: string[] = [];
	for (const line of readFileSync(join(stateDir, id, "events.jsonl"), "utf8").split("\n")) {
		if (!line) continue;
		let event: { type?: string; data?: Record<string, unknown> };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "skill.invoked" && event.data) skills.push(`${event.data.name} (${event.data.path})`);
		if (event.type !== "tool.execution_start" || !event.data) continue;
		const name = String(event.data.toolName || event.data.name || "");
		const args = (event.data.arguments || event.data.args || {}) as Record<string, unknown>;
		calls.push({ name, args });
	}
	return { calls, skills };
}

function summarize(id: string): string {
	const { calls, skills } = toolCalls(id);
	const text = (call: ToolCall) => JSON.stringify(call.args);
	const adapter = calls.some((c) => /pstack-copilot\/SKILL\.md/.test(text(c)));
	const pstackReads = [...new Set(calls.flatMap((c) => [...text(c).matchAll(/skills\/((?:[a-z0-9-]+\/)+[A-Za-z0-9-]+\.md)/g)].map((m) => m[1])))];
	const tasks = calls
		.filter((c) => c.name === "task")
		.map((c) => `${c.args.name}: agent_type=${c.args.agent_type} model=${c.args.model || "(inherit)"} effort=${c.args.reasoning_effort || "-"} mode=${c.args.mode || "sync"}`);
	const todos = calls.filter((c) => c.name === "sql" && /todos/i.test(text(c))).length;
	const commits = calls.filter((c) => c.name === "bash" && /git (-c [^ ]+ )*commit/.test(text(c))).length;
	return [
		`session ${id}`,
		`  slash skills loaded: ${skills.join(", ") || "none"}`,
		`  read pstack-copilot adapter: ${adapter ? "yes" : "no"}`,
		`  pstack files read: ${pstackReads.join(", ") || "none"}`,
		`  sql todo calls: ${todos}`,
		`  git commit calls: ${commits}`,
		`  task calls (${tasks.length}):`,
		...tasks.map((task) => `    ${task}`),
	].join("\n");
}

for (const cwd of process.argv.slice(2)) {
	const ids = sessionsFor(cwd);
	process.stdout.write(`## ${cwd}\n${ids.length === 0 ? "no session found\n" : `${ids.map(summarize).join("\n")}\n`}\n`);
}
