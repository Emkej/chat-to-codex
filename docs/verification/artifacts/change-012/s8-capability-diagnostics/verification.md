# CHANGE-012 S8 — Capability diagnostics verification

Date: 2026-10-28

## Implementation

- Added additive `workspace_info.capabilities` diagnostics for broker contexts.
- Derived command tool names and required scope from the shared `COMMAND_CAPABILITY` registration definition.
- Reports separately whether command tools are registered on this MCP server and authorized for the current caller.
- Reports only the current caller's sanitized scope names; trusted in-process calls leave caller authorization unknown rather than claiming OAuth authorization.
- Distinguishes `scope_missing`, `service_uninitialized`, `platform_unsupported` and `legacy_mode` without treating a missing scope as an unregistered tool.

## Evidence

The checkpoint runner retained complete stdout/stderr logs and `summary.json` in this directory.

- `broker.test.ts` verifies registered command tools with a caller missing `workspace.command`.
- `command-broker.test.ts` verifies a broker with failed command-service initialization reports `service_uninitialized` while ordinary reads remain available.
- `mcp-integration.test.ts` verifies legacy bridge `workspace_info` compatibility remains intact.

## Validation

- `pnpm typecheck` — passed.
- `pnpm vitest run tests/command-broker.test.ts tests/broker.test.ts tests/mcp-integration.test.ts` — passed, 50/50 tests.
- `git diff --check -- docs/protocol.md docs/chatgpt.md docs/security.md skill/SKILL.md` — passed after the documentation review.
