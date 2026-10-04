# Make runtime workspace and installation identity meanings explicit

Status: open

## Opportunity

Make the distinction between workspace bridge identity and installation broker identity explicit in runtime-state semantics and their consumers. The current `RuntimeState.workspaceId` field carries either meaning depending on context. This record preserves the decision context; it does not authorize a rename, schema migration, or implementation.

## Evidence

- Fresh static review at revision `558d0240db79c0dc6e88f55efe042abe655db07c`, branch `codex/change-005-repository-ref-inspection`.
- `src/bridge/runtime.ts:13-26` declares `RuntimeState.workspaceId` and uses the identity to address runtime records.
- `src/process/daemon.ts:38-41` constructs a `Workspace` and resolves the per-project bridge by `workspace.id`.
- `src/broker/server.ts` stores `installation.installationId` in that same field in `persistRuntime()`; its local `/health` response also exposes the installation identity through the `workspaceId` alias.
- `src/broker/installation-process.ts:121-130` validates installation ownership by comparing `runtime.workspaceId` with `installationId`.
- Completed CHANGE-004 preserves existing workspace/worktree and legacy contracts. Its broker version/revision/profile diagnostics do not migrate these runtime-state identity meanings.

## Expected benefit

Explicit identity semantics would reduce ambiguity when maintaining persisted runtime records, ownership checks, health probes, and bridge/broker lifecycle code. It would help future changes distinguish installation ownership from workspace selection without relying on call-site context alone.

## Constraints

- Preserve existing runtime records, legacy per-project bridge compatibility, health consumers, and ownership checks until a separately approved migration defines their replacement.
- The overloaded field is intentional compatibility behavior; this review establishes decision debt, not a reproduced runtime defect.
- No runtime code, stored user state, public API, or lifecycle behavior is changed by recording this opportunity.
- Future implementation must use the project's native change/spec workflow; this record is not an implementation commitment.

## Related

- [Project policy](README.md).
- [CHANGE-004](../changes/change-004-c2c-broker-runtime-identity.md).
- [Architecture](../architecture.md).
- DevEx SPEC-001 W5 evidence: `/home/emkej/projects/devex/docs/verification/artifacts/spec-001/w5/completion.md`.

## Outcome

Pending.
