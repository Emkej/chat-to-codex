# SPEC-004 — Approved Local Command Execution

**Status:** Draft
**Date:** 2026-10-05
**Repository:** `chat-to-codex`
**Target branch:** implementation branch from `main`
**Review baseline:** `refs/heads/main` at `fb28ac79e7f03b1753167e0278fa4178aa1f6cb5` (verified during 2026-10-08 review; recheck at implementation start)
**Scope:** Explicitly approved, one-shot local command execution for the installation broker
**Related canonical docs:** `docs/architecture.md`, `docs/security.md`, `docs/multi-workspace.md`, `docs/local-e2e.md`, `docs/specs/spec-001-worktree-aware-workspace-access-consolidated.md`, `docs/specs/spec-002-approved-local-patch-writes.md`

## 1. Summary

C2C currently exposes read-only inspection and a narrow approved text-patch write capability. It deliberately exposes no generic command executor.

That leaves a high-frequency workflow outside the bridge:

```text
model proposes patch
        ↓
user approves patch
        ↓
user manually runs test/build/check
        ↓
user reports result
        ↓
model continues
```

SPEC-004 adds an explicit local approval boundary for that missing action:

```text
remote client
    ↓
request_command(...)
    ↓
pending local command request
    ↓
user reviews exact argv/cwd
    ↓
c2c approve cr_...
    ↓
broker starts that exact one-shot process
    ↓
terminal receipt with bounded stdout/stderr
    ↓
get_command_request(...)
```

Creating a command request never executes it. Only an explicit local approval may transition a pending request into one execution attempt.

This SPEC defines a small process runner, not a terminal, shell service, CI system, sandbox, deployment engine, or command-policy framework.

## 2. Why this is a new SPEC

This is not an extension of SPEC-002 patch semantics.

SPEC-002 is intentionally narrow: the payload is a unified text patch; affected files and preconditions are known before approval; approval revalidates those preconditions; patch application has a transaction/rollback model; and `workspace.write` consent describes approved text-patch mutation.

Command execution introduces different durable contracts:

- arbitrary executable invocation after approval;
- effects that may extend outside the selected workspace;
- possible network and credential access;
- process lifecycle and timeout semantics;
- stdout/stderr as a local-data egress channel;
- crash/restart ambiguity;
- no general rollback guarantee.

SPEC-002 remains authoritative for patch writes. Do not generalize `WriteRequestService` merely to host command requests.

## 3. Product principles

### 3.1 Local approval is the primary V1 policy boundary

V1 MUST NOT add command risk scores, executable allowlists/denylists, regex policies, remembered approvals, prefix approvals, or automatic approvals.

The user approves one exact stored request. If repeated approval becomes demonstrated friction, a later SPEC may define narrowly remembered exact-command approvals.

### 3.2 Exact argv, no broker-added shell parsing

The canonical request representation is an argv vector:

```json
{
  "argv": ["pnpm", "test"],
  "cwd": "."
}
```

The broker MUST preserve argument separation and MUST NOT concatenate argv into an implicit `sh -c`, `cmd /c`, PowerShell, or equivalent shell string.

An explicitly requested executable may itself be a shell or interpreter. V1 does not attempt a brittle shell blacklist; arbitrary approved programs can execute other programs anyway.

### 3.3 Approval is not sandboxing

Validating `cwd` does not confine a process to the workspace.

Unless a future sandbox is explicitly implemented, an approved command runs with the local broker user's ordinary OS permissions and may read or modify files outside the workspace, read local environment data, access the network, invoke other programs, mutate Git state, push to remotes, or perform destructive operations.

C2C MUST NOT claim filesystem confinement, network isolation, secret isolation, deterministic execution, or rollback.

### 3.4 Keep the execution surface small

V1 supports finite non-interactive process execution only.

It does not add a persistent shell, PTY, stdin forwarding, interactive prompts, live remote output streaming, background-job management, remote cancellation, remote retry, or shell-pipeline parsing.

### 3.5 Keep patch and command domains separate

Preferred source ownership:

```text
src/write-requests/       # SPEC-002 patch lifecycle
src/command-requests/     # SPEC-004 command lifecycle
```

