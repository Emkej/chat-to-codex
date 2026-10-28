# CHANGE-012 S1 — Search completeness verification

Date: 2026-10-28

## Implementation

- Removed the ripgrep per-file `--max-count 20` cap that could omit eligible matches while returning `truncated: false`.
- Changed both ripgrep and Node fallback paths to mark `truncated` only after an additional eligible match is observed beyond the requested limit.
- Added parity coverage for 25 matches in one file and the exact-limit boundary.

## Evidence

Before the patch, the same disposable fixture produced:

| Engine | 25 eligible matches, limit 50 | 10 eligible matches, limit 10 |
| --- | --- | --- |
| ripgrep | `20`, `truncated: false` | `10`, `truncated: true` |
| Node | `25`, `truncated: false` | `10`, `truncated: true` |

After the patch, `tests/search.test.ts` passed for both engines, including the
new cases. The checkpoint runner retained the complete logs and summary in this
directory.

## Validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/search.test.ts` — passed, 16/16 tests.
- `pnpm test` — failed with two unrelated tests: `manager-detail.test.ts`
  expects terminal-control cleanup to remove one trailing space, and the
  parallel suite briefly contends for the write-owner lock.
- `pnpm vitest run tests/manager-detail.test.ts` — the same existing
  `"Alpha "` versus `"Alpha"` failure reproduced in isolation.
- `pnpm vitest run tests/write-owner.test.ts` — passed in isolation.

## Read-content diagnostic checkpoint

The C2C test connector workspace `chat-to-codex-aa044b94` returned usable
content for both `read_file` and exact-ref `git_browse`; the current test
connector did not reproduce the historical `{}` symptom. The broker/test
connector evidence is retained as a checkpoint, but the original ChatGPT
display/connector layer remains unverified and is not claimed fixed.
