# VS Code validation

The automated tests in `tests/manager` and `tests/invariants` prove the build is upstream plus declared transforms and that the manager behaves. They cannot prove that an agent follows a pstack workflow on Copilot. That needs real sessions, and these files make them repeatable.

1. `pstack install` so the build is linked into `~/.copilot`.
2. `node tests/e2e/fixtures.ts /tmp/pstack-e2e` creates one git repository per scenario. Each has a seeded bug or a branch to review, and a repository-level `pstack-models` instruction with inexpensive models from three vendors.
3. For each entry in [`scenarios.json`](scenarios.json), start a new chat in VS Code with the Copilot harness, open the scenario repository, and send the prompt. Do any `setup` step first.
4. `node tests/e2e/inspect.ts /tmp/pstack-e2e/<scenario>` summarizes what the agent did from the session's `events.jsonl`: the skill it loaded and from where, whether it read the adapter, the pstack files it read, its todo and commit calls, and every `task` with its agent type, model, effort, and mode.
5. Check each expectation against that summary and the repository's `git log` and `git diff`. Record the verdict and the session id in [`RESULTS.md`](RESULTS.md). Set `validation: "vscode-validated"` with the evidence in `pstack-copilot/mappings/features.json` only for what a run proved, then run `pstack matrix`.
