# Decisions

## 1. Overlay and declared transforms, not a fork

pstack changes daily (0.15.48 at the time of writing). A port that rewrites skills drifts from upstream with every release, and nobody can tell which differences are intended. Upstream already solves this for Claude Code with a name map and one inserted line per skill. This port does the same and goes further in one respect: every byte that differs from upstream is recorded and undone by `pstack validate`.

## 2. Target the Copilot harness

VS Code's Local harness is deprecated and leaves in February 2027. The Copilot harness is shared by VS Code, the GitHub Copilot app, and Copilot CLI, and it has the tools pstack's workflows need: `task` with per-call `model`, `reasoning_effort`, and `mode: "background"`, `read_agent` and `write_agent` (so `resume` works), `ask_user`, and session todos.

## 3. Skills instead of prompt files

`.prompt.md` files run only in the Local harness. Copilot's reusable slash commands are skills. The port therefore uses a skill for every command, including its replacement for Cursor's built-in `create-skill`. Revision 1 also shipped a `loop` skill for Cursor's `/loop`. A VS Code run showed that Copilot has its own `/loop` and `/every` scheduled prompts, which took the command, so revision 3 removed the skill and maps `/loop` to the built-in. That follows Subtract Before You Add.

## 4. Keep `disable-model-invocation: true` and route by path

Upstream makes 58 of 59 skills slash-only. Copilot honors the same field, and its `skill` tool then refuses those skills, which a VS Code probe confirmed. Removing the field would change when skills load, so the port keeps it and routes skill to skill by reading `../<name>/SKILL.md`, as upstream's Claude Code adapter does.

## 5. Always-applied instructions for what Cursor puts in rules

Cursor's `pstack-models.mdc` is an always-applied user rule. Copilot loads `~/.copilot/instructions/*.instructions.md` into every session, which a VS Code probe confirmed, so `/setup-pstack` writes there. A repository can override it with `.github/instructions/pstack-models.instructions.md`.

## 6. Symlinks into an immutable version store

Copying 547 files into `~/.copilot` per update would make rollback a second copy, and would make it hard to tell pstack's files from the user's. Symlinks through `~/.pstack/current` make update and rollback one atomic swap. They also let pstack delete only what points into its own store.

## 7. A Copilot-only instruction asking for procedure, and an Opus-class parent for poteto-mode

In the first VS Code run of `/poteto-mode` on Claude Sonnet 5.5, the agent fixed the bug but skipped the adapter, the playbook, the todo list, and the delegation. pstack-core cannot change, and the agent ignored the adapter line, so revision 2 added a rule to the always-applied `pstack.instructions.md`: a slash-invoked pstack skill is a procedure to follow in order, including the files it names. A second Sonnet run still skipped the playbook. A run on Claude Opus 5.5, pstack's own default model, followed every step. The instruction stays because it is cheap and states upstream's intent. The supported setup is an Opus-class parent for `/poteto-mode`. [tests/e2e/RESULTS.md](../tests/e2e/RESULTS.md) records the three runs.
