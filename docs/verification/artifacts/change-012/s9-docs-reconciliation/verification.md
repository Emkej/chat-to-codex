# CHANGE-012 S9 — Documentation reconciliation and final affected-surface verification

Date: 2026-10-28

## Documentation

Updated the four files named by CHANGE-012's implementation sequence:

- `docs/protocol.md` documents the bounded read surface, separate summary
  pagination and capability diagnostics.
- `docs/chatgpt.md` documents read-tool selection, command registration versus
  caller authorization, and the separate connector tool-discovery check.
- `docs/security.md` records bulk-read, history and capability-diagnostic
  boundaries and preserves the existing scope mapping.
- `skill/SKILL.md` updates the operational tool-selection and repair guidance.

No new authorization model, command workflow or connector refresh claim was
introduced.

## Review follow-up

The read-only implementation review identified and the follow-up patch corrected:

- the `read_files` input contract (`files` plus bounded `max_total_bytes`);
- Node fallback smart-case matching and deterministic path ordering;
- fail-closed `git_diff` summary statistics errors;
- the minimum safe bulk-response envelope and line-range preservation on
  per-item error/skipped records.

## Validation

- `git diff --check -- docs/protocol.md docs/chatgpt.md docs/security.md skill/SKILL.md` — passed.
- `pnpm typecheck` — passed.
- Focused affected-surface Vitest run across 9 files — passed, 121/121 tests.
- Full `pnpm test` — 597/599 tests passed; the unrelated `tests/manager-detail.test.ts` assertion still fails because `wrapDetailValue` returns `"Alpha "` instead of `"Alpha"`, and `tests/write-owner.test.ts` contends with a parallel broker lease. The manager-detail failure reproduced in isolation (10/11); the write-owner suite passed in isolation (6/6), so neither is attributed to CHANGE-012.

## Remaining external verification

The original ChatGPT connector/display-layer `{}` symptom remains an external
A1 verification gap. Direct broker MCP reads for `read_file` and exact-ref
repository reads returned usable content; no C2C reader fix was invented for
the unverified external wrapper behavior.
