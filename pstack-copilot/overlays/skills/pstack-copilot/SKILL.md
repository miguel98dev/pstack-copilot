---
name: pstack-copilot
description: "Maps the Cursor names in pstack skills and agents to GitHub Copilot: Task and its subagent fields, AskQuestion, the todolist, model slugs, pstack-models.mdc, .cursor paths, agent transcripts, Bugbot, /loop, Custom Mode, cloud agents and other Cursor-only features. Read it once per session before you follow any pstack skill or pstack agent on GitHub Copilot in VS Code or Copilot CLI."
user-invocable: false
---

# pstack on GitHub Copilot

pstack skills use Cursor names. On GitHub Copilot (the Copilot harness in VS Code, the GitHub Copilot app, or Copilot CLI), read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds this skill folder and its sibling skill folders, so `<pstack>/poteto-mode/SKILL.md` is the poteto-mode skill. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

This port changes no pstack rule. Where Copilot has no equivalent, the tables give a substitute or tell you to skip the step with one line. [COMPATIBILITY.md](COMPATIBILITY.md) lists the status of every skill, playbook, agent, and script, and which ones were validated in VS Code.

## Locate pstack

Use the path of the skill you are following: its sibling skills are `../<name>/SKILL.md`. Copilot shows a skill's path when it loads it. With no path, take the first of these that exists:

1. `~/.copilot/skills/<name>/SKILL.md`. A user install by pstack-manager links each skill there from `~/.pstack/current/skills/`.
2. `.github/skills/<name>/SKILL.md` at the repository root, for a workspace install.
3. `~/.pstack/current/skills/<name>/SKILL.md`.
4. `~/.copilot/installed-plugins/**/skills/<name>/SKILL.md`. With several, use the one whose plugin's `plugin.json` has the highest `version`.

Every pstack skill except `setup-pstack` is slash-only (`disable-model-invocation: true`), so the `skill` tool refuses it. Read its `SKILL.md` with your file tool instead. A skill missing from your skill catalog does not mean pstack is absent.

Links in pstack files that pointed to `../../README.md` or `../../docs/` now point into [`upstream/`](upstream/) inside this skill's folder. Links to files this port does not ship point to GitHub at the locked upstream commit.

## Tools

| Cursor | GitHub Copilot |
| --- | --- |
| `Task` | `task`. Each call also needs a short `name` and a 3-5 word `description`. |
| `AskQuestion` | `ask_user`. Options become an `enum` or `oneOf` field, and `allow_multiple: true` becomes an `array` field. When `ask_user` is absent, as in a non-interactive run, ask in plain text. |
| Open a todolist, or copy steps into the todolist tool | Insert the steps into the session's `todos` table with the `sql` tool, or use the `todo` tool when the session offers it. Mark each one `in_progress` and then `done` as it fires. With neither tool, keep the list in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/<name>/SKILL.md` with your file tool and follow it. When you tell the user to type it, write `/name`. In a plugin install, write `/pstack:name`. |
| `Grep`, `Glob` | `grep`, `glob`. |
| A background subagent's result | A `mode: "background"` task notifies you when it finishes. Read it once with `read_agent`. Do not poll. |

## Subagent fields

| Cursor | GitHub Copilot `task` |
| --- | --- |
| `subagent_type: generalPurpose` | `agent_type: "general-purpose"` |
| `subagent_type: "poteto-agent"`, `subagent_type: "comment-sicko"` | `agent_type: "poteto-agent"`, `agent_type: "comment-sicko"`. pstack installs both as custom agents. If `task` does not list them, use `general-purpose`, make the brief's first line `Read <path> before anything else.` with the agent file's path (`com.github.copilot/agents/<name>.agent.md` in the pstack root, or `~/.copilot/agents/<name>.agent.md`), and say so. |
| `readonly: true` | `agent_type: "explore"`. It has read-only tools. Pass the role's `model`, because `explore` otherwise runs a lightweight model. It has no MCP tools. When the brief needs MCP, use `general-purpose`, add "do not edit files" to the brief, and check `git status` afterward. |
| `readonly: false` | `general-purpose`. It keeps the session's MCP servers. |
| `run_in_background: true` | `mode: "background"`. Start every worker of one fan-out in the same message. |
| `resume` | `write_agent` to the idle agent with the follow-up. If the agent is gone, spawn a new one and paste the earlier result into its brief. |
| `environment: "cloud"` | Copilot cannot start a cloud agent from `task`. Run the worker locally with `mode: "background"` in its own git worktree: the brief's first steps are `git worktree add <scratch>/<slug> <base>` and working only there. Name the branch or commit. Write `Ran locally on Copilot, not as a cloud agent: <step>.` once. |
| `environment: "local"` | Omit. |
| `cloud_base_branch: <b>` | Use `<b>` as the worker's worktree base. |
| `file_attachments` | List the paths in the brief. |
| `is_background: true` in an agent file | Per call: `mode: "background"`. |
| `model` | See Models. |

