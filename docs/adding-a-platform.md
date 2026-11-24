# Add a platform

A new agent platform, such as OpenAI Codex or another harness, is a new adapter folder. `pstack-core/` stays as it is.

1. Create `pstack-<id>/adapter.json` with the same fields as [`pstack-copilot/adapter.json`](../pstack-copilot/adapter.json). Choose where skills, agents, and instructions go for that platform. For Codex, for example, skills load from `.agents/skills/` and agents use another format.
2. Write the adapter skill for that platform in `overlays/skills/pstack-<id>/SKILL.md`, a table per Cursor term like [the Copilot one](../pstack-copilot/overlays/skills/pstack-copilot/SKILL.md). `pstack validate` fails until every term in use has a row.
3. Fill `mappings/`: extra terms, models, agents, frontmatter additions, and one `features.json` entry per upstream item. `pstack validate` lists every missing entry.
4. If the platform needs a transform the closed set lacks, add it to pstack-manager with its reversal and a test. Adapters cannot run code, so every transform stays provable.
5. `pstack build --adapter <id> && pstack validate --adapter <id>`, then validate the workflows on the real platform and record the results in `features.json`.

Each platform's distribution is built from the same locked core, so they stay on the same upstream version, and an upstream sync is gated on every adapter that lists that version.
