# VS Code validation results

Runs on 2026-11-24 in VS Code 1.146 with the Copilot harness (Agent Host, Copilot SDK), pstack 0.15.48 with this port at revisions 1 and 2 (identical skills; revision 2 added one sentence to `pstack.instructions.md`). Each run was a new chat started in a scenario repository from [`fixtures.ts`](fixtures.ts), with the prompt from [`scenarios.json`](scenarios.json). Sub-roles used the inexpensive models in each repository's `pstack-models` instruction. The tool-call evidence below comes from `node tests/e2e/inspect.ts <repo>`, which reads `~/.copilot/session-state/<id>/events.jsonl`. Repository evidence comes from `git log` and `git diff` in the scenario repository.

| Scenario | Parent model | Session | Verdict |
| --- | --- | --- | --- |
| [tdd](#tdd) | claude-sonnet-5.5 | 31020e32 | Validated |
| [architect](#architect) | claude-sonnet-5.5 | 9f85ab89 | Validated, adapter not read |
| [arena](#arena) | claude-sonnet-5.5 | 3c878d04 | Validated |
| [swarm](#swarm) | claude-sonnet-5.5 | 9b0e309f | Validated, cloud note missing |
| [interrogate](#interrogate) | claude-sonnet-5.5 | 7012adf7 | Validated |
| [poteto-mode](#poteto-mode) | claude-sonnet-5.5 | 7f6dc468 | Failed: playbook skipped |
| poteto-mode, revision 2 | claude-sonnet-5.5 | c181c575 | Failed: playbook skipped |
| poteto-mode, revision 2 | claude-opus-5.5 | f0123a5b | Validated |
| [no-comments](#no-comments) | claude-sonnet-5.5 | 4cc0e1e2 | Validated |
| [loop](#loop) | claude-sonnet-5.5 | 71e321de | Not validated; led to revision 3 |

Probes before and between the runs (claude-haiku-5.5):

- **A.** A skill folder symlinked into `.github/skills/` loads, and the agent reads a sibling through the symlinked path.
- **B.** `~/.copilot/instructions/*.instructions.md` is in context. A custom agent in `~/.copilot/agents/` is a `task` `agent_type`. An agent's `skills:` field preloads a slash-only skill. The `skill` tool refuses a skill with `disable-model-invocation: true`.
- **C.** After the real install, the symlinked `pstack.instructions.md` was in context, `poteto-agent` and `comment-sicko` were listed as agent types, and the repository's role lines were in context.

## tdd

`/tdd slugify('Hello  World') returns 'hello--world' ...`

- Loaded `tdd` from `~/.copilot/skills/tdd/SKILL.md`. The skill uses no Cursor names, so it carries no adapter line.
- Added `test("collapses repeated spaces into one hyphen")`, ran it, and showed it failing with `'hello--world' !== 'hello-world'`.
- Changed `/ /g` to `/ +/g`, then reran: 2 pass, 0 fail.

## architect

`/architect add client-side rate limiting to src/client.js ... Settle the shape only`

- Traced `client.js` and its callers `users.js` and `orders.js`, and named `getOrdersFor`'s `Promise.all` fan-out as the case to handle.
- Sketched two shapes. It rejected an opt-in wrapper, because it creates two ways to make a request. It chose a private queue inside `request()` with `AbortSignal` cancel, so one owner holds the state and callers do not change.
- Wrote no code: the working tree is clean.
- **Deviation:** it did not read the adapter. This skill's only Cursor-specific step, routing to arena for a large design, did not fire.

## arena

`/arena write parseDuration(text) in src/duration.js ...`

- Read the adapter, put the six phases in the `sql` todos, and wrote a 4-criterion rubric.
- Started three `task`s in background, each in its own scratch folder:
  - `general-purpose` on claude-haiku-5.5 @low
  - `general-purpose` on gpt-5.6-luna @low
  - `general-purpose` on gemini-3.8-flash
- The judge was `explore` (read-only) on gemini-3.8-flash, a different vendor from the Claude parent.
- Picked candidate 3 as the base, the same as the judge, grafted candidate 1's unit table, and rejected candidate 2 with a reason.
- Verified with `npm test`: 12 pass.
- Wrote the synthesis note.
- **Deviation:** candidate 1 wrote inside the repository instead of its scratch folder. The parent noticed and removed it.

## swarm

`/swarm run each package's check.sh under packages/ ...`

- Read the adapter, put the phases in todos, and recorded the commit SHA.
- Started three `general-purpose` workers in background on claude-haiku-5.5 @low, the `swarm workers` line.
- Report: alpha PASS (`alpha ok`, exit 0), beta ISSUES (`beta: package.json has no version`, exit 1), gamma PASS. It did not fix anything.
- **Deviation:** the workers ran locally, which is correct, but the run did not print the "Ran locally on Copilot" note the adapter asks for.

## interrogate

`/interrogate review this branch.`

- Read the adapter, then `arena/SKILL.md` by path, as interrogate routes.
- Restated the intent from the commit message.
- Created three detached worktrees and started three adversaries in background on claude-haiku-5.5, gpt-5.6-luna, and gemini-3.8-flash, the `interrogate reviewers` line.
- Reran the finding itself: `paginate([1,2,3,4,5],3,2)` returns `totalPages: 2` for a third page. All three adversaries found it.
- Dropped a `size = 0` finding as outside the intent.
- Applied no fixes and removed the worktrees.

## poteto-mode

`/poteto-mode median() in src/stats.js returns the wrong value ... repro first, then fix and verify.`

- **Sonnet 5.5, revision 1 (7f6dc468).** Fixed the bug (`[...values].sort((a, b) => a - b)`) and added a test. It did not read the adapter, the Bug fix playbook, or any principle. It opened no todo list and delegated nothing. Its repro ran in parallel with the edit, and it made no commits.
- **Sonnet 5.5, revision 2 (c181c575).** Read `worker.md` only, fixed the bug, and this time added no regression test. Same gaps.
- **Opus 5.5, revision 2 (f0123a5b).** Followed poteto-mode:
  - Restated the goal and the smallest change.
  - Read the adapter, `playbooks/bug-fix.md`, `worker.md`, and four principle skills, and put the playbook steps in todos.
  - Reproduced the bug, including the input mutation, and made the regression case one that tells string order from numeric order.
  - Committed the failing test first (`393bb37`).
  - Delegated the fix to `task` `agent_type: poteto-agent` on claude-haiku-5.5 @medium, the repository's `bug-fix` line, then reviewed the diff and reran the repro and tests itself.
  - Committed the fix (`b3f52f5`) and named the four principles that shaped decisions.
  - Skipped Opening a PR in one line because the repository has no remote.
  - **Deviation:** it ran the delegate in `sync` mode, not background.

## no-comments

`/no-comments` on a branch that adds narration comments, a commented-out line, and an "IMPORTANT: do not remove this clamp" comment.

- Read the adapter and started `task` `agent_type: comment-sicko`, the custom agent this port renders from upstream.
- It deleted 5 comments. The parent accepted the report and fixed the flagged clamp, which allowed discounts above 1, by clamping to [0, 1]. It ran no architect step, because no shape was needed.

## loop

`/loop until ready.txt in this folder contains DONE. Check every 20 seconds, max 10 iterations.`

- VS Code handled `/loop` itself and loaded no pstack skill. Its reply: "Scheduled #1 every 20s ... Run /every to manage scheduled prompts."
- The agent later reported that it had received the repeated scheduled prompts, but it had no schedule tool to list or stop them. Sending `/every` as a message errored. The chat was archived to stop the schedule.
- **Outcome:** revision 3 removed this port's `loop` skill, which the built-in shadows, and maps Cursor's `/loop` to Copilot's `/loop` and `/every`. An end-to-end predicate loop is not validated.

## Not run in VS Code

The poteto-mode custom agent (chat creation from a tool cannot pick an agent), `/setup-pstack` (its file is covered by `pstack models init` and tests), the PR playbooks (no `gh` on this machine), statechart with TLC (no Java 11), and every other skill and playbook. [COMPATIBILITY.md](../../pstack-copilot/docs/COMPATIBILITY.md) marks each one.
