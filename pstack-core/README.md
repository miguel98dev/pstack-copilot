# pstack-core

An exact, unmodified copy of [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, published by Cursor under the MIT License.

| Field | Value |
|---|---|
| Upstream | `cursor/plugins`, folder `pstack/` |
| Locked commit and tree | see [`UPSTREAM.lock.json`](UPSTREAM.lock.json) (`commit`, `tree`) |
| Upstream version | `version` in the lock |
| License | [`upstream/LICENSE`](upstream/LICENSE), MIT, Copyright (c) 2026 Lauren Tan |

## Rules

- Nothing in `upstream/` is edited by hand. `pstack upstream sync` is the only writer.
- Nothing here is specific to GitHub Copilot or any other platform. Platform adaptations live in `pstack-<platform>/` and read this folder without changing it.
- `UPSTREAM.lock.json` records the sha256, size, and mode of every file, the upstream commit and tree hash, the license holder, and the Cursor vocabulary that upstream's own harness generator (`scripts/generate-pstack-harness-trees.mjs`) uses to find platform-specific names. The generator itself is not copied.
- `pstack core verify` fails when any byte, file, or executable bit differs from the lock. CI runs it on every change.
- `.gitattributes` turns off line-ending conversion for this folder, so a checkout on any OS stays byte-identical.

## Update

```sh
pstack upstream check                  # what would change, without writing
pstack upstream sync                   # fetch main, gate it through every adapter, replace upstream/ and the lock
pstack upstream sync --ref <commit>    # pin a specific upstream commit
```

The sync fetches a sparse, shallow copy of `cursor/plugins` at the ref, records its commit and tree hash, and checks the staged copy against every adapter. If an adapter does not yet map a new skill, playbook, agent, script, or Cursor term, the sync stops and lists what is missing, and this folder stays as it was. `--force` writes the new core anyway, for a maintainer who will fix the adapter next. [`CHANGELOG.upstream.md`](CHANGELOG.upstream.md) records each sync.
