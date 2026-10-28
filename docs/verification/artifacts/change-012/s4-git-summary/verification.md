# CHANGE-012 S4 — Git summary verification

Date: 2026-10-28

## Implementation

- Added `view: "full" | "summary"` to `git_diff` and `git_compare`, preserving full byte pagination as the default.
- Added NUL-safe name-status and numstat parsing, including whitespace/newline paths, rename pairs, and binary `null` counts.
- Added bounded 100-file summary pages with `summary_offset`, `next_summary_offset`, output truncation metadata, and separate validation from byte offsets.
- Reused existing sensitive-path filtering, path scoping, Git environment isolation, mode handling, and merge-base/ref preconditions.
- Documented that `git_diff` excludes untracked files; `git_status` remains the source for their names.

## Evidence

The checkpoint runner retained complete stdout/stderr logs and `summary.json` in this directory.

- `git.test.ts` covers text, binary, rename, newline-containing names, file pagination, untracked exclusion, and invalid offset combinations.
- `git-snapshot.test.ts` covers merge-base summary semantics, binary/rename statistics, exact ref identity, and invalid offset combinations.
- `broker.test.ts` covers the live MCP `git_compare` summary response and invalid byte/file offset use.
- `mcp-integration.test.ts` covers the live MCP `git_diff` summary response.

## Validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/git.test.ts tests/git-snapshot.test.ts` — passed, 32/32 tests.
- `pnpm vitest run tests/broker.test.ts tests/mcp-integration.test.ts` — passed, 40/40 tests.
- `git diff --check` — passed.

- `pnpm test` — failed, 590/593 tests passed. The three failures were the known
  `manager-detail.test.ts` trailing-space assertion and two parallel
  write-owner contention failures (`broker-daemon.test.ts` and
  `write-owner.test.ts`).
- `pnpm vitest run tests/broker-daemon.test.ts tests/manager-detail.test.ts tests/write-owner.test.ts` — broker-daemon and write-owner passed in isolation; manager-detail reproduced the independent `"Alpha "` versus `"Alpha"` failure.
