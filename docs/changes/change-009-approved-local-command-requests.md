# CHANGE-009: Approved Local Command Requests

- **Status:** Implemented locally — pending workflow closeout and integration
- **Date:** 2026-10-05
- **Scope:** `chat-to-codex`, Linux/WSL installation broker and local CLI
- **Authority:** [SPEC-004](../specs/spec-004-approved-local-command-execution.md)
- **Related:** [SPEC-002](../specs/spec-002-approved-local-patch-writes.md); patch behavior remains unchanged
- **Baseline:** `refs/heads/main` at `fb28ac79e7f03b1753167e0278fa4178aa1f6cb5` (verified 2026-10-08; recheck at work start)
- **Primary areas:** command-request service/store/runner, broker MCP surface, OAuth scopes/consent, local admin router, CLI dispatch, process recovery, tests and canonical docs

## 1. Outcome

Implement the first SPEC-004 slice:

```text
remote MCP client
        ↓
request_command
        ↓
pending cr_...
        ↓
local user: c2c pending
        ↓
local user: c2c approve cr_...
        ↓
broker starts one exact argv invocation
        ↓
bounded terminal result
        ↓
get_command_request
```

This closes the manual handoff for tests, builds, typechecks, linters, validation helpers, and other finite non-interactive commands the user explicitly approves.

It does not create a generic remote shell.

## 2. Classification

This CHANGE implements SPEC-004 and does not extend SPEC-002.

Command requests receive their own domain service/persistence. Do not refactor `WriteRequestService` into a generic action service as a prerequisite.

## 3. Observed current behavior

Current code has `propose_patch`, local `c2c approve/reject`, a patch-specific `WriteRequestService`, explicit `workspace.write`, loopback/admin-token write-request routes, owner-only state, Linux `flock` write ownership, Linux PID/start-time process identity helpers, and no command MCP tool.

Current write-request records are structurally patch-specific (`kind: "patch"`, files, preconditions, patch body). Preserve that boundary.

## 4. Scope

CHANGE-009 implements broker-only `workspace.command`, `request_command`, `get_command_request`, a dedicated `src/command-requests/` service/store/runner, local command admin routes, mixed pending discovery plus explicit-id command approval/rejection, fixed 10-minute timeout, 256 KiB retained tail per stream, restart reconciliation without retry, docs, and tests.

No Manager UI is included.

## 5. Public contract

