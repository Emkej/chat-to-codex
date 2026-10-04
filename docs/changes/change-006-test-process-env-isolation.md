# CHANGE-006: Preserve Test Process Environment

- **Status:** Completed
- **Date:** 2026-10-04
- **Scope:** `chat-to-codex`
- **Primary area:** environment isolation in three existing test files

## 1. Problem and outcome

Some tests overwrite or delete inherited `process.env` values without restoring them. Inherited settings also change test behavior: `C2C_DISABLE_RG=1` silently removes ripgrep coverage during collection, and a non-empty `C2C_PROFILE` breaks the installation-home precedence test.

The change makes these tests establish their own environment and restore the exact incoming values after success or failure. This reduces environment-dependent failures, hidden coverage loss, and test-order coupling. Production behavior remains unchanged.

The audit on 2026-10-03 ran the three affected files with five controlled keys: `C2C_DISABLE_RG`, `GIT_CEILING_DIRECTORIES`, `C2C_HOME`, `C2C_PROFILE`, and `C2C_STATE_DIR`.

| Incoming values | Observed result before implementation |
| --- | --- |
| All absent | 48 passed |
| All empty strings | 48 passed |
| All set, including disable=`1` and a non-empty profile | 41 passed, 1 failed; six ripgrep tests were not registered |

The precedence failure was also reproduced with only an inherited profile. These results establish the problem; passing test bodies do not prove exact environment restoration. Failure-path restoration was not separately exercised in that audit. The affected code was rechecked when drafting this document and still contains the reported behavior.

## 2. Decision and file scope

Use the existing local snapshot/restore pattern. Capture before mutation; restore an absent value with `delete`, and restore every string, including `""`, by assignment. Do not use truthiness, normalize values, or assign `undefined` to `process.env`.

This is one bounded test correction. It adds no architectural boundary, public API, dependency, configuration option, SPEC, or ADR.

### `tests/search.test.ts` — per-test state and collection-time probe

- Capture `C2C_DISABLE_RG` in `beforeEach`; restore it in `afterEach`, followed by `resetRipgrepCache()`.
- Keep `configure()` local. Explicitly set disable to `"1"` for the Node engine and remove it for the ripgrep engine; reset the cache before searching.
- In `engines()`, capture the incoming disable value, temporarily remove it, and reset the cache before probing availability. Restore the value and reset the cache in `finally`, including when probing throws.
- A discovered ripgrep remains covered regardless of inherited disable. Actual absence of ripgrep still permits Node-only coverage. Discovery continues to use the existing resolver; changing `C2C_RG_PATH` semantics is outside scope.

### `tests/git.test.ts` — suite-level state

- Capture `GIT_CEILING_DIRECTORIES` at the start of `beforeAll`, before fallible fixture setup.
- Keep the suite's explicit ceiling and restore the captured value in `afterAll` before filesystem cleanup. A setup or test failure must not prevent restoration.
- Keep the existing per-test repository-override snapshot/restore unchanged.
- Correct the nearby comment: `makeTmpDir()` now uses OS temporary directories, so it must not claim that all fixtures live inside this repository. The ceiling still bounds upward repository discovery.

### `tests/workspaces-domain.test.ts` — four local test scopes

- In the four tests under `state dir precedence` and `profile state resolution`, capture `C2C_HOME`, `C2C_PROFILE`, and `C2C_STATE_DIR` locally before mutations.
- Put all environment mutations inside each existing `try` and restore all three values in `finally`.
- Tests of installation-home precedence explicitly remove the profile override. Profile tests explicitly set their profile and use a temporary home. Tests of profile resolution remove the state override; tests of state-override precedence explicitly set it.
- Preserve the separate suite-level `C2C_STATE_DIR` lifecycle owned by `isolateStateDir()` in `tests/helpers.ts`. A local restore returns to the value immediately preceding that test; it does not replace the helper's suite cleanup.

### Child-process environment boundary

Keep child-specific overrides in the explicit `env` object passed to the child. Do not mutate the parent merely to configure a child, and do not introduce parent restore logic for an independent environment object.

`tests/helpers.ts` captures its `GIT_ENV` at module evaluation. Production Git calls copy the current environment through `sanitizedGitEnvironment()`. These are distinct existing behaviors; neither needs changing for this correction.

Only the three listed test files need implementation changes. `tests/helpers.ts`, production code, and `vitest.config.ts` remain outside the patch. Do not introduce a shared environment framework, replace the whole `process.env` object, change test concurrency, or refactor unrelated suites. No responsibility extraction is needed.

## 3. Focused validation and acceptance

### Exact restoration and failure cleanup

For each affected key, verify an originally absent value, an empty string, and a non-empty sentinel. Include mixed incoming states for the three workspace keys. Compare both key presence and exact value after cleanup.

Exercise the actual cleanup owners:

1. Search: normal completion, failure after configuring the engine, and failure during the collection-time probe; environment restoration and cache reset must still occur.
2. Git: suite completion, a failing test, and setup failure; the original ceiling must be restored before directory cleanup can fail.
3. Workspace precedence/profile tests: normal completion and a forced exception after environment mutation; all three incoming values must return.

