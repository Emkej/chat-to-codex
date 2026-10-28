# CHANGE-012 S13 — Git read efficiency

Date: 2026-10-28

## Implementation

- `gitHistory` now asks Git for at most `min(10,001, offset + limit + 1)`
  commits. The hard scan bound, `scan_limit` signal, expected-commit check and
  response contract remain intact.
- `gitDiff` and `compareSnapshots` select the safe summary page before running
  `--numstat`. Existing file-count limits, pagination, NUL parsing, comparison
  semantics and `full` mode remain unchanged.

## Work-count evidence

- A history page with `limit: 20, offset: 0` ran with `--max-count=21`;
  continuation and boundary tests observed 41 and the capped 10,001.
- A 10,001-commit fixture returned the remaining 10 entries with
  `truncated: true` and `truncationReason: "scan_limit"`.
- For both summary paths, a 1,000-safe-file inventory (plus a sensitive file)
  used two `--numstat` calls and 100 literal pathspecs per requested 100-file
  page. Sensitive and untracked paths stayed out of the response.

## Local validation

- `pnpm typecheck` — passed.
- `pnpm exec vitest run tests/git.test.ts tests/git-snapshot.test.ts tests/git-snapshot-boundaries.test.ts`
  — passed, 50/50.
- `git diff --check` — passed.
