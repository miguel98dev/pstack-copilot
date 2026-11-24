---
name: create-skill
description: "Author or edit an Agent Skill (a SKILL.md folder) for GitHub Copilot in VS Code and Copilot CLI: name and frontmatter rules, project and personal locations, slash versus automatic loading, bundled scripts, and a validation pass. The Copilot stand-in for Cursor's built-in create-skill, which pstack's automate-me skill and Authoring a skill playbook use. Use for /create-skill."
argument-hint: "<what the skill should do> [project|personal]"
disable-model-invocation: true
---

# Create a skill

Write a skill a cold agent can follow mid-task. pstack's [Authoring a skill playbook](../poteto-mode/playbooks/authoring-a-skill.md) owns the voice: keep only prose that changes a decision, delegate to other skills by path, and encode rules in structure when you can.

## 1. Name and place it

- The folder name is the skill `name`: lowercase letters, digits, and hyphens, at most 64 characters, with no slash, colon, dot, or namespace prefix. Copilot silently skips a skill whose name breaks these rules or differs from its folder.
- Project skills go in `.github/skills/<name>/SKILL.md` and are shared through the repository. Personal skills go in `~/.copilot/skills/<name>/SKILL.md`. Copilot also reads `.claude/skills/` and `.agents/skills/`, but prefer the `.github` and `~/.copilot` locations.
- If a skill with that name already exists anywhere Copilot reads, update it in place or pick another name. Two skills with one name both load.

## 2. Write the frontmatter

```yaml
---
name: <name>
description: "<what it does>. Use for /<name>, <the phrases that should trigger it>."
argument-hint: "<what to type after /<name>>"
disable-model-invocation: true
---
```

- `description` is required, one YAML scalar of at most 1024 characters. Quote it, or use `>-` with indented lines, when it holds a colon, quotes, or a line break. Say what the skill does and when to use it. Name the trigger words, not generic ones like "write code".
- `disable-model-invocation: true` makes the skill slash-only: the agent cannot load it by itself and the `skill` tool refuses it. Use it for modes and heavy workflows. Leave it out to let the agent load the skill when a request matches the description.
- `user-invocable: false` hides the skill from the `/` menu but lets the agent load it.
- `argument-hint` is the hint the chat input shows after `/<name>`.

## 3. Write the body

- Start with one H1, then the steps as the agent should run them. Commands, paths, and names are the repository's real ones, with no placeholders left.
- Put long references, templates, and scripts in the folder and link them with paths relative to `SKILL.md`. Make scripts executable and show how to call each one.
- Link other skills by their path (`../<other>/SKILL.md`), because a slash-only skill cannot be loaded by name.

## 4. Validate

Run `pstack lint-skill <folder>` when pstack-manager is installed. Otherwise check by hand:

- The frontmatter parses, `name` matches the folder, and `description` is at most 1024 characters.
- Every relative link resolves and every script is executable.

Then prove it loads. In VS Code, run **Chat: Open Customizations** and confirm the skill is listed under Skills without errors. Start a new chat, type `/<name>` with a small real task, and check that the agent followed the skill and read its resources. In Copilot CLI, start a new session and do the same.

**Reply:** the skill path, its frontmatter, what the validation and the load test showed, and any rule you could not encode.