Shared approval verbs and narrow infrastructure helpers are fine. A generic action engine is not a V1 goal.

## 4. V1 scope

V1 adds:

1. `request_command` on the installation broker;
2. `get_command_request` on the installation broker;
3. explicit OAuth scope `workspace.command`;
4. broker-owned command-request persistence;
5. local CLI discovery, approval, rejection, and explicit-id inspection;
6. one-shot non-interactive process execution;
7. bounded stdout/stderr capture;
8. timeout and crash/restart handling;
9. canonical security/documentation updates.

V1 is Linux/WSL only. The legacy per-project bridge does not expose command-request tools.

## 5. Public MCP contract

Both tools reuse the existing SPEC-001 broker target resolver. `workspace` may be omitted only when exactly one registered workspace is unambiguous. With zero or multiple registrations, omission fails closed with `WORKSPACE_REQUIRED`; an explicit unknown/revoked workspace or unavailable worktree also fails closed, without fallback to another target.

Creation stores the resolved `workspaceId` and optional `worktreeId`. Approval re-resolves those stored ids, never a newly inferred default. Inspection resolves its selectors using the same rule and then checks the request's stored target ownership.

### 5.1 `request_command`

Conceptual input:

```ts
{
  workspace?: string;
  worktree?: string;
  argv: string[];
  cwd?: string;
  reason: string;
}
```

`cwd` defaults to `.`.

The tool requires `workspace.command`, resolves the selected target, validates argv/cwd/reason bounds, persists a fresh pending request, and returns a sanitized receipt. It does not spawn a process or modify workspace files as part of request creation.

### 5.2 `get_command_request`

Conceptual input:

```ts
{
  workspace?: string;
  worktree?: string;
  request_id: string;
  max_output_bytes?: number;
}
```

It requires `workspace.command` and returns only a request belonging to the selected concrete target. A valid id from another workspace/worktree is indistinguishable from a missing request.

Pending/running results expose request metadata and status. Terminal results may additionally expose the bounded execution result.

This is a pure observational read. It MUST NOT persist expiry transitions, prune records, rewrite output, or otherwise mutate command-request state. Time-based status/retention may be projected from one observation time without changing the stored record.

V1 does not expose a remote list/history tool.

### 5.3 Exact response and error contract

Keep existing C2C JSON-in-MCP-text response conventions and `snake_case` public fields. Do not build a parallel response engine. MCP `structuredContent`/`outputSchema` may be added only via a shared, compatible helper; neither is a V1 prerequisite.

`request_command` returns a compact, successful *creation receipt* (never an execution result):

```json
{
  "request_id": "cr_example",
  "status": "pending",
  "workspace_id": "workspace-id",
  "expires_at": "2026-10-08T09:00:00.000Z",
  "approval_command": "c2c approve cr_example"
}
```

Include `worktree_id` only for a selected worktree. `approval_command` is only a local instruction for the exact id, not a remotely executable tool. No raw local absolute path appears in remote receipts.

`get_command_request` returns the exact request's current projected status, including `request_id`, `status`, `workspace_id`, optional `worktree_id`, immutable `argv: string[]`, relative `cwd`, `reason`, `created_at`, and `expires_at`. Include `resolved_at` for terminal statuses; `started_at` is present **only after confirmed process spawn**, not merely after the durable running claim. Thus a brief `running` status without `started_at` is valid. No field implies that `status="running"` alone confirms OS process startup.

`expires_at` always denotes the pending approval deadline, not the terminal read cutoff; it can be in the past while a command is running. For terminal statuses, also return `result_available_until`, calculated from `resolved_at` plus the 60-minute terminal read window (§12), without mutating the stored request. Projected pending expiry uses its original expiry timestamp as `resolved_at`. These are read-availability timestamps, not promises of physical on-disk deletion.