## Models

pstack names models with Cursor slugs that carry the effort, such as `claude-opus-5-5-xhigh-fast`. Copilot takes a model id in `model` and the effort in `reasoning_effort`. The valid ids and efforts are the values your `task` tool's schema lists. They depend on the user's plan, so check each mapped value against the schema.

| Cursor | GitHub Copilot |
| --- | --- |
| `claude-opus-5-5-<effort>-fast`, `claude-opus-5-5-<effort>` | `model: "claude-opus-5.5"`, `reasoning_effort: "<effort>"`. Copilot has no fast Opus 5.5, so drop `-fast`. |
| `claude-fable-5-2-<effort>` | Copilot does not offer Fable. In a panel or a judge list, use `gpt-6.1-sol` at the same effort, so the panel keeps three vendors. Where poteto-mode allows Fable outside a panel (the user named it, or two Opus runs failed), use `gpt-6.1-sol` at `xhigh` and say so. |
| `gemini-4-neon-<effort>` | `model: "gemini-4-neon"`, `reasoning_effort: "<effort>"`. Its top effort is `xhigh`. |
| Any other `claude-`, `gpt-`, `grok-`, or `gemini-` slug | The Copilot id of the same model, with dots between version numbers (for example `gpt-6.1-sol`), and its effort. If the schema has no such id, use the role's Copilot default below. |
| `auto`, `inherit-parent` | Omit `model` and `reasoning_effort`, and use `general-purpose` in place of `poteto-agent`, as the skills say. |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | The `pstack-models` instruction, `~/.copilot/instructions/pstack-models.instructions.md`. Copilot loads it into every new session, so its role lines are already in context. If they are not, read the file. A repository can override it with `.github/instructions/pstack-models.instructions.md`. If neither exists, or the role has no line, use the role's Copilot default. |
| A role value `<model> @<effort>`, such as `claude-opus-5.5 @high` | `model: "claude-opus-5.5"`, `reasoning_effort: "high"`. |
| "If the Task tool rejects a slug" | If `task` rejects a model or an effort, never pass it again. Use the skill's next fallback, mapped with this table, then omit `model`. Say so. |
| A vendor or family check (arena's judge, show-me-your-work's reviewer) | The vendor is the id prefix: `claude-` is Anthropic, `gpt-` is OpenAI, `gemini-` is Google, `grok-` is xAI, `mai-` is Microsoft. Your own model id is in your session context. If you cannot tell it, say that the vendor check did not run. |

Copilot defaults, the Cursor defaults mapped with the table above:

| Role | Copilot default |
| --- | --- |
| feature, refactoring; bug-fix; perf-issue; hillclimb; judgment and prose; the poteto-agent file | `claude-opus-5.5 @xhigh` |
| swarm workers, trivial mechanical edits, verification | `claude-opus-5.5 @high` |
| arena runners, interrogate reviewers | `gpt-6.1-sol @high`, `claude-opus-5.5 @high`, `gemini-4-neon @xhigh` |
| arena cross-judge pool | `claude-opus-5.5 @high`, `gemini-4-neon @xhigh` |
| An agent that only dispatches, polls, or packs results (eval) | `claude-opus-5.5 @medium` |

The effort ladder is the same: `xhigh` > `high` > `medium` > `low`. Copilot also offers `max` on some models. No pstack role runs above `xhigh`.

