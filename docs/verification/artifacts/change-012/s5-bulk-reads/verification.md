# CHANGE-012 S5 — Bounded bulk-read verification

Date: 2026-10-28

## Implementation

- Added `read_files` as a thin MCP endpoint over the existing `Workspace.readFile` implementation.
- Restricted requests to 1–10 items and preserved request order with stable item indexes.
- Added a shared serialized-response budget capped at 256 KiB; callers may lower it to the supported 16 KiB minimum with `max_total_bytes`, and later items become explicit `RESPONSE_LIMIT` skips rather than disappearing.
- Per-item errors and skips preserve the requested start/end line range alongside the stable index and bounded error.
- Kept individual file failures per-item, with bounded generic messages that do not expose absolute paths.
- Preserved existing path containment, sensitive-file, symlink, binary-file, line-range and continuation behavior for every item.
- Applied the existing `workspace.read` authorization boundary and both workspace/worktree selectors.

## Evidence

The checkpoint runner retained complete stdout/stderr logs and `summary.json` in this directory.

- `bulk-read.test.ts` covers ordering, line ranges, sensitive/binary/missing errors, path disclosure, and the shared budget.
- `mcp-integration.test.ts` covers the live Streamable HTTP tool and its per-item response shape.
- `mcp-worktrees.test.ts` covers opaque worktree routing for bulk reads and legacy exact-root rejection.
- `workspace.test.ts` re-runs the underlying containment, sensitive-file, symlink and reader regression suite.

## Validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/bulk-read.test.ts tests/workspace.test.ts` — passed, 22/22 tests.
- `pnpm vitest run tests/mcp-integration.test.ts tests/mcp-worktrees.test.ts` — passed, 26/26 tests.
- `git diff --check` — passed before checkpoint execution.

The repository-wide suite remains subject to the previously recorded unrelated `manager-detail` assertion and parallel write-owner contention failures.
