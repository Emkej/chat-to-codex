# CHANGE-012 S6 — Command-tool visibility verification

Date: 2026-10-28

## Findings

- `startBroker` initializes `CommandRequestService` only on Linux and only publishes it to MCP after `initialize()` succeeds; failure leaves the broker read-only for command capability and logs a repair warning.
- `createMcpServer` registers `request_command` and `get_command_request` only when both the broker registry and initialized command service are present. Legacy exact-root bridges therefore do not advertise them.
- The tools require the separate `workspace.command` scope. It is not in the broker default read scopes, and the existing command tests prove that missing-scope calls fail without creating approval state.
- The repository test broker advertises both command tools in raw MCP discovery when command initialization succeeds; the refreshed checkpoint also includes the new `read_files` tool in that surface.

## External connector checkpoint

The available Chat to Codex Test wrapper exposes read/search/Git tools but no command-tool wrappers. Its `workspace_info` reports test broker revision `00b83ee`, while this repository is currently at `d541123`; therefore that wrapper is a stale/external connector surface and is not valid evidence about the current source's raw `tools/list`. No C2C source change is claimed for this external visibility gap.

## Validation

- `pnpm vitest run tests/command-broker.test.ts` — passed in the final checkpoint, 9/9 tests.
- `pnpm vitest run tests/broker.test.ts` — passed in the final checkpoint, 21/21 tests.
- Final checkpoint evidence: `s6-command-visibility-rerun/summary.json`.
- An initial combined checkpoint caught a stale broker tool-count expectation after S5 added `read_files`; the expectation was updated and the complete rerun passed.

Remaining action is external: obtain a current raw broker `tools/list`, compare it with refreshed ChatGPT connector discovery, and separately test a caller with and without `workspace.command`. The existing registration and authorization boundaries must remain unchanged until that evidence identifies a responsible layer.