## setup-pstack

Copilot loads every `*.instructions.md` file in `~/.copilot/instructions/` into each new session, so `setup-pstack` writes its rule there. Follow its steps with these changes:

- Detect. The detected models are the `model` values that the `task` tool schema lists, each with the efforts its `reasoning_effort` accepts. Write a real model as `<model> @<effort>`, such as `claude-opus-5.5 @xhigh`. The effort is the last token, so the budget step works as written. The rules about `-fast` slugs and Fable slugs do not apply.
- Load current state. Read `~/.copilot/instructions/pstack-models.instructions.md`. If it is absent and `~/.copilot/pstack-models.md` exists (another Copilot port writes it), treat that file as an older setup without a `# defaults` line. Keep its `inherit-parent`, `auto`, and other user values, drop the roles step 2 drops, and tell the user which lines you dropped. Do not delete that file.
- Defaults. Map each default slug with the Models table: `claude-opus-5-5-xhigh-fast` is `claude-opus-5.5 @xhigh`, `claude-opus-5-5-high-fast` is `claude-opus-5.5 @high`, `claude-fable-5-2-high` is `gpt-6.1-sol @high`, and `gemini-4-neon-xhigh` is `gemini-4-neon @xhigh`.
- Ask. Use `ask_user` where the skill says AskQuestion.
- Write. Write `~/.copilot/instructions/pstack-models.instructions.md` with this frontmatter, then the comment lines, the `# defaults: 3` line, the `# budget` line, and one line per role from step 5. Overwrite the whole file. Never put the role lines in `copilot-instructions.md` or `AGENTS.md`.

  ```
  ---
  applyTo: "**"
  description: "pstack per-role model choices for GitHub Copilot (overrides skill defaults)"
  ---
  ```

- Confirm. The rule applies to new sessions: a new chat in VS Code, a new `copilot` session in the CLI.
- Steps 7 and 8 generate skills under `.github/skills/`.

From a terminal, `pstack models init --budget large|medium|small` writes the same file from these defaults without the interactive steps.

## Paths