Execution-terminal statuses (`completed`, `failed` on spawn failure, and `interrupted`) also carry `exit_code: number | null`, `signal: string | null`, `stdout`, `stderr`, `stdout_truncated`, `stderr_truncated`, `stdout_response_truncated`, `stderr_response_truncated`, and `output_incomplete: boolean`. All four truncation fields are booleans. The first pair describes the 256 KiB retained-tail cap; the second pair describes the requested API projection cap. `output_incomplete` means capture was interrupted/failed, not that a size limit omitted earlier bytes. Pre-spawn `failed` has null exit/signal, empty streams and false truncation/`output_incomplete`, with `resolution_code="COMMAND_SPAWN_FAILED"`; other terminal states may include a stable `resolution_code`. Non-execution terminal statuses (`rejected`, `expired`) omit the execution-only fields.

A completed successful command's execution fields, for example:

```json
{
  "request_id": "cr_example",
  "status": "completed",
  "exit_code": 0,
  "signal": null,
  "stdout": "Tests passed\n",
  "stderr": "",
  "stdout_truncated": false,
  "stderr_truncated": false,
  "stdout_response_truncated": false,
  "stderr_response_truncated": false,
  "output_incomplete": false
}
```

This is an **excerpt** of the complete receipt; common identity, selector and timestamp fields remain required. For a test returning exit code 1, the same result uses `status="completed"`, `exit_code=1`, and MCP success (`isError` absent or false). A non-zero exit is an **executed-command outcome**, not a C2C tool error. `failed` is reserved for infrastructure failure before confirmed spawn.

Invalid input/target, authorization and read/approval failures use the existing MCP tool-error shape: `isError: true`, text JSON `{"error":"STABLE_CODE","message":"..."}`. Reuse existing `INSUFFICIENT_SCOPE`, `WORKSPACE_REQUIRED`, `WORKSPACE_UNAVAILABLE` and `WORKTREE_UNAVAILABLE`. Command-specific codes include `COMMAND_INVALID`, `COMMAND_REQUEST_NOT_FOUND` (including cross-target lookup), `COMMAND_REQUEST_NOT_PENDING`, `COMMAND_REQUEST_EXPIRED`, `COMMAND_BUSY`, `COMMAND_RESULT_UNAVAILABLE` (past terminal read window), `COMMAND_SPAWN_FAILED`, `COMMAND_TIMEOUT`, `COMMAND_OUTPUT_INCOMPLETE`, and `BROKER_RESTART`; the last four can appear as stored `resolution_code` in terminal receipts rather than MCP tool errors. Unknown exceptions remain sanitized `INTERNAL_ERROR`. Keep error-code reuse consistent across local admin, CLI and MCP where the operation applies; a read must not expose another target's existence.

### 5.4 Remote output projection

`get_command_request.max_output_bytes` limits the **returned UTF-8 bytes per stream**, defaults to **8192 bytes** and accepts integers **0–65536**. It does not alter stored retention (256 KiB per stream) or the result's completion/capture classification. A value of 0 is metadata-only. Return the newest suffix of each retained stream and mark `stdout_response_truncated`/`stderr_response_truncated` when that projection omits bytes; size slicing must preserve valid UTF-8 text boundaries (replacement at an invalid boundary is acceptable). The default should diagnose typical test failures in one read without flooding model context. No pagination, remote streaming or output cursor is introduced.

## 6. Authorization

Add broker-only scope `workspace.command`.

It is distinct from `workspace.read`, `workspace.write`, and `execution.read`; it is never part of default/implicit grants, must be explicitly requested, must appear in OAuth consent, is not added to old tokens, and is not supported by the legacy bridge.

Suggested consent text:

```text
Request locally approved commands and read their captured output
```

`get_command_request` also requires `workspace.command`, because command output may contain arbitrary local data. `workspace.read` alone MUST NOT grant captured command output.

The existing OAuth pairing introduction currently branches only on `workspace.write` (`src/auth/oauth.ts`). It MUST treat a command-only grant as elevated, **not read-only**, add a dedicated `workspace.command` label covering approved local execution and possible output disclosure, and retain accurate wording when both command and patch scopes are requested. Validate the command-only consent case.

## 7. Request input

Argv requirements: at least one element, non-empty `argv[0]`, no NUL, maximum 64 elements, maximum 32 KiB total UTF-8 bytes.

`cwd` defaults to `.`, must be workspace-relative, must not be absolute, must resolve to an existing directory, must remain inside the selected target after canonicalization/symlink resolution, and is revalidated immediately before process start.

