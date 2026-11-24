# Notice

This repository contains a copy of **pstack** by Lauren Tan, published by Cursor at <https://github.com/cursor/plugins/tree/main/pstack> under the MIT License:

> MIT License
>
> Copyright (c) 2026 Lauren Tan

The full license text is in [`pstack-core/upstream/LICENSE`](pstack-core/upstream/LICENSE) and ships as `LICENSE` in every build this repository produces.

- `pstack-core/upstream/` is that work, unmodified. `pstack-core/UPSTREAM.lock.json` records the exact commit and the sha256 of every file.
- `pstack-copilot/` and `pstack-manager/` are a separate, unofficial port to GitHub Copilot. Neither Lauren Tan nor Cursor wrote, reviewed, or endorses it. The names pstack, poteto-mode, and poteto refer to the original work.
- The upstream harness generator (`scripts/generate-pstack-harness-trees.mjs` in `cursor/plugins`) is read during a sync to extract its vocabulary list. It is not copied here.