| Cursor | GitHub Copilot |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.github/skills/`, `~/.copilot/skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | See Locate pstack. The plugin manifest is `plugin.json` at the pstack root. |
| `plugins/cache/`, the installed pstack copy | `~/.pstack/versions/` and `~/.copilot/installed-plugins/`. Never edit them. To change a pstack skill, copy its folder to `.github/skills/<skill>/` or `~/.copilot/skills/<skill>/` and edit the copy. In `~/.copilot/skills/`, first delete the symlink pstack-manager made for that skill. pstack-manager then leaves your copy alone. |
| `.cursor/rules/*.mdc`, always-applied rules | Repository: `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` with `applyTo: "**"`, or `AGENTS.md`. Personal: `~/.copilot/instructions/*.instructions.md`. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | The local copy: `<pstack>/<rest>` for `skills/<rest>`, and `<pstack>/pstack-copilot/upstream/<path>` for `README.md` and `docs/`. Read it and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/`, "the active workspace's `agent-transcripts/` directory" | `~/.copilot/session-state/<session-id>/`. `events.jsonl` holds one event per line (`user.message`, `assistant.message`, `tool.execution_start`, `tool.execution_complete`, and others), and `workspace.yaml` holds the session's `cwd`. This workspace's transcripts are the sessions whose `cwd` is inside the repository. Read no others. When the `session_store_sql` tool exists, query it first: `sessions` (filter on `cwd`, then `created_at`) and `turns`. The current session is the one whose folder your session context names. Skip it when a skill says to skip the current chat. |
| "The root agent's store (path in the system prompt)" | The `files/` folder of the root session's folder. |

## Cursor-only features

Copilot has no Cursor Automations routines, Bugbot, Cursor cloud agents, Custom Modes, or built-in PR tool, and its `/loop` works differently. When a step needs one, use the substitute in this table. When the table says skip, put one line in your reply, `Skipped on Copilot: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | GitHub Copilot |
| --- | --- |
| Custom Mode (Option+Enter on `/poteto-mode`, Use as Mode) | Select the `poteto-mode` agent in the agent picker (VS Code) or start with `copilot --agent poteto-mode` (CLI). It loads poteto-mode on every turn. Otherwise start each task with `/poteto-mode`. |
| Cursor's `/loop` command | Copilot's own scheduled prompts. The user types `/loop <prompt>` or `/every <interval> <prompt>`, such as `/every 20m check CI on PR 123 and stop when it is green`. `/every <prompt>` with no interval lets the agent pace itself, and `/every` alone lists and stops schedules. Put a predicate that can pass or fail and the path of a state file in the prompt, so each run resumes from the file and knows when the work is done. When your session has a schedule tool, use it yourself: `create` with an `interval` or `cron` and the prompt, `stop` when the predicate passes, and inside a self-paced run `wakeup` as your last action to continue. Without one, tell the user the line to type, and say once that the loop needs it. To wait for a background subagent or a background shell command, end your turn: Copilot wakes you when it finishes. For long unattended runs, also turn on Autopilot (the VS Code mode picker, or `copilot --autopilot`). |
| Cursor cloud agents, `/in-cloud`, a Cursor Project coordinator | Local background subagents in their own worktrees, as Subagent fields says. A whole session can run in the cloud through the Cloud session target, but a subagent cannot. |
| Bugbot | Copilot code review and other bot reviewers leave ordinary review threads. Triage them as Bugbot comments with [`bugbot-triage.md`](../poteto-mode/references/bugbot-triage.md) and the step's forge command. `watch-pr` reports them as threads, not as Bugbot passes. Skip a step that starts, waits for, or configures Bugbot itself. |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. Copilot Automations have no webhook trigger and no secret-request card. |
| A built-in PR tool | `gh pr create` without `--draft`, or the GitHub MCP `create_pull_request` tool when the session has it. That is not a skip, so write no line. |
| Plan Mode | The Plan agent (`/plan`). |
| Cursor's built-in `create-skill` skill, `/create-skill` | The [`create-skill`](../create-skill/SKILL.md) skill shipped with this port. |
| Cursor's built-in `/autopilot` or babysit skill | Not present. The Babysit playbook covers PR status. |
| `/visualize`, the image-generation tool | A Mermaid diagram, or a Mermaid `xychart-beta` for numbers. If the session has an image tool, use it. Otherwise say that the figure is a diagram, not a generated image. |
| `/deslop` from the `cursor-team-kit` plugin | Not shipped. If a `deslop` skill is installed, use it. Otherwise run the **unslop** skill on the prose in the diff and the **no-comments** skill on the code, and write `Skipped on Copilot: /deslop. cursor-team-kit is not installed.` |
| `control-ui` from `cursor-team-kit` | The project's `verify-*` skill first. Else the VS Code integrated browser tools (`openBrowserPage`, `readPage`, `screenshotPage`, `clickElement`, `typeInPage`, `runPlaywrightCode`) when the session lists them. Else Playwright from the shell. |
| `control-cli` from `cursor-team-kit` | The project's `verify-*` skill first. Else drive the program from the shell in a background terminal, or tmux when installed. |
| `/add-plugin pstack`, Customize in the sidebar | `pstack install` from pstack-manager, or install the folder `~/.pstack/current` as a plugin (VS Code: Chat: Install Plugin from Source; CLI: `copilot --plugin-dir ~/.pstack/current`). |
| `~/Library/Application Support/Cursor` caches | VS Code caches (`~/Library/Application Support/Code` or `~/.config/Code`) and old sessions in `~/.copilot/session-state/`. |

## poteto-help on Copilot

- Install with pstack-manager (`pstack install`), then run `/setup-pstack`. Plugin installs prefix every command with `pstack:`, such as `/pstack:poteto-mode`.
- Custom Mode is the `poteto-mode` agent. Without it, start each task with `/poteto-mode`.
- Only `/setup-pstack` loads from the user's words. This adapter also loads on its own when a pstack skill or agent needs it.
- `/loop` and `/every` are Copilot's own scheduled prompts. `/create-skill` is a skill of this port. `/deslop`, `control-cli`, and `control-ui` are not shipped.
- pstack's own Claude Code notes do not apply on Copilot.