`reason` is required human-facing metadata, bounded to 500 Unicode scalar values. It has no authorization or execution effect and is untrusted display text.

V1 has no request-controlled `env` field. The child uses a broker-defined environment derived from the local broker environment. This is not secret isolation.

## 8. Record and lifecycle

Use distinct ids: `cr_<opaque-random-id>`.

Canonical states:

```text
pending
running
completed
rejected
expired
failed
interrupted
```

Pending TTL is 60 minutes.

Approval MUST durably persist `pending → running` before process startup is attempted.

After that claim, duplicate approval, lost HTTP response, timeout, broker restart, or terminal failure MUST NOT make the request eligible for another execution attempt. Running again requires a new request.

If the claim succeeds but spawn fails, persist `failed`.

After successful spawn, record the child `exit` code/signal separately while the request remains `running`. Persist `completed` only when no interruption has been claimed, after the child `close` event and both captured streams have reached natural EOF without a capture error. Non-zero exit or an externally delivered signal remains a command outcome; exit code 1 from a test is not C2C infrastructure failure. Node's [`exit` and `close` events](https://nodejs.org/docs/latest-v20.x/api/child_process.html#event-close) are distinct because stdio can outlive the leader process.

`interrupted` covers broker-owned timeout/shutdown/restart recovery or incomplete capture, including a leader that has exited while a descendant retains a pipe. Preserve any observed exit code/signal alongside the interruption reason. A capture error resolves as `interrupted` / `COMMAND_OUTPUT_INCOMPLETE` through the bounded cleanup in §10. Timeout remains `COMMAND_TIMEOUT`, even when the leader's exit was already observed.

If the command has started or completed but persistence of a required terminal transition fails, C2C MUST NOT report a terminal success, MUST NOT make the request eligible for retry, and MUST block further command execution approvals in that broker process. The last durable record may remain `running`; restart/repair reconciliation owns the next transition. V1 does not invent rollback or a second durable journal for already-executed command effects.

## 9. Local approval

Remote approval/rejection is forbidden. Approval stays behind the loopback-only/admin-token local boundary.

Command approval requires an explicit id:

```text
c2c approve cr_abc123
c2c reject cr_abc123
```

`c2c approve` with no id MUST retain existing patch-request behavior and MUST NOT implicitly select a command request.

Typing `c2c approve cr_<id>` is sufficient deliberate approval for V1; no second mandatory `y/N` prompt.

`c2c pending` shows each command's id, kind, target, relative cwd and safely escaped compact argv preview, so the user can identify the request in one step. `c2c pending cr_<id>` shows complete **argument-by-argument** argv (clearly preserving element boundaries), target, cwd, reason, creation and expiry. Never present joined argv as an executable shell string or silently hide executable/argument changes. Untrusted terminal-facing strings use unambiguous escaped rendering. The remote creation receipt includes the exact local approval instruction; no additional mandatory confirmation prompt is added.

## 10. Execution contract

Intended primitive:

```ts
spawn(argv[0], argv.slice(1), {
  cwd: validatedCwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true
})
```

V1 has no stdin, PTY, interactive input contract, request-controlled environment, or broker-added shell parsing.

The execution/capture deadline is fixed at 10 minutes from the spawn attempt and cannot be raised/disabled by the request. It remains active after leader exit until normal completion in §8; leader exit alone neither clears the deadline nor releases the running slot.

V1 does not pin/hash executable bytes or snapshot repository/dependency state. Approval covers the stored argv/cwd selector under local machine state at execution time.

On Linux/WSL, each approved command starts as the leader of its own process group/session. The approval route may return `running` only after Node emits the child `spawn` event; an `error` before `spawn` is a spawn failure and must persist `failed`.

