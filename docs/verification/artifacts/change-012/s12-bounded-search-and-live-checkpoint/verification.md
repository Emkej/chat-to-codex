# CHANGE-012 S12 — Bounded search and combined live checkpoint

Date: 2026-10-28

## Implementation

- Added a fixed two-second cumulative scan-time guard to both ripgrep and Node
  search paths.
- When the guard expires before completeness is proven, search returns
  `truncated: true`, `truncation_reason: "scan_limit"`, `has_more: null`, and
  no continuation offset.
- Added one parity regression case for both engines and documented the bound.

## Local validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/search.test.ts` — passed, 26/26.
- `pnpm vitest run tests/mcp-integration.test.ts tests/mcp-worktrees.test.ts` — passed, 26/26.
- Affected CHANGE-012 checkpoint — passed, 123/123 across 9 files.
- `git diff --check` — passed; Git emitted the existing `search.ts` CRLF normalization warning.

## Combined A1/A7 live checkpoint

- Test connector workspace `chat-to-codex-aa044b94` returned usable
  `workspace_info`, `read_file` content for `src/workspace/search.ts`, and
  exact-ref `git_browse` content for the CHANGE-012 document.
- The connector reports broker revision `00b83ee` with test profile, while the
  current local source is on committed document revision `d541123` plus dirty
  implementation changes.
- The available wrapper exposes no `request_command` or `get_command_request`
  operation and no raw `tools/list` operation, so current ChatGPT command
  discovery and scope-denied invocation remain unverified. No source change was
  inferred from that external limitation.
