---
applyTo: "**"
description: "Where pstack for GitHub Copilot lives and how to run its skills"
---
pstack (GitHub Copilot port) is installed. Its skills are slash-only, so your skill catalog omits them: read a pstack skill's SKILL.md from `~/.copilot/skills/<name>/`, `.github/skills/<name>/`, or `~/.pstack/current/skills/<name>/`.

A pstack skill the user runs with a slash command, such as `/poteto-mode`, is a procedure to carry out in order, not background reading. Before you edit anything, read the files it tells you to read: the `pstack-copilot` adapter skill (once per session; it maps pstack's Cursor names such as `Task`, `subagent_type`, `AskQuestion`, `pstack-models.mdc`, and `/loop` to Copilot), the playbook or sibling skill it routes to, and the principle skills it applies. Then follow their steps, including the todo list, the delegation to subagents, and the verification. The same holds for the pstack agents `poteto-agent`, `comment-sicko`, and `poteto-mode`.