On timeout or broker shutdown, prefer **race-safe process-group signaling** through a pidfd bound to the verified *live process-group leader* using `PIDFD_SIGNAL_PROCESS_GROUP` where the running kernel/helper supports it (Linux 6.9+). Verify process identity and leadership against the bound pidfd before signaling; do not use a separate check followed by `kill(-pgid, ...)` or other unbound numeric group signal (PID/PGID reuse race). Reuse/extend the existing pidfd-safe leader helper narrowly; detect unsupported group signaling at runtime, not by an assumed kernel version. When group signaling is unavailable, the only signal permitted is to the verified leader through the existing pidfd-safe mechanism; if that leader is absent, skip signaling and perform bounded local pipe/handle cleanup. Expose degraded cleanup in the interruption receipt/logs without leaking host details remotely. Commands intentionally daemonizing or escaping the session remain unsupported; neither path guarantees arbitrary descendant termination. Do not introduce a supervisor/cgroup framework for V1.

Timeout, shutdown, and capture-error handling share a fixed cleanup budget of at most five seconds, separate from the 10-minute execution/capture deadline. Claim the interruption under lifecycle serialization before termination or forced pipe closure; subsequent exit/close events cannot reclassify it as normal completion. At the budget's end, destroy any remaining local stdout/stderr pipes, clear runner timers, retire listeners safely, and release retained buffers after forming the terminal result. A remaining child handle must not keep broker shutdown waiting. This path MUST NOT await child `close` indefinitely, including when leader identity is absent and signaling is forbidden. Persist one interrupted result, then release the running slot; terminal persistence failure instead keeps execution blocked as required by §8. Late exit/close callbacks cannot overwrite that result or initiate another execution.

## 11. Output contract

Capture stdout and stderr separately; no live remote streaming.

For each stream, retain at most the most recent 256 KiB and set an explicit truncation flag when exceeded. Separately, project at most the request's `max_output_bytes` per stream into the remote response (§5.4), reporting response truncation independently from retained-tail truncation and `output_incomplete`. Local explicit `--output` may display retained output without silently applying the remote projection cap.

The broker MUST continue draining both pipes after the retention cap is reached while discarding older bytes. Reaching the capture limit must not backpressure or deadlock the child process.

Execution results include `output_incomplete`: false when both streams reached natural EOF without a capture error and their retained tails are available, or when spawn failed before any capture was attempted (no output exists to be incomplete). Forced pipe closure, a capture error, or restart recovery without the original capture makes it true. This is independent of the per-stream truncation flags: discarding older bytes to retain the bounded tail does not itself mean capture failed. Normal `completed` results require `output_incomplete: false`; interrupted results retain whatever bounded output and exit information were observed.

Captured output is UTF-8 text with ordinary replacement behavior for invalid byte sequences.

Output may contain credentials, environment values, absolute paths, file contents, or network responses. C2C does not guarantee automatic secret redaction.

If local CLI surfaces captured output, terminal control sequences MUST render safely rather than execute.

## 12. Persistence and retention

Use a dedicated broker-owned store under `<state-dir>/command-requests/` with owner-only state posture, atomic replacement, strict validation, opaque ids, and no absolute workspace path in remote receipts.

Read availability and expiry:

```text
pending TTL:                 60 minutes
terminal read availability:  60 minutes after terminal resolution
running:                     until reconciled terminally
```

Local and remote reads project pending expiry and return a terminal request as unavailable at or after its 60-minute availability cutoff, using one observation time. For projected pending expiry, the terminal time is the original expiry time; a later read or persisted expiry transition does not restart the availability window. Observational reads do not persist transitions or perform cleanup.

Physical expiry/pruning runs during command-service startup, before command creation/approval/rejection, and after successful terminal persistence, under the command lifecycle mutex and existing installation writer lease. These operations persist pending expiry using its original expiry time and remove terminal records past the availability cutoff; running records are never pruned.

The 60-minute window is a read-availability limit, not a physical deletion deadline. Files, including potentially sensitive captured output, can remain on disk indefinitely while the broker is idle or stopped, until a named cleanup operation succeeds. V1 provides no maximum disk-residence guarantee and introduces no cleanup scheduler. Security documentation and local output guidance must state this distinction.

## 13. Crash and restart

A request found `running` after broker restart is never automatically executed again.

After a broker restart, C2C no longer owns the original live `ChildProcess` handle and MUST NOT perform a check-then-`killpg` based only on a reused numeric process-group id. Startup reconciliation may use the existing Linux PID/start-time identity and pidfd-safe signaling primitive to signal only the verified surviving group leader process. It then persists `interrupted` with `BROKER_RESTART` and never returns the request to pending or respawns it.

