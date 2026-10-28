# CHANGE-012 S10 — Review finding fixes

Date: 2026-10-28

## Fixes

- `read_files` now matches the approved `files` input contract and supports a
  bounded `max_total_bytes` from 16 KiB through the 256 KiB server cap.
- Node search fallback now follows ripgrep smart-case matching and deterministic
  path ordering; both engines have regression coverage.
- Git summary numstat failures now fail with `GIT_READ_FAILED` instead of
  returning an empty successful summary.
- Bulk per-item errors/skips retain requested line ranges, and the response
  budget reserves a safe metadata envelope.

## Validation

- `pnpm typecheck` — passed.
- Affected CHANGE-012 checkpoint across 9 test files — passed, 121/121.
- Bulk/MCP/worktree regression checkpoint — passed, 28/28.
- `git diff --check` — passed (Git emitted the existing `search.ts` CRLF
  normalization warning but returned exit code 0).
- Dirty-path ownership validation — passed with no unexpected paths.

## Remaining gates

- Full `pnpm test` remains non-green at 597/599 because of the unrelated
  manager-detail trailing-space assertion and parallel write-owner contention;
  `tests/write-owner.test.ts` passes 6/6 in isolation.
- External ChatGPT connector-layer verification for A1 remains unverified.
