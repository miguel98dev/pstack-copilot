# Architecture

```mermaid
flowchart LR
  U[cursor/plugins at a commit] -->|pstack upstream sync| C[pstack-core: upstream/ + UPSTREAM.lock.json]
  C -->|pstack build| D[dist/copilot/version + dist-manifest.json]
  A[pstack-copilot: adapter.json, mappings, overlays] --> D
  D -->|pstack validate| V{proofs}
  V -->|pass| S[~/.pstack/versions/version]
  S -->|current symlink| L[~/.copilot skills, agents, instructions]
  D -->|workspace scope| W[repo/.github/skills, agents, instructions]
```

## Contracts

Each component talks to the next through files. Their parsers in pstack-manager reject unknown shapes, so a format change fails loudly.

### `pstack-core/UPSTREAM.lock.json`

| Field | Meaning |
| --- | --- |
| `repository`, `path`, `ref` | Where the copy came from. |
| `commit`, `committedAt`, `tree` | The exact upstream commit and the git tree hash of `pstack/` at it. |
| `name`, `version` | From upstream's `plugin.json`. |
| `license` | SPDX id and copyright holder read from upstream's `LICENSE`. |
| `vocabulary` | The `TERMS` list and route key from upstream's harness generator at the same commit: the Cursor names upstream itself considers platform-specific. |
| `files` | sha256, size, and mode of every file. |

### `pstack-<platform>/adapter.json`

The platform adapter's spec. It names supported core versions and a revision, path relocations and exclusions, the agent mapping, the adapter line, the vocabulary extras, the frontmatter additions, model rules, the traceability file, overlays, and the install layout. The transforms it can ask for are a closed set implemented by the manager (see [pstack-copilot/README.md](../pstack-copilot/README.md#transforms-the-build-may-apply)). An adapter cannot run code.

### `dist-manifest.json`

One entry per shipped file: path, origin (`core`, `overlay`, `generated`), source path and sha256, output sha256 and mode, and the ordered transforms with what each needs to be undone (link rewrites, insertion offsets, agent frontmatter changes). It also records the core commit and the install layout, so every stored version describes itself.

### `docs/sync/history.json`

An append-only list of synchronizations and rollbacks: upstream commit, tree, and version before and after, file counts, adapter revision, conflicts, migration steps, failed checks, and the report path. It lives outside `pstack-core/` because it also records adapter changes. Reports sit next to it in `docs/sync/reports/`, as Markdown and JSON.

### `~/.pstack/state.json`

Active version, version history for rollback, and the exact symlinks pstack created. Uninstall and update touch only those.

## Flows

- **Sync.** Fetch a sparse, shallow checkout at a ref, with enough history to list the commits since the lock. Compute the lock and diff it against the current one, detecting renames. Analyze the impact on the adaptation and detect conflicts. Plan the migration of the mapping files, then build and validate the migrated adapter against the staged core in a scratch folder. If a conflict or a check stops it, nothing is written. Otherwise one transaction swaps in the core and writes the lock, the migrated mappings, the matrix, the history, and the report, and restores every file if a step fails. `upstream run` then puts the result on a branch and opens a pull request. See [upstream-sync.md](upstream-sync.md).
- **Rollback.** Revert the commit a sync arrived in, found by its lock transition. A revert that collides with later changes stops. The history marks the sync as rolled back.
- **Build.** Walk the core and map each path (relocate, exclude, agent). Rewrite links, classify each skill folder with the vocabulary, inject the adapter line, add frontmatter, and render agents. Copy overlays, generate `plugin.json` and the matrix, then write the manifest. Same inputs, same bytes.
- **Install (user).** Build and validate. Store the version under `~/.pstack/versions/` (immutable). Swap `current` atomically, then sync the symlinks in `~/.copilot` to the version's layout.
- **Update.** Sync with the gate, then install. A blocked sync installs nothing.
- **Rollback.** Swap `current` to a stored version and sync the symlinks.
- **Install (workspace).** Copy into `.github/`. Record each file's sha256 in `.github/pstack-install.json`. Later installs replace only files whose bytes still match that record.

## Why links resolve in every layout

Every pstack skill reaches its siblings as `../<name>/SKILL.md`, and Copilot reports a skill's path as the path it loaded it from. pstack-manager therefore keeps all skills, including the adapter skill and the relocated upstream docs (`skills/pstack-copilot/upstream/`), side by side in one folder. That folder is `~/.copilot/skills/` (symlinks), `.github/skills/` (copies), or a plugin's `skills/`. A VS Code probe confirmed that a skill loaded through a symlinked folder reads its sibling through the symlinked path.

## Adding another platform

See [adding-a-platform.md](adding-a-platform.md). The core does not change.