Descendant processes may survive this exceptional restart/crash path. That is a documented V1 limitation and is preferable to risking a signal to an unrelated reused process group. Strong post-restart process-tree containment requires a separately designed supervisor/sandbox primitive.

V1 does not claim transactional/exactly-once process creation. A small crash window exists between OS process creation and durable child-identity persistence. The durable running claim still prevents automatic duplicate execution.

Graceful broker shutdown stops accepting new approvals, makes bounded best-effort owned-process-group termination, and does not wait indefinitely.

## 14. Concurrency

The command service owns a lifecycle mutex preventing duplicate approval, approve/reject races, expiry/approval races, and terminal-state regression.

V1 permits at most one `running` command per installation, including the period after leader exit while output capture or terminal persistence is pending. If another command is already running, approving a different pending command returns `COMMAND_BUSY` without consuming or resolving that pending request.

V1 does not promise a global filesystem transaction between command execution, patch application, editors, Git, or other local processes.

Do not hold the patch `WriteRequestService` mutex for a long-running command.

## 15. CLI behavior

`c2c pending` lists both pending patch and command requests, with kind, target, relative cwd and an escaped compact argv preview visible for commands; patches retain their existing summary.

`c2c pending cr_<id>` may inspect a command request after it becomes running/terminal and shows exact argv element boundaries. `c2c approve cr_<id>` uses the stored payload; neither the preview nor the CLI reconstructs a shell command.

Captured output, if exposed locally, requires explicit detail such as `--output`; ordinary list output remains compact. Patch `--diff` remains patch-only.

`c2c approve cr_<id>` returns after durable claim and accepted process startup, not after full command duration. Terminal result is later read by explicit request inspection or `get_command_request`.

If the local approval POST is dispatched but its response is lost, cancelled, or times out, the CLI MUST report an unknown approval outcome and MUST NOT automatically retry. The request id remains the reconciliation handle; `c2c pending cr_<id>` or the remote read determines whether the durable state is pending, running, or terminal.

## 16. Admin boundary

Use a dedicated local router, conceptually:

```text
/admin/command-requests
/admin/command-requests/:id
/admin/command-requests/:id/approve
/admin/command-requests/:id/reject
```

It remains loopback-only, admin-token protected, proxy-forwarded requests rejected, and absent from public tunneled routes.

## 17. Security model

SPEC-004 protects primarily against remote execution without deliberate local approval.

It also limits capability expansion through dedicated scope, immutable stored argv/cwd, local-only approval, explicit `cr_` id, fixed timeout, bounded output, no automatic retry, and a 60-minute terminal read-availability window. On-disk output cleanup is lazy and has no deletion deadline (§12).

V1 does NOT provide filesystem/network/syscall sandboxing, container isolation, secret vault isolation, child-process allowlisting, write rollback, Git restrictions, or executable integrity pinning.

If a future requirement says approved commands may only access the workspace, a real sandbox becomes blocking. Cwd validation cannot satisfy that property.

Repository prompt injection can still cause a model to request a harmful command. The defense is exact request visibility plus deliberate local approval; model-generated `reason` is not trusted safety guidance.

Approval also authorizes the possibility that command output returns to the remote client. OAuth consent and local UX must make that understandable.

## 18. Platform and ownership

V1 is Linux/WSL only and reuses the broker's existing installation-wide writer lease and physical lock key. Do not introduce a second command-owner lock or rename the current lock as part of SPEC-004; old and new broker versions must contend on the same OS ownership resource.

Command and patch services remain separate domain lifecycles, but both exist only while that one installation writer lease is held. If the shared ownership resource or command reconciliation cannot initialize safely, command capability fails closed while unrelated reads remain available.

Native Windows/macOS are not V1 completion conditions.

## 19. Non-goals

V1 does not add direct remote exec, auto-approval, command policy/allowlist/denylist, remembered approvals, remote list/history/cancel/retry, output streaming, PTY/interactive/stdin support, persistent shells/background-job management, request env overrides, custom timeout, sandbox/container execution, privilege escalation, rollback, scheduling, Manager command review, or automatic Codex execution records.

