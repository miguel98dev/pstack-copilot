# Limitations on GitHub Copilot

What does not work, or works with a loss, and why. The per-feature status is in [COMPATIBILITY.md](../pstack-copilot/docs/COMPATIBILITY.md).

## Not supported

| Feature | Why | What happens instead |
| --- | --- | --- |
| Cursor Automations routines, `update_state`, webhook wakes, `SendToUser` secret requests (`/make-bot-ui`) | Copilot Automations have manual, hourly, and cron triggers locally, and GitHub issue and PR events in the cloud. They have no webhook trigger and no secret-request card. | `/make-bot-ui` ships unchanged; each Cursor-only step is skipped with one line, per the adapter. |
| The benny automation pack (`automations/benny`) | Built on Cursor Automations triggered by Slack messages, and dormant even upstream. | Not shipped. Links to it point to GitHub at the locked commit. A Copilot version would be a new design on cloud Automations with issue triggers. |
| `cursor-team-kit`: `/deslop`, `control-ui`, `control-cli` | A separate plugin that upstream does not bundle either. | `/deslop` steps run unslop and no-comments, then skip with one line. `control-ui` maps to a project `verify-*` skill, VS Code's browser tools, or Playwright; `control-cli` to a background terminal. |
| Cloud subagents (`environment: "cloud"`, `cloud_base_branch`, `/in-cloud`, Cursor Projects) | Copilot's `task` tool runs subagents in the current session's environment. Only a whole session can run in the cloud. | Workers run locally in their own git worktrees. Swarm, Shipping, and Autopilot keep their contracts, but the machine has to stay on. |
| Bugbot | Cursor's reviewer. | Copilot code review and other bots are triaged with the same rubric. `watch-pr` does not recognize them as Bugbot passes. |
| Fable models | Not in Copilot's catalog. | Panel seats use `gpt-6.1-sol`, keeping three vendors. |

## Works with a loss

- **`/loop`.** Copilot has its own `/loop` and `/every` scheduled prompts, and the adapter maps Cursor's `/loop` to them. In a VS Code run, `/loop` scheduled the prompt and it fired, but the session exposed no schedule tool. The agent could not stop the schedule or check a predicate across runs, and only the UI could cancel it. Treat Cursor-style unattended loops as unvalidated on Copilot. Autopilot keeps one session going, and background subagents and background shell commands wake the agent when they finish.
- **Custom Mode.** The `poteto-mode` agent preloads the skill each turn. Unlike Cursor's mode, it is a separate agent in the picker, so switching back to a plain agent drops it.
- **Following poteto-mode depends on the parent model.** In two VS Code runs on a small bug, Claude Sonnet 5.5 fixed the bug but skipped poteto-mode's playbook, todo list, and delegation, the second time even with the always-applied instruction. Claude Opus 5.5 followed every step. pstack's own default for its roles is Opus at xhigh. Start `/poteto-mode` chats on an Opus-class model. [tests/e2e/RESULTS.md](../tests/e2e/RESULTS.md) has the runs by model.
- **Agent adherence to the adapter line.** Agents read the `pstack-copilot` adapter when a step needs a mapping, such as subagents, models, or worktrees. They sometimes skip it when the step needs none, as `/architect` did. Small notes it asks for, such as "Ran locally on Copilot", were sometimes left out.
- **Transcripts.** `recall`, `automate-me`, `reflect`, `eval`, `session-pickup`, and `show-me-your-work` read `~/.copilot/session-state/<id>/events.jsonl` or the `session_store_sql` tool instead of Cursor's transcripts. The event format differs. Nested chats get their own session folder, as the validation runs showed.
- **`worktree-audit.sh`.** It is upstream code, so it stays unchanged, and it still looks for chats in `~/.cursor/projects`. Its newest-chat column is empty on Copilot.
- **Images and video.** `/visualize` and image generation become Mermaid unless the session has an image tool. `/ketchup-video` needs a local renderer, and VS Code chat may show a link instead of a player.
- **Plugin installs.** The build is a valid Agent Plugins 1.0 package, and VS Code (Install Plugin from Source) and Copilot CLI (`--plugin-dir`) can load it. This port validated the user-scope install through `~/.copilot` links only. A plugin install prefixes commands with `pstack:`, which the adapter covers.

## Not validated on this machine

- **babysit, shipping, opening-a-pr, and watch-pr against a real PR.** `gh` is not installed. watch-pr's own unit tests pass on the build.
- **statechart with TLC.** mise is absent and Java is 8; TLC needs 11+. Upstream's statechart tests pass on the build: 229 pass, and the 70 that need TLC are skipped by upstream's own guard.
- **Copilot CLI runs.** The CLI is installed but not signed in here, so every run went through VS Code.
- **Workflows not exercised in a VS Code session** are marked "Build and tests only" or "Not tested" in COMPATIBILITY.md.