Use small local checks and a one-off lifecycle probe where hooks require observation. Observe restoration inside the same worker after the actual cleanup path. An unchanged parent of a test subprocess proves no worker cleanup, and a test of a copied restore algorithm is insufficient. Do not build a permanent worker-instrumentation framework or add production test hooks.

### Deterministic inherited-environment runs

Run the affected files under controlled child-process environments with the five audited keys absent, empty, and set. Use synthetic sentinel values and temporary paths, never a user's live state. Keep unrelated inherited settings fixed across runs.

```sh
node node_modules/vitest/vitest.mjs run tests/search.test.ts tests/git.test.ts tests/workspaces-domain.test.ts
```

All three runs must pass with the same existing test coverage. On the audited machine this means the original 48 tests, including both search engines; additional focused regressions may increase the total. Where ripgrep is genuinely unavailable, Node-only coverage is valid and must be reported explicitly.

Also run the two workspace groups independently with inherited values, so they cannot depend on an earlier `isolateStateDir()` call:

```sh
node node_modules/vitest/vitest.mjs run tests/workspaces-domain.test.ts -t 'state dir precedence'
node node_modules/vitest/vitest.mjs run tests/workspaces-domain.test.ts -t 'profile state resolution'
```

Run the focused checks plus `git diff --check`. A full-suite refactor or full-suite run is not required for this bounded correction. If implementation requires shared-helper or production changes, reassess the scope before proceeding.

## 4. Completion boundary

Implementation is complete when exact restoration, failure cleanup, and deterministic inherited-environment coverage all pass, including filtered workspace runs. Keep per-test, suite-level, and child-process ownership distinct.

During implementation, retain a concise sanitized result summary under `docs/verification/artifacts/change-006/`, recording commands, input-state labels, test/engine counts, and lifecycle-probe outcomes. Remove disposable probe files. Do not save inherited environment dumps or label planned checks as passed.

## 5. Execution ledger

- **Owner outcome:** The three affected test files restore exact incoming environment values on success and failure, with deterministic engine and precedence coverage.
- **Execution:** WSL; repository/worktree `/home/emkej/projects/chat-to-codex`; branch `codex/change-006-test-process-env-isolation`; starting HEAD `e31ab68744dbb0aec4bb495363322c3d41c20678` (merged `main`).
- **Ownership manifest:** `docs/verification/artifacts/change-006/task-ownership.json`. This repository has no tracker; the compatible existing `/home/emkej/projects/veterinar/tools/repo/track_dirty_paths.py` is used without adding tooling to this patch.
- **Metrics:** continuation runs 0; observed compactions 0; failed validation attempts 1 (mixed line endings resolved); owner-decision round-trips 0. Expected baseline reproductions are recorded separately from failed implementation checks.
- **Preflight:** Repository, branch and base verified; Node 24.15.0 and existing Vitest 3.2.7/TypeScript dependencies available. No dependency installation or service required. Baseline reproduced 48 passing tests with absent inputs, then 41 passed/1 failed and six missing ripgrep tests with set inputs. Production build/typecheck and full-suite execution are outside this test-only acceptance matrix.
- **Failure cache:** Empty; no expensive failed prerequisite reused.

| Slice | Outcome and boundary | Status | Validation |
| --- | --- | --- | --- |
| S1 | Correct all three cleanup owners and verify exact restoration, failures, and inherited-environment coverage | Completed | Absent/empty/set: 48 tests each, including 6 per search engine; filtered groups: 2 passing each; 73 same-worker lifecycle cases; diff check passed; independent review: no material findings |
| S2 | Retain sanitized evidence and close the document and coherent commit | Completed | Sanitized summary retained, disposable probe removed, owned files isolated for commit; unrelated dirty paths preserved |

Verification: [`summary.json`](../verification/artifacts/change-006/summary.json) records commands, input labels, counts and lifecycle observations. The disposable probe executes actual source callbacks in one Vitest worker and checks restoration before its outer cleanup; it manually dispatches hooks. Against the original source, the same probe intentionally fails 62 of 73 cases. The final probe and scoped diff check passed after the line-ending correction. No production code, shared helper, dependency or runner configuration changed.

## 6. Local integration closeout

On 2026-10-04 the inherited-environment matrix was rerun before local integration: absent, empty and set inputs each passed all 48 tests; the independently filtered precedence and profile groups each passed 2 tests. The committed test diff passed `git diff --check`. Original same-worker lifecycle evidence remains in the implementation summary; its disposable probe was not recreated.

Local integration and post-merge results are recorded in [`closeout/summary.json`](../verification/artifacts/change-006/closeout/summary.json), with fresh pre-merge evidence in [`closeout/pre-merge/summary.json`](../verification/artifacts/change-006/closeout/pre-merge/summary.json). Unrelated tracked changes, user-authored untracked documents and other worktrees are preserved. No push is included in this closeout.