## 20. Compatibility

Existing connectors/tokens without `workspace.command` retain current behavior.

Existing patch request behavior and scope semantics remain unchanged. No-id `c2c approve` / `c2c reject` MUST NOT begin selecting command requests.

Legacy bridge discovery remains unchanged.

## 21. Acceptance invariants

| ID | Invariant |
| --- | --- |
| V1 | `request_command` persists one request but starts no process. |
| V2 | Command tools require explicit non-default `workspace.command`; old/default tokens do not gain it. |
| V3 | Approval is local-only and command approval requires explicit `cr_...` id. |
| V4 | Broker executes the stored argv vector with no broker-added shell parsing. |
| V5 | `cwd` is relative, canonicalized/contained, and revalidated immediately before start. |
| V6 | Durable `pending → running` claim precedes spawn and permits at most one attempt. |
| V7 | Lost responses, duplicate approval, timeout, restart, or terminal failure never auto-retry; uncertain approval transport is reconciled by request id. |
| V8 | Child exit records the outcome; completion requires child close plus natural EOF on both streams. Non-zero exit remains a command result. |
| V9 | No stdin/PTY/live remote streaming/request-controlled env in V1. |
| V10 | The 10-minute execution/capture deadline survives leader exit; interruption cleanup takes at most five further seconds and never waits indefinitely for close or perform PID/PGID-reuse-vulnerable group signaling. |
| V11 | stdout/stderr retained tails are each at most 256 KiB; remote output defaults to 8192 bytes per stream (max 65536), with independent retained/response truncation and `output_incomplete` flags; pipes continue draining. |
| V12 | Remote command output requires `workspace.command` and is potentially sensitive. |
| V13 | Terminal requests become unavailable after 60 minutes; startup and named lifecycle mutations prune files lazily, with no maximum disk-residence guarantee. |
| V14 | Restart never returns stale running to pending; post-restart recovery may pidfd-signal only the verified surviving leader, then ends interrupted without unsafe process-group signaling. |
| V15 | No sandbox, rollback, machine-snapshot, or descendant-containment claim. |
| V16 | Local rendering of argv/reason/output cannot emit active terminal control sequences. |
| V17 | SPEC-002 patch service/security semantics remain isolated and regression-covered. |
| V18 | Command service reuses the existing installation writer lease/physical lock key; no second command-owner authority is introduced. |
| V19 | At most one command is running per installation; a second approval returns `COMMAND_BUSY` and leaves its request pending. |
| V20 | Command inspection is observational and never persists expiry/pruning state. |
| V21 | Terminal receipt persistence failure blocks further command execution approvals and never fabricates success or retry eligibility. |
| V22 | Approval returns running only after the child `spawn` event; pre-spawn `error` is a persisted spawn failure. |
| V23 | Unsupported/owner-unavailable command capability fails closed without disabling unrelated reads. |
| V24 | Both command tools allow omitted workspace only for one unambiguous registration; stored concrete target ids govern approval and receipt ownership. |
| V25 | The existing workflow skill documents only the locally approved command exception, explicit scope reauthorization, and receipt inspection. |
| V26 | Group signaling binds to a verified leader pidfd with runtime-supported process-group flags; fallback is pidfd-safe leader-only or no signal, never check-then-`killpg`. |
| V27 | Command MCP success/error receipts use the exact §5.3 schema, including a nonzero exit as a successful tool call with `status=completed`. |
| V28 | Command-only OAuth consent is never described as read-only. |
| V29 | Local pending summaries and details expose safe, unambiguous exact command review without a second mandatory confirmation. |

## 22. Validation requirements

