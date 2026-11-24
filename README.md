# pstack for GitHub Copilot

A maintained port of [pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's engineering workflow stack for Cursor, to GitHub Copilot in VS Code and Copilot CLI. It is an unofficial port. pstack, poteto-mode, and every skill's text belong to their author under the MIT License. See [NOTICE.md](NOTICE.md).

The port never edits pstack. It keeps an exact copy, builds a Copilot distribution from it with a small set of declared, reversible transforms, and proves after every build that the distribution is the copy plus those transforms.

## Components

| Component | Responsibility | Never does |
| --- | --- | --- |
| [`pstack-core/`](pstack-core/) | The exact upstream source at a locked commit, with per-file sha256, the upstream version, the license holder, and the Cursor vocabulary upstream uses. | Get edited by hand, or hold anything Copilot-specific. |
| [`pstack-copilot/`](pstack-copilot/) | The Copilot adaptation as data: the adapter spec, mapping tables, and the files Copilot needs that upstream does not have (the adapter skill, `/create-skill`, the poteto-mode agent, one instruction). | Copy and edit a core file. |
| [`pstack-manager/`](pstack-manager/) | The only code: upstream sync, build, validation, install, update, rollback, doctor. | Ship pstack content of its own. |
| [`tests/`](tests/) | Manager unit and end-to-end tests on a synthetic upstream, invariant tests on the real core, and the VS Code validation scenarios. | |
| [`docs/`](docs/) | Architecture, upstream synchronization, limitations, adding a platform, decisions, and the sync history and reports in `docs/sync/`. | |

The interfaces between them are files: `pstack-core/UPSTREAM.lock.json`, `pstack-<platform>/adapter.json` with its `mappings/`, and the build's `dist-manifest.json`. [docs/architecture.md](docs/architecture.md) describes each one.

## Install for yourself

Needs Node.js 22.18 or later and git. `gh`, Bun, and mise are optional; `pstack doctor` says which workflows need them.

```sh
git clone <this repository> ~/pstack && cd ~/pstack
./pstack-manager/bin/pstack install     # build, validate, store, and link into ~/.copilot
./pstack-manager/bin/pstack doctor      # what this machine can and cannot run
```

Then start a new chat in VS Code with the Copilot harness, or a new `copilot` session:

- `/setup-pstack` picks a model per role and writes `~/.copilot/instructions/pstack-models.instructions.md`. `pstack models init --budget large|medium|small` writes the defaults without questions.
- `/poteto-mode <goal and how to tell it is done>` for any task that needs rigor. To keep it on every turn, pick the **poteto-mode** agent in the agent picker (`copilot --agent poteto-mode` in the CLI). That is Cursor's Custom Mode.
- Every other pstack skill is a slash command: `/arena`, `/swarm`, `/interrogate`, `/architect`, `/tdd`, `/how`, `/why`, `/unslop`, and the rest.

To share pstack with a team through a repository, install it there instead: `pstack install --scope workspace --repo <path>` copies it into `.github/skills`, `.github/agents`, and `.github/instructions`, and leaves files your team edits alone on later updates.

## Keep it current

```sh
pstack update          # sync cursor/plugins main, build, validate, install; the old version stays
pstack rollback        # switch back to the previous version
pstack status          # active version, links, model file
pstack versions
```

`update` syncs upstream into your checkout, which also edits the mapping files, so review `git diff` afterwards. It stops before installing anything when a conflict or a failing check remains, for example a new Cursor name that the adapter skill has no row for. Your installed version stays as it was, and the command lists what is missing.

### Automatic synchronization

A GitHub Actions job (`.github/workflows/upstream-sync.yml`) checks `cursor/plugins` every day and on demand. When pstack changed, it opens a pull request with the exact new copy, the Copilot migration it could prepare, the results of the compatibility checks, and a report. The pull request is a draft when adapter work is left. A conflict opens an issue instead. Nothing is ever merged automatically, and the sync never edits custom Copilot files. `pstack upstream rollback` reverts a sync. [docs/upstream-sync.md](docs/upstream-sync.md) has the details, the conflict rules, and the limits.

## How the adaptation works

1. **Core stays upstream.** 486 of the 540 files the build takes from the core ship byte-identical. That covers all 24 principles and every skill that names nothing Cursor-specific.
2. **One line, not a rewrite.** Each skill or agent that uses a Cursor name (`Task`, `subagent_type`, `AskQuestion`, `pstack-models.mdc`, `/loop`, Bugbot...) gets one line after its H1 that points to the [`pstack-copilot` adapter skill](pstack-copilot/overlays/skills/pstack-copilot/SKILL.md). That skill maps each name to Copilot's tools (`task`, `ask_user`, `sql` todos, `read_agent`, `write_agent`), models (`claude-opus-5.5` with `reasoning_effort`), paths, and transcripts. Upstream adapts pstack to Claude Code the same way, and this port wraps a superset of the same 22 skills.
3. **Native Copilot pieces where upstream assumes Cursor.** Upstream agents become custom agents (`.agent.md`) with Copilot model fields. Cursor's always-applied model rule becomes a personal instruction file. Custom Mode becomes the `poteto-mode` agent, which preloads the skill through the `skills:` field. Cursor's `/loop` maps to Copilot's own `/loop` and `/every` scheduled prompts, and Cursor's built-in `create-skill` becomes a skill. Slash commands are skills with `argument-hint`, because `.prompt.md` files run only in the deprecated Local harness.
4. **Proof, not trust.** `pstack validate` undoes every recorded transform and compares the result with the locked upstream bytes. It also checks that the build is deterministic, that every Cursor term in use has an adapter row, and that every upstream feature has a traceability entry. It then checks the Copilot schemas and links, and runs upstream's own script tests against the built copy.

## Status

[`pstack-copilot/docs/COMPATIBILITY.md`](pstack-copilot/docs/COMPATIBILITY.md) lists every skill, playbook, agent, script, and Cursor term with its support status and how it was validated. Nothing is marked validated in VS Code without a recorded session. [docs/limitations.md](docs/limitations.md) lists what does not work on Copilot and why. [tests/e2e/RESULTS.md](tests/e2e/RESULTS.md) records the VS Code runs.

## Develop

```sh
npm test                                   # manager and invariant tests
./pstack-manager/bin/pstack build && ./pstack-manager/bin/pstack validate
pstack upstream check                      # what a sync would change
pstack matrix                              # regenerate COMPATIBILITY.md from mappings/features.json
```

## License

The port's own code and documents: MIT, see [LICENSE](LICENSE). pstack itself: MIT, Copyright (c) 2026 Lauren Tan, kept verbatim in [`pstack-core/upstream/LICENSE`](pstack-core/upstream/LICENSE) and shipped in every build.
