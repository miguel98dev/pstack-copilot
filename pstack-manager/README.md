# pstack-manager

The one executable in this repository. TypeScript run directly by Node.js 22.18+ (built-in type stripping), with no dependencies.

```sh
pstack-manager/bin/pstack help
```

## Commands

| Command | What it does |
| --- | --- |
| `upstream check` | Fetches `cursor/plugins` (sparse, shallow) and shows what a sync would change. Writes nothing. |
| `upstream sync [--ref R] [--source DIR] [--force] [--no-gate]` | Replaces `pstack-core/upstream/` and the lock with the fetched commit after checking the staged copy against the adapter. A failed check leaves the core as it was. |
| `core verify` | Compares every core file's bytes and mode with `UPSTREAM.lock.json`. |
| `build [--adapter copilot]` | Builds `dist/<adapter>/<core version>+<adapter>.<revision>/` and its `dist-manifest.json`. |
| `validate [--skip-scripts]` | Runs every check below. Exit 1 on any problem. |
| `matrix` | Regenerates `pstack-copilot/docs/COMPATIBILITY.md` from `mappings/features.json`. |
| `lint-skill <dir>...` | Checks skill folders against the Agent Skills rules Copilot applies. The `create-skill` skill calls it. |
| `install [--scope user\|workspace] [--repo DIR] [--force]` | Builds, validates, stores the version, and exposes it to Copilot. |
| `uninstall [--scope ...]` | Removes only what pstack created. |
| `update [--ref R]` | `upstream sync`, then `install`. A blocked sync installs nothing. |
| `rollback [version]` | Points `current` at an earlier stored version. |
| `status`, `versions`, `doctor` | Active version and links; stored versions; runtimes, integrity, conflicts, and model setup. |
| `models init [--budget large\|medium\|small] [--scope ...] [--force]` | Writes the `pstack-models` instruction from the Copilot defaults. |

Environment overrides keep tests off real machines: `PSTACK_REPO`, `PSTACK_HOME` (default `~/.pstack`), `PSTACK_DIST`, `COPILOT_HOME` (default `~/.copilot`).

## What `validate` proves

1. **Core matches the lock.** Every file's sha256 and mode, with no file missing or added.
2. **The build is core plus declared transforms.** For each shipped core file, undoing its recorded transforms gives the locked upstream bytes. Overlays equal their source. No file is undeclared. Every core file is shipped or excluded by a rule.
3. **The build is deterministic.** A second build gives the same manifest.
4. **Every Cursor term in use has an adapter row**, and every file that uses one carries the adapter line.
5. **Every upstream feature is traced.** Each skill, playbook, agent, script, term, and automation has one entry in `features.json`, and no entry is stale.
6. **Copilot schemas.** Skill name rules (folder name, lowercase, 64 characters), descriptions within 1024 characters, boolean fields, agent fields the Copilot harness accepts, instruction `applyTo`, executable scripts.
7. **Links resolve** inside the build.
8. **Model defaults** in the adapter skill agree with `mappings/models.json`.
9. **Upstream's own script tests**: `bun test` for watch-pr and `node --test` for statechart, run on the built copy in a scratch folder. A missing runtime is reported as skipped, never as passed.

## Source layout

```
src/
  cli.ts               argument parsing and lazy command loading
  paths.ts             every location, with environment overrides
  lib/                 fs helpers, frontmatter subset parser, Markdown links and reversible insertion
  upstream/            fetch (git sparse or local checkout), lock, vocabulary from upstream's generator, diff, sync
  build/               adapter spec parsing, vocabulary classifier, engine, models, matrix
  validate/            checks, the aggregate, the sync gate
  install/             state, user install (versions, current, links), workspace install
  commands/            one file per command
```

## Install layout

```
~/.pstack/
  state.json                     active version, history, links pstack owns
  versions/<version>/            immutable copies of validated builds
  current -> versions/<version>
~/.copilot/skills/<name>         -> ~/.pstack/current/skills/<name>
~/.copilot/agents/<name>.agent.md -> ~/.pstack/current/com.github.copilot/agents/<name>.agent.md
~/.copilot/instructions/pstack.instructions.md -> ~/.pstack/current/com.github.copilot/rules/...
```

pstack only creates, replaces, or deletes symlinks that point into `~/.pstack`. A real file or folder at one of those paths, such as a skill you copied there to edit, is left alone and reported, unless `--force` moves it to `~/.pstack/backups/<time>/` first.
