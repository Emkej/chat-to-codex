# CHANGE-012 S7 — Bounded Git history verification

Date: 2026-10-28

## Implementation

- Added broker-only `git_history` over the existing exact local/remote-tracking ref resolver.
- Reads pinned commit metadata in deterministic `date-order` without checkout, fetch, `git show`, or patch bodies.
- Bounds requests to 1–100 commits and offsets to 10,000, scans a bounded commit window, and reports scan/output truncation explicitly.
- Returns commit SHA, ISO timestamp, author display name, bounded subject and bounded change-path metadata; author emails and sensitive paths are not returned.
- Requires `expected_commit` for continuation pages and preserves `git.repository.read` authorization.

## Evidence

The checkpoint runner retained complete stdout/stderr logs and `summary.json` in this directory.

- `git-snapshot.test.ts` covers exact-ref history, continuation pinning, sensitive-path filtering, bounded metadata and no-email output.
- `broker.test.ts` covers MCP discovery, broker response mapping and continuation over the repository scope.
- `local-e2e-broker.test.ts` covers the live broker tool surface including `git_history`.

## Validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/git-snapshot.test.ts` — passed, 15/15 tests.
- `pnpm vitest run tests/broker.test.ts tests/local-e2e-broker.test.ts` — passed, 27/27 tests.
- `git diff --check` — pending after the next S8 edit; the S7 checkpoint itself passed its focused checks.
