# pstack-copilot

The GitHub Copilot adaptation of pstack, written as data. pstack-manager reads this folder and `pstack-core/` and builds `dist/copilot/<version>/`, an [Agent Plugins 1.0](https://agent-plugins.org) package that VS Code's Copilot harness and Copilot CLI load.

Nothing here is a copy of a pstack file. Upstream text reaches Copilot through the core, with the transforms below recorded per file in the build's `dist-manifest.json`.

## Contents

| Path | What it is |
| --- | --- |
| [`adapter.json`](adapter.json) | The spec: supported core versions, revision, where each core path goes in the build, what is excluded, the adapter line, the install layout. |
| [`mappings/terms.json`](mappings/terms.json) | Cursor names that upstream's own vocabulary list misses (`/loop`, Custom Mode, `cursor-team-kit`, `/visualize`...). With upstream's 22 terms they decide which files get the adapter line, and each one must have a row in the adapter skill. |
| [`mappings/models.json`](mappings/models.json) | Cursor model slugs to Copilot model ids and efforts, and the default model of each pstack role. |
| [`mappings/agents.json`](mappings/agents.json) | How each upstream agent becomes a Copilot custom agent: which frontmatter keys it drops and which Copilot keys it sets. |
| [`mappings/skills.json`](mappings/skills.json) | `argument-hint` values added to skills for the slash-command input. Only listed keys, only added. |
| [`mappings/features.json`](mappings/features.json) | Traceability: one entry per upstream skill, playbook, agent, script, Cursor term, and automation, and per Copilot addition, with its support status, how it works on Copilot, and how it was validated. |
| [`overlays/`](overlays/) | Files Copilot needs that upstream does not have. They are listed below. |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | The matrix generated from `features.json` (`pstack matrix`). The build ships the same file inside the adapter skill. |

### Overlays

| File | Copilot capability | Replaces in Cursor |
| --- | --- | --- |
| `skills/pstack-copilot/SKILL.md` | Agent Skill, hidden from `/`, loadable by the model and by relative path from every pstack skill | `docs/harness/claude-code.md`'s role for Claude Code: the name map |
| `skills/create-skill/SKILL.md` | Slash skill | Cursor's built-in `create-skill` |
| `com.github.copilot/agents/poteto-mode.agent.md` | Custom agent that preloads skills with `skills:` | Custom Mode (Option+Enter on `/poteto-mode`) |
| `com.github.copilot/rules/pstack.instructions.md` | Always-applied personal or repository instruction | Cursor's plugin catalog telling the agent pstack exists |

## Transforms the build may apply

The set is closed. pstack-manager implements each one, records it per file, and `pstack validate` undoes it to prove the file still equals upstream.

1. **relocate**: `docs/`, `README.md`, and `LICENSE` move under `skills/pstack-copilot/upstream/` so every skill can reach them by relative path in every install layout.
2. **rewrite-links**: relative links follow the relocation; links to files the build leaves out (`automations/`) point to GitHub at the locked commit.
3. **inject-adapter-line**: one line after the first H1 of each skill or agent that uses a Cursor term or routes to another skill by name. The classifier is upstream's.
4. **frontmatter-add**: `argument-hint` lines from `mappings/skills.json`.
5. **render-agent**: upstream agents become `com.github.copilot/agents/<name>.agent.md`, with the body verbatim and frontmatter per `mappings/agents.json`.
6. **generated**: `plugin.json` from upstream's manifest, and `COMPATIBILITY.md` from `features.json`.

## Native Copilot capabilities in use

- **Agent Skills.** All 59 upstream skills, slash-only as upstream ships them (`disable-model-invocation: true`), plus `argument-hint`. Copilot's `skill` tool refuses slash-only skills, so pstack's skill-to-skill routing reads `../<name>/SKILL.md`. That is the same move upstream makes for Claude Code.
- **Custom agents.** `poteto-agent` and `comment-sicko` as subagents (`user-invocable: false`, called through `task` with `agent_type`), and `poteto-mode` as a selectable agent.
- **Instructions.** `pstack.instructions.md` is always applied. `/setup-pstack` writes `pstack-models.instructions.md`, Cursor's always-applied model rule, in `~/.copilot/instructions/`, or `.github/instructions/` per repository.
- **Prompts.** Copilot runs reusable prompts as skills. `.prompt.md` files work only in VS Code's Local harness, which is deprecated and leaves in February 2027, so this port ships none. Cursor's `/loop` maps to Copilot's own `/loop` and `/every` scheduled prompts. An earlier revision shipped a `loop` skill, but VS Code ran its built-in `/loop` instead, so revision 3 removed it.
- **Tools.** `task` (with `agent_type`, `model`, `reasoning_effort`, `mode: "background"`), `read_agent`, `write_agent`, `ask_user`, `sql` todos, `session_store_sql`, and VS Code's browser tools stand in for Cursor's `Task`, `AskQuestion`, the todolist, and `control-ui`.

## Change the adaptation

1. Edit a mapping, the adapter skill, or an overlay.
2. Raise `revision` in `adapter.json`. An installed version is immutable, so the same version with new bytes is refused.
3. `pstack build && pstack validate && npm test`.
4. When a VS Code run proves a feature, set its `validation` to `vscode-validated` with the evidence in `features.json`, then `pstack matrix`.

After an upstream sync, add the new core version to `coreVersions` only once `pstack validate` passes against it.
