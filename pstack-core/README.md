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
pstack upstream check                  # analyze what would change; writes nothing
pstack upstream sync                   # fetch, analyze, migrate the adapter, validate, then replace upstream/ and the lock
pstack upstream sync --ref <commit>    # pin a specific upstream commit
pstack upstream rollback               # revert the newest sync with git
```

A GitHub Actions job runs the check every day and opens a pull request when pstack changed. [docs/upstream-sync.md](../docs/upstream-sync.md) describes the whole flow. The sync replaces this folder together with the lock, the mapping files, and the history in one transaction, and it refuses to start when this folder differs from the lock, so a local edit is never overwritten. `docs/sync/history.json` records every sync, and [`CHANGELOG.upstream.md`](CHANGELOG.upstream.md) holds a short entry for each.
