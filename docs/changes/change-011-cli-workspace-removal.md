# CHANGE-011: CLI Workspace Removal

- **Status:** Completed — implemented, validated and locally integrated
- **Date:** 2026-10-06
- **Scope:** `chat-to-codex`, local CLI workspace lifecycle
- **Authority:** [SPEC-001](../specs/spec-001-worktree-aware-workspace-access-consolidated.md) local target resolution and [multi-workspace architecture](../multi-workspace.md) durable workspace revocation
- **Baseline:** local `main` at `ca3b4a1b96618de7dfc408517a6a62face47ff72` (rechecked 2026-10-08 before preparation)
- **Primary areas:** CLI command wiring, existing broker removal endpoint, existing session semantics, focused tests and user documentation

## 1. Outcome

Expose the broker's existing workspace revocation operation through the local CLI:

```text
c2c remove [workspace-id] [--json]
```

`c2ct` receives the same command through its existing test-profile wrapper.

Without an argument, the command removes the registered C2C target containing the current working directory. With an explicit workspace id, it removes that registration directly, including stale registrations whose original filesystem root has moved or disappeared.

Removal unregisters the workspace and ends its broker-side sessions. It does not delete a repository, Git worktree, source files, conversation history, plans, execution records, or write-request history.

## 2. Classification

This is a bounded CLI lifecycle change, not a new capability SPEC.

The architecture already provides:

- durable `WorkspaceRegistry` registrations,
- `WorkspaceRegistry.remove(id)` revocation,
- `POST /admin/workspace/remove`,
- `SessionRegistry.endByWorkspace(id)`,
- fail-closed reads for revoked workspace ids,
- canonical exact/derived local target resolution from SPEC-001.

Do not introduce another registry operation, MCP mutation tool, authorization scope, workspace selector model, or confirmation framework.

## 3. CLI contract

### 3.1 Command shape

```text
c2c remove
c2c remove <workspace-id>
c2c remove [workspace-id] --json
```

Keep `c2c workspaces` as the existing list command. Do not turn it into a command group solely for removal, and do not add `use --remove`, `unuse`, `unregister`, `--force`, or `--yes` aliases.

No confirmation prompt is required. The command does not delete repository content and the registration can be recreated with `c2c use`.

### 3.2 Implicit current-target resolution

Without an id:

1. ensure the installation broker,
2. read the current `/admin/workspaces` snapshot,
3. resolve `process.cwd()` through the existing `resolveContainingLocalTarget()`,
4. remove the selected durable registration.

This preserves SPEC-001 semantics:

- a descendant directory resolves to the deepest containing explicit registration,
- an exact linked-worktree registration wins,
- an unregistered linked worktree covered by a registered main workspace resolves to that parent durable registration,
- an unrelated cwd fails closed.

Running `c2c remove` from a derived worktree therefore revokes the parent registered workspace. It does not remove only that worktree because derived worktrees have no durable registration of their own.

### 3.3 Explicit id

With `<workspace-id>`, do not require cwd resolution or filesystem access before removal. This is the recovery path for a moved or deleted registered root.

The argument is an opaque workspace id only. Do not add display-name, path, prefix, or fuzzy matching.

An unknown id is a non-zero error even though the existing admin endpoint reports `removed: false` with HTTP success. Silent success would hide typos and incorrect targets.

### 3.4 Output

Successful JSON output is:

```json
{
  "ok": true,
  "workspaceId": "example-12345678",
  "removed": true,
  "sessionsEnded": 2
}
```

Human output identifies the removed workspace id and may report the number of broker sessions ended.

Failure uses the existing local CLI convention: concise human text or `{ "ok": false, "error": "..." }`, with a non-zero exit code.

Do not expose local filesystem paths.

## 4. Session semantics

The existing broker endpoint already removes the registration and calls `sessions.endByWorkspace(id)`. Keep that endpoint authoritative and unchanged.

The local CLI also persists per-concrete-root session bindings in `agent-sessions/*.json`. Multiple main/derived roots can contain bindings whose stored `workspaceId` points to one durable parent workspace. Broker removal does not currently delete those local files.

Those local bindings are non-authoritative session caches. They are read only by the existing local session helpers and cannot keep a removed workspace registered or readable.

Do not scan or delete `agent-sessions` as part of workspace removal.

Rationale:

- broker removal already revokes the durable registration and ends its server-side sessions,
- a stale local binding grants no authorization and cannot recreate the removed registration,
- a later `c2c use` reconciles the stored binding: when its workspace id still matches, a stale heartbeat falls through to fresh session creation; when registration resolves to a different workspace id, the old binding is skipped and a fresh session overwrites it,
- post-removal scanning would add filesystem work and can race with a concurrent `c2c use` that re-registers the workspace and saves a fresh binding,
- `c2c use --end` remains the explicit per-concrete-root binding cleanup operation.

## 5. Implementation boundary

Use the existing admin endpoint:

```text
POST /admin/workspace/remove
{ "id": "<workspace-id>" }
```

No broker route, registry schema, session schema, OAuth behavior, MCP surface, or installation model changes are required.

Keep `src/cli/index.ts` thin. Register the command from a focused CLI module rather than adding target-resolution and error/output logic directly to the already-large root CLI file.

Expected task-owned paths:

```text
src/cli/workspace-remove.ts
src/cli/index.ts
tests/workspace-remove-cli.test.ts
README.md
docs/multi-workspace.md
```

Do not modify the pending CHANGE-009/010 or SPEC-004 work as part of this change.

## 6. Acceptance criteria

1. `c2c remove <id>` calls the existing removal endpoint directly and succeeds without cwd target resolution.
2. `c2c remove` resolves a containing exact registration from a descendant directory.
3. Existing SPEC-001 resolution tests continue proving derived-parent and exact-registration precedence semantics.
4. An unregistered cwd fails non-zero without sending a removal request.
5. An unknown explicit id fails non-zero.
6. Successful removal preserves the endpoint's broker-side session cleanup.
7. Successful removal leaves non-authoritative local session-binding files untouched; a later `c2c use` continues to reconcile or replace a stale binding through the existing session-creation path.
8. `--json` returns the documented stable fields without local paths.
9. `c2c use --end` remains session-only and behaviorally unchanged.
10. No repository/worktree/project files are deleted or mutated by the command.

## 7. Validation

Run the focused tests:

```sh
pnpm vitest run tests/workspace-remove-cli.test.ts tests/local-target.test.ts tests/broker.test.ts
pnpm typecheck
pnpm build
git diff --check
```

Also inspect root CLI help to confirm `remove` is registered and `workspaces` remains a list command.

No installed-profile mutation or live connector test is required for this bounded local CLI change unless implementation reveals behavior outside these existing owners.