Cover OAuth scope behavior, request creation with no process/workspace mutation, argv bounds, cwd traversal/symlink escape, cross-workspace lookup, duplicate approval and races, the one-running installation limit, exact argv boundaries, stdin/TTY absence, pre-spawn error versus spawn-event acceptance, zero/non-zero/signal/spawn-failure/timeout outcomes, multi-MiB output that continues to drain while retained tails remain bounded, safe terminal rendering, lost approval-response reconciliation without retry, observational read byte-invariance, terminal-receipt persistence failure with further-execution blocking, live-process-group timeout/shutdown cleanup, restart reconciliation that pidfd-signals only a verified surviving leader and never performs unsafe check-then-`killpg`, shared installation-writer ownership, owner-only state/retention, existing write/MCP/OAuth/CLI/process-identity regressions, full `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

Additional direct tests MUST verify §5.3 receipts for pending/running/pre-spawn failure/completed nonzero/interrupt/reject/expire, `max_output_bytes` at 0/default/max/out-of-range, UTF-8 tail projections, independent storage/response truncation, `output_incomplete`, stable errors and cross-target indistinguishability. Verify a command-only OAuth pairing page does not claim read-only and describes output access. Cover group pidfd signaling on supported kernels/helpers, unsupported flags, leader exit/identity race, and never targeting an unrelated group; integration tests need not assume process-group flags exist in every runner environment. Test escaped local compact and full argv presentations.

The following checks must observe the design properties directly:

1. A child exits before delayed stdout/stderr EOF: observe `running` and `COMMAND_BUSY` until close, then verify the terminal tails include all late bytes. A descendant retaining a pipe beyond the deadline, and a capture-error fixture, must each produce one interrupted receipt within the five-second cleanup budget, release local pipes/timers/buffer ownership and the running slot after persistence, and resist late-callback state regression. Assert no signal is sent after leader identity becomes absent. Test `output_incomplete` separately from size truncation; clocks/deadlines may be shortened in focused fixtures without exposing request-controlled timeouts.
2. For both command tools, test omitted workspace with zero/one/multiple registrations, explicit unknown/revoked workspace, unavailable worktree, and cross-target ids. Change the registration set after creation and prove approval uses the stored target ids without selecting a new default.
3. Observe terminal visibility just before and exactly at the 60-minute cutoff. Keep an idle broker running beyond it: reads must report unavailable while stored bytes remain unchanged. Verify startup and each named cleanup mutation subsequently remove aged files, never prune running records, and never extend an expired pending request's availability window.
4. Review `skill/SKILL.md` and protocol guidance together with representative allowed, denied, and boundary flows: proposal alone starts nothing; only the user's explicit local id approval starts a command; old/default tokens cannot create/read command requests; explicit reauthorization enables the scope; an interrupted or incomplete receipt cannot be presented as a successful completed test. Preserve ordinary Codex execution/recovery ownership and the existing patch workflow.

A disposable installed-broker smoke must prove:

```text
request_command → pending
c2c pending → exact request visible
c2c approve cr_... → one start
get_command_request → terminal bounded result
```

Use a harmless command in a disposable workspace.

## 23. Documentation synchronization

Implementation updates at least `docs/architecture.md`, `docs/security.md`, `docs/protocol.md`, `docs/multi-workspace.md`, `docs/local-e2e.md`, and the existing workflow owner `skill/SKILL.md`.

Docs must distinguish `no direct/general remote command executor` from `locally approved one-shot command requests` and state explicitly that approval is not sandboxing.

Extend the existing skill's execution boundary with the narrow `request_command` → user-run `c2c approve cr_...` → `get_command_request` workflow. Describe small default output and optional bounded expansion without automatic repeated reads. Keep ordinary Codex execution/recovery ownership and patch semantics, require fresh explicit `workspace.command` authorization using the existing reauthorization guidance, and distinguish a started receipt from a completed result with complete capture. Document the lazy on-disk cleanup limit. Update these workflow instructions when the feature ships; this planning revision does not advertise an implemented command capability or introduce a second skill.

## 24. Future extensions requiring separate evidence

Possible later work: exact-command approval remembered for a bounded local session, bounded requested timeout, Manager review, live local output, real sandbox/container execution, precise remote cancellation/process-tree ownership, and native Windows support.

If approval friction is measured, consider exact payload reuse first. Do not jump directly to prefix/executable-wide auto-approval.

## 25. Decision summary

SPEC-004 chooses exact argv + local explicit approval + one execution attempt + no implicit shell + no stdin/PTY + fixed timeout + bounded output + dedicated scope/lifecycle + an honest no-sandbox contract.

This is the smallest capability that removes the recurring test/build/check handoff without granting a permanent remote shell.