The canonical schemas and target-selection rule for both tools are owned by [SPEC-004 §5](../specs/spec-004-approved-local-command-execution.md#5-public-mcp-contract); input bounds are owned by §7. Reuse the existing broker resolver: omitted workspace is valid only for one unambiguous registration; zero/multiple registrations and explicit invalid targets fail closed. Store the resolved workspace/worktree ids at creation and use those ids for approval-time revalidation.

Creating or inspecting a command request starts no process.

`get_command_request` requires the same scope and concrete target ownership. Pending/running returns metadata/status; terminal execution results include timestamps, observed exit/signal, bounded stdout/stderr, truncation flags, `output_incomplete`, and resolution code as applicable. The read is observational: it projects time-based expiry/availability from one observation time but never persists expiry, pruning, or other state changes.

No remote list tool ships.

Implement the exact `SPEC-004 §5.3` MCP success/error shapes (existing `ok()/fail()` JSON-text convention): `request_command` returns only a pending creation receipt plus the local approval instruction; `get_command_request` returns immutable argv/cwd and state-dependent execution fields. `expires_at` is the pending approval cutoff; terminal `result_available_until` describes the separate 60-minute read window, not physical file deletion. Nonzero command exit remains `status="completed"` with MCP success, not `isError`. Distinguish pending/running (including pre-spawn claim)/completed/failed/interrupted/rejected/expired; do not leak another target's request existence.

`get_command_request.max_output_bytes` is per stream, defaults to 8192 UTF-8 bytes, accepts 0–65536, and only affects the response projection; retained tails remain 256 KiB per stream. Expose separate retained-stream truncation, response truncation, and `output_incomplete`. A shared MCP structured result helper is optional, not a prerequisite for V1.

## 6. Authorization implementation

Prefer a broker-only `COMMAND_SCOPE = "workspace.command"` constant similar to `git.repository.read`.

Include it in broker-supported scopes, not default scopes and not legacy bridge scopes.

OAuth consent describes both locally approved execution and captured output. Existing tokens do not gain the scope. Fix the existing `src/auth/oauth.ts` pairing introduction (currently branches only on `workspace.write`) so command-only `workspace.command` cannot show read-only language; add an explicit scope label and test command-only and combined grants.

## 7. Source layout

Recommended:

```text
src/command-requests/
├── types.ts
├── store.ts
├── service.ts
└── runner.ts

src/broker/
└── command-request-admin.ts
```

Use fewer files if clearer. Do not add command branches to patch preparation/apply modules.

## 8. Persistence and lifecycle

Use `<state-dir>/command-requests/` with owner-only atomic validated JSON records and `cr_` ids.

Pending TTL is 60 minutes; terminal requests are readable for 60 minutes after resolution; running records remain until reconciled. These are availability rules, not a physical deletion deadline. Follow SPEC-004 §12: prune during startup, before creation/approval/rejection, and after successful terminal persistence. Idle/stopped brokers can retain files indefinitely; reads leave them unchanged. Projected/persisted pending expiry uses the original expiry time so cleanup cannot restart the availability window.

States: pending, running, completed, rejected, expired, failed, interrupted.

Critical approval ordering:

```text
load pending
validate unexpired
re-resolve target/cwd
persist running claim
only then attempt spawn
```

Second approval after claim is not-pending. Record child exit separately and remain running until child close plus natural EOF on both streams; zero/non-zero/signal exits then resolve completed. Spawn failure is failed. Timeout/shutdown/restart uncertainty and capture failure resolve interrupted, preserving any observed exit/signal and incomplete-output marker under SPEC-004 §§8–11.

Permit at most one running command per installation, including post-exit output draining and terminal persistence. If one is already running, approval of another pending command returns `COMMAND_BUSY` and leaves that request pending.

If a command starts/completes but persistence of the required terminal transition fails, never report terminal success and never make the request retryable. Block further command execution approvals in that broker process; the last durable record may remain running until restart/repair reconciliation. Do not add rollback or a second durable journal for command effects.

## 9. Runner

Invoke exact stored argv:

```ts
spawn(argv[0], argv.slice(1), {
  cwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: brokerDefinedEnvironment
})
```

Do not join argv into a shell string or add a shell blacklist. The request has no env field.

Use the SPEC-004 §10 deadline: 10 minutes from spawn attempt, active through output capture even after leader exit. On Linux/WSL the child is the leader of an owned process group/session. On timeout/shutdown, use pidfd-bound `PIDFD_SIGNAL_PROCESS_GROUP` on a verified live leader **only when runtime-supported**. Extend the existing safe leader pidfd helper narrowly. Never do identity-check-then-`kill(-pgid, ...)`: it has a PID/PGID reuse race even while attempting live cleanup. If group signaling is unsupported, pidfd-signal the verified leader only; if absent or different, send no signal, finish bounded local cleanup and record degraded termination. Persist `interrupted` + `COMMAND_TIMEOUT` for deadline expiry; never retry or promise descendant containment. Do not introduce a supervisor/cgroup for V1.

Timeout, shutdown, and capture errors share bounded cleanup: claim interruption under lifecycle serialization before termination/forced closure, destroy remaining local pipes, clear timers, safely retire handlers/buffers, and prevent child handles from holding broker shutdown open. Do not wait indefinitely for close when a descendant retains a pipe. Release the running slot only after terminal persistence; persistence failure keeps further execution blocked. Subsequent exit/close callbacks cannot reclassify the interruption or replace the terminal result.

## 10. Approval response and output

The admin approval route must not stay open for full command duration. After durable claim, return running only after Node emits the child `spawn` event; an `error` before `spawn` is a persisted spawn failure. Broker persists the later terminal result asynchronously.

Capture stdout/stderr separately with bounded 256 KiB tail buffers and exact retained truncation flags. Continue draining both pipes after the retention cap while discarding older bytes so high-volume output cannot deadlock the process. `get_command_request` returns 8192 bytes per stream by default, optionally 0–65536 via `max_output_bytes`, preserving UTF-8 tail text and indicating response truncation separately. Do not expose the full 512 KiB retained output on a routine remote inspection. No remote partial streaming. Do not route arbitrary command output through normal C2C logs.

Follow SPEC-004 §11 for `output_incomplete`: natural EOF with retained tails permits false even when the size cap truncated older bytes; forced closure, capture errors, or missing capture after restart require true. A capture error uses `COMMAND_OUTPUT_INCOMPLETE`; deadline expiry uses `COMMAND_TIMEOUT`. Persist normal completion only after both streams reach natural EOF and child close is observed.

Local CLI display escapes terminal controls.

## 11. Cwd/environment/recovery

Reuse workspace path-security primitives for cwd containment at creation and immediately before spawn.

No request-controlled env. Runner may derive environment from broker process for compatibility; document that this is not secret isolation.

On startup reconcile stale running records before exposing command approval. After broker restart there is no trustworthy live `ChildProcess` ownership for the old group, so do not perform check-then-`killpg`. If the persisted leader identity still matches, reuse the existing pidfd-safe process helper to signal only that verified leader process; otherwise send no signal. Mark the request `interrupted` / `BROKER_RESTART`, never reset it to pending, and never respawn it. Descendants may survive this exceptional restart path; document that limitation.

Persist child identity as soon as safely available after spawn and document both the residual crash window and the weaker post-restart cleanup guarantee; do not claim exactly-once process execution or post-restart process-tree containment.

Graceful shutdown rejects new approvals, attempts bounded owned-process-group termination, and does not wait indefinitely.

## 12. CLI integration

`c2c pending` combines pending patch and command requests, showing kind, target and (for commands) cwd plus safely escaped compact argv preview. Keep patch summaries unchanged.

`c2c pending cr_<id>` shows complete argument-by-argument argv, target, cwd, reason, creation, expiry and command metadata/terminal summary. Never display concatenated argv as if it were a shell command. If full local output is included, require explicit `--output`; keep patch `--diff` patch-only.

Preserve no-id patch behavior. Command approval/rejection always requires explicit `cr_` id.

Accepted approval prints a started result and does not wait for completion.

If the approval POST was dispatched but its response is lost, cancelled, or times out, print an unknown outcome with the request id and do not retry automatically. Explicit request inspection is the reconciliation path.

## 13. Broker wiring

Reuse the broker's existing installation-wide writer lease and the same physical lock key already used by SPEC-002. Do not add a second command-owner lock and do not rename the physical lock in this change.

Fail-closed order: acquire the existing installation writer lease, initialize command store/service, reconcile stale running records, register local admin router, register MCP tools, then expose capability.

If command initialization fails, omit command capability but keep unrelated reads.

Do not expose command tools through `src/bridge/server.ts`.

## 14. Tests

Cover exact §5.3 request/receipt/error cases (including completed nonzero exit), get `max_output_bytes` 0/default/max/invalid and UTF-8 projection with independent truncation markers, command-only OAuth consent, safe CLI compact/detail argv previews, supported/unsupported pidfd group signaling without numeric killpg races, store validation/atomicity, TTL/retention, observational read byte-invariance, lifecycle races, duplicate approval, one-running installation limit, pre-spawn error versus spawn-event acceptance, spawn failure, non-zero exit, timeout, multi-MiB output with continued pipe draining and bounded tails, terminal-receipt persistence failure plus approval blocking, lost approval-response reconciliation without retry, live-process-group timeout/shutdown cleanup, restart reconciliation that pidfd-signals only a verified surviving leader and never performs check-then-`killpg`, argv literal boundaries, stdin/TTY absence, cwd traversal/symlink escape, cross-workspace lookup, terminal escape injection, scope isolation, no default scope, no legacy bridge discovery, shared installation-writer ownership, and the full request→approve→result integration in a disposable workspace.

Implement the direct-evidence checks in [SPEC-004 §22](../specs/spec-004-approved-local-command-execution.md#22-validation-requirements): delayed EOF after leader exit; descendant-held pipes and capture errors with bounded cleanup, slot release, late-callback safety and `output_incomplete`; zero/one/multiple workspace selection and stable stored targets; idle read cutoff versus physical cleanup at each named lifecycle trigger; and aligned skill/protocol flows for local approval, reauthorization and receipt interpretation.

Run affected write-request, OAuth, broker/MCP, CLI, and process-identity suites, then `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

Do not weaken SPEC-002 tests; update wording to distinguish no direct executor from the approval-gated flow.

## 15. Documentation

Update `docs/architecture.md`, `docs/security.md`, `docs/protocol.md`, `docs/multi-workspace.md`, `docs/local-e2e.md`, and the existing workflow owner `skill/SKILL.md` when the feature ships.

Required truths: no direct/general remote executor; request creation does not execute; local approval may run arbitrary code as the local user; approval is not sandboxing; output may disclose local data; `workspace.command` is explicit/non-default; patch capability stays separate.

Follow SPEC-004 §23: add only the approved-command exception to existing Codex execution/recovery ownership, reuse scope reauthorization guidance, require the user's explicit local id approval, and inspect terminal status plus `output_incomplete` before claiming successful completion. Explain that results become unavailable after 60 minutes but on-disk cleanup is lazy with no deletion deadline. This plan does not yet change the shipped skill or add a second workflow owner.

## 16. Non-goals

No Manager review, shell-string API, interactive terminal, streaming output, remote cancel/list/history/retry, env overrides, custom timeout, sandbox/container, strong descendant-process guarantee, remembered approvals, command policy engine, Windows/macOS support, or automatic Codex execution records.

## 17. Acceptance criteria

| ID | Required behavior |
| --- | --- |
| A1 | `request_command` creates pending state and starts no process. |
| A2 | Only explicit non-default `workspace.command` can create/read requests; legacy bridge excludes it. |
| A3 | Command starts only after local `c2c approve cr_...`; no-id approval cannot select command. |
| A4 | Runner preserves argv boundaries and adds no implicit shell parsing. |
| A5 | Relative cwd is canonicalized/contained at creation and immediately before spawn. |
| A6 | Durable running claim precedes spawn; duplicate/restart/timeout never auto-respawn; only one command may run per installation. |
| A7 | Exit zero/non-zero/signal are recorded separately; completion requires child close and natural EOF on both streams. Spawn errors remain distinct. |
| A8 | No stdin/TTY; the fixed 10-minute execution/capture deadline survives leader exit; interruption cleanup is bounded to five further seconds and uses pidfd-safe group/verified-leader signaling or no signaling when safe signaling is unavailable. |
| A9 | stdout/stderr tails each ≤256 KiB; `get_command_request` returns 8192 UTF-8 bytes per stream by default, supports 0–65536, with separate retained/response truncation and `output_incomplete`; pipes keep draining. |
| A10 | argv/reason/output cannot inject active terminal controls into local CLI. |
| A11 | stale running requests reconcile interrupted without retry; post-restart signaling is limited to the verified leader via the pidfd-safe helper, never check-then-`killpg`. |
| A12 | Existing patch proposal/apply/rollback behavior remains regression-clean. |
| A13 | Command service reuses the existing installation writer lease/physical lock key; no second owner authority exists. |
| A14 | Command inspection is observational and leaves persisted request bytes unchanged. |
| A15 | Terminal receipt persistence failure cannot fabricate success/retry eligibility and blocks further execution approvals until restart/repair. |
| A16 | Approval reports running only after the child `spawn` event; a lost approval response is unknown and never auto-retried. |
| A17 | Command init failure fails closed without disabling unrelated reads. |
| A18 | Docs and the existing skill align on the local-approval exception, reauthorization, receipt interpretation, and absence of sandbox/rollback guarantees. |
| A19 | Both tools use SPEC-004's optional-workspace rule and stored concrete targets; zero/multiple omitted selections and invalid explicit targets fail closed. |
| A20 | Terminal read availability ends at 60 minutes; named lifecycle operations prune files lazily, with no maximum disk-residence guarantee. |
| A21 | Process-group signaling uses a verified leader pidfd and runtime-supported process-group flag; otherwise safe leader-only/no-signal fallback, never check-then-`killpg`. |
| A22 | Exact remote result/error fields and state-dependent requiredness match SPEC-004 §5.3, including non-zero exit as MCP success. |
| A23 | OAuth command-only scope is not labeled read-only, and combined scopes remain accurately described. |
| A24 | `c2c pending` command previews safely expose target/cwd/argv; detailed view shows exact element boundaries without an extra confirmation. |

## 18. Suggested slices

**S1 — Domain/runner:** record/error types, atomic store, availability projection and named lazy cleanup, lifecycle and one-running guard through capture completion, exact argv/process-group runner, timeout/output caps, EOF-aware finalization and bounded interruption cleanup, terminal-persistence fail-closed behavior, restart reconciliation, focused tests.

**S2 — Authorization/broker:** scope, OAuth consent, MCP tools, local admin router, target isolation, integration tests.

**S3 — CLI:** mixed pending list, explicit command detail, approve/reject `cr_`, optional output display, safe terminal escaping.

**S4 — Docs/acceptance:** canonical docs and `skill/SKILL.md` synchronization, full regressions/typecheck/build, disposable installed-broker smoke.

## 19. Review questions before work authorization

Challenge only with repository evidence: fixed 10-minute execution/capture deadline plus five-second interruption cleanup budget, 256 KiB retained tail per stream plus 8192-byte default remote projection, 60-minute terminal read availability with lazy disk cleanup, approval returning after the spawn event, inherited broker environment without request overrides, one-running installation limit, and safe pidfd-bound group signaling with leader-only/no-signal fallback rather than a sandbox/supervisor.

If a stronger security property than explicit human approval is required, state it directly. The likely answer is a real sandbox, not command heuristics.

## 20. Execution status

Implementation was explicitly authorized on 2026-10-08 and completed on `codex/change-009-approved-commands`, isolated from the planning checkout. S1–S4 runtime verification is recorded in [CHANGE-009 evidence](../verification/artifacts/change-009/ledger.md).

Local installation update, push, PR, deployment and merge remain unauthorized. Workflow closeout and integration are the next steps.

The original [quality-gate resolution evidence](../verification/artifacts/spec-004/quality-gate-resolution.json) remains planning evidence; it is not substituted for runtime validation. Approved contracts above are unchanged.
