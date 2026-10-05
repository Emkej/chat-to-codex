# CHANGE-008: Review Pending Write Requests in C2C Manager

- **Status:** Implemented and verified — ready for local `$close-work`; installation unchanged
- **Date:** 2026-10-05
- **Scope:** `chat-to-codex`, WSL Manager only
- **Primary area:** Workspace overview and local write-request review
- **Authority:** [SPEC-002](../specs/spec-002-approved-local-patch-writes.md), especially §§16, 19, 20, and 28; [SPEC-003](../specs/spec-003-c2c-manager-mvp.md) Manager lifecycle and read-only guarantees

## 1. Outcome

Pending write requests are reviewed daily. The Manager should show which registered workspaces have pending requests, let the user inspect the request and its patch, and provide a clear, deliberate approval action.

Add a compact pending count to each workspace row. From a selected workspace, open a request list covering that workspace and its associated worktrees, inspect a request's full diff, then approve it through the existing broker-owned write-request lifecycle.

This is a bounded post-MVP Manager change. It does not reopen SPEC-003 or replace the existing CLI workflow.

## 2. Observed current behavior

- The Manager overview shows registered workspaces, health, and activity; it has no pending-request data or request-review view.
- The CLI supports `c2c pending`, `c2c pending <request-id> --diff`, `c2c approve`, and `c2c reject`.
- The local admin API accepts `workspaceId`, optional `worktreeId`, `status`, and `limit` filters. Omitting `worktreeId` selects requests across the workspace's worktrees.
- Approval revalidates and applies the patch through the broker-owned `WriteRequestService`.
- The user reports reviewing pending requests daily and wants their presence visible in the workspace list.

## 3. Scope and behavior

### 3.1 Workspace overview

- Show a compact exact count of active pending requests on each workspace row, including requests for that workspace's main target and derived worktrees.
- Count only requests that are pending and not yet expired. Do not include applied, rejected, stale, expired, or failed receipts.
- Show request-count unavailability distinctly from zero when the broker/admin read fails or exhausts its read budget. Only a complete successful projection supplies an exact count; never turn an unknown or partial count into “no requests.”
- Refresh counts with the existing Manager refresh lifecycle; do not add a second polling scheduler or a request per workspace on every refresh.

### 3.2 Request review

- The selected workspace can open a request list filtered to that workspace across all its worktrees. Requests belonging to other workspaces must not appear.
- Show enough receipt metadata to identify the target and review scope: request id, main/worktree target, creation/expiry, and changed-file summary using workspace-relative paths.
- A user can open a request and inspect its full patch diff before approval. Long diffs must remain navigable in narrow and wide terminals.
- Render literal terminal control characters in patch content and filenames as visible escapes, never as executable terminal sequences or silently stripped bytes. Preserve logical line/hunk boundaries and distinguish literal backslashes from generated escapes. This is presentation only: retain the broker's original patch bytes and approve the reviewed request id, not a reconstructed display string. The workspace-metadata formatter's control-stripping behavior is unsuitable for patch review.
- Selecting or viewing a request never applies it. Approval is a separate explicit action with a confirmation step after review.
- Approval calls the existing local broker admin endpoint and canonical write-request service. It applies the patch; it is not a status-only acknowledgement.
- Cancelling confirmation before dispatch sends no approval POST and applies nothing. Once dispatch begins, cancellation, timeout, or quitting ends the Manager's wait only; it cannot promise to cancel or roll back broker approval. Use a finite approval-response wait, preserving the existing local client's 60-second upper bound and the Manager's two-second terminal-restoration target on exit.
- If the approval response is lost or cancelled, show an unknown outcome while the Manager remains open and retain the request id in transient UI state. Never automatically repeat the approval POST. Reconcile that id through the non-mutating receipt read in §3.3, using the existing foreground/completion-refresh lifecycle or an explicit refresh, without a new polling scheduler. A terminal receipt supplies the canonical outcome; pending, missing, or unavailable receipts do not prove that the dispatched operation applied nothing. Keep the approval action disabled for that unresolved attempt and expose the request id for CLI inspection if needed.
- If a request expires, becomes stale, or is no longer pending between review and approval, do not apply it; show the canonical error/result and refresh the workspace count.
- Preserve the current workspace selection when returning from request review. `q`, Ctrl+C, SIGTERM, resize, and foreground-operation cancellation retain the Manager's existing lifecycle guarantees.

### 3.3 Read ownership and side effects

- The installation broker remains the sole write-request state owner. The Manager must not read request files directly, instantiate a second state writer, add a daemon, or duplicate approval/security policy.
- `WriteRequestService.listRequests()` and `getRequest()` currently run lazy expiry/pruning under the write lifecycle mutex. Calling them from Manager polling would mutate request state during an apparent read and conflict with the Manager's observational-read contract.
- Provide broker-owned, bounded, non-mutating reads for Manager counts, list, diff, and same-request outcome reconciliation. They reuse the existing admin transport and canonical record validation, but overview refresh and request inspection must not persist expiry transitions or prune receipts. Expiry is rechecked by the existing approval operation. The reconciliation read may return a terminal receipt for the selected request id without exposing a history list or terminal patch content.
- The overview count must be exact and avoid per-workspace polling fan-out. Request-list limits must not silently hide additional pending requests; use bounded pagination or an explicit overflow state if the service limit is reached.
- Preserve the current CLI cleanup and approval semantics unless a separately reviewed change is needed. Do not change the canonical write owner or add new persisted request state.

### 3.4 Read mechanism prerequisite

Establish and verify this broker read path before wiring the UI. The current `WriteRequestStore.list()` synchronously materializes every record, including pending patch bodies, and the service applies its 100-item limit only afterward. A small summary response over that path would not satisfy this change.

- Use asynchronous directory iteration and sequential record reads under the broker's existing lifecycle serialization. Reuse canonical validation, capture one observation time after acquiring the guard, and filter pending expiry against it. Keep the scan consistent with broker-owned creates, transitions, and pruning; do not introduce another writer or independent lock owner.
- Use the existing five-second Manager whole-read budget, including transport and time waiting for lifecycle serialization. Propagate cancellation to the broker read, check the remaining deadline during traversal, and close owned directory/file handles on completion, failure, timeout, or disconnect. A cancelled or timed-out queued read must not later start scanning. Do not reset the budget for each record or merely race a timeout against an unrestricted synchronous scan.
- Aggregate counts over the complete inventory, independently of the displayed list/page limit. Retain only the workspace-count map, a bounded page of receipt metadata when requested, and one decoded record at a time; release each patch body before reading the next record. Do not accumulate all filenames, records, or patch bodies, and do not call the existing whole-store `list()` as an implementation shortcut. Normal scan work grows with the records and bytes inspected; the deadline bounds how long it may continue.
- If traversal, validation, or the deadline prevents a complete scan, return unavailable rather than partial counts or an apparently complete request list. A list overflow indicates omitted display entries after a successful scan; it is distinct from scan failure. Preserve canonical ordering and bound retained list metadata to at most the existing 100-item service maximum.
- Summary/list responses contain no raw patches. Only the selected request's detail fetch transfers its patch into the Manager, within the existing 1 MiB patch limit. Same-id outcome reads return receipt metadata only. No persisted count index, cache, database, or background cleanup job is needed.

### 3.5 Manager lifecycle integration

- Counts remain part of the existing status refresh. List, detail, receipt reconciliation, and approval operations use the existing foreground guard and generation model; no two foreground operations run together. Navigating away, changing the selected target, or closing the Manager invalidates and cancels owned reads, and late results cannot enter another request's view.
- Preserve SPEC-003 §§14.2–14.3: starting a foreground action immediately invalidates and requests cancellation of any active status refresh, but does not wait for that refresh to retire. That one obsolete refresh may overlap the action and must never commit. After the action, retire the obsolete read before starting the single completion refresh. Do not extend read cancellation into a promise to undo an already-dispatched approval.

## 4. Boundaries

This change does not add request creation/proposal flows, terminal request history browsing, bulk approval, automatic approval, approval policies, notifications, or workspace registration. The same-id terminal-receipt lookup in §3.2 is limited to resolving an uncertain approval outcome. Rejection remains available through the CLI and is not included in this initial screen. The Manager continues to operate on the selected existing C2C profile and supported WSL installation.

## 5. Acceptance criteria

| Criterion | Required behavior |
| --- | --- |
| A1 — Workspace visibility | Every registered workspace row shows its exact active pending count across associated worktrees after a complete successful scan; failure or budget exhaustion is unavailable, never zero or a partial count. |
| A2 — Target isolation | Opening one workspace's queue returns only that workspace's requests, including its worktree requests; no cross-workspace request is exposed. |
| A3 — Review before apply | Request metadata and complete diff are navigable at narrow and wide widths; literal control characters are visibly escaped without loss of line/hunk structure, and viewing never mutates project files or the stored patch. |
| A4 — Explicit approval | The user must select and review a request, then explicitly confirm approval. The Manager uses the broker admin API and the canonical service; it never applies a local duplicate of the patch. |
| A5 — Freshness and failures | Expired, stale, resolved, or unavailable requests cannot be presented as approvable successes. Approval revalidates through the canonical service and refreshes the view/count after completion. |
| A6 — Observational reads | Opening/refreshing the Manager, loading counts, and inspecting request details leave request-state files byte-identical. Lazy expiry/pruning behavior remains owned by the existing explicit broker operations. |
| A7 — Responsive lifecycle | Foreground reads/actions share one guard; counts stay in status refresh. One invalidated pre-action status read may retire in parallel, cannot commit, and must retire before completion refresh. Selection, cancellation, and bounded terminal cleanup remain intact. |
| A8 — Bounded data loading | One broker scan aggregates exact counts within the five-second whole-read budget using incremental storage reads and bounded retained data. The 100-item display limit cannot truncate counts; overflow and scan unavailability are explicit and distinct. Only selected detail transfers a raw patch. |
| A9 — Approval cancellation and uncertainty | Cancelling confirmation sends no POST. After dispatch, abort/timeout cannot assert zero effects or cause automatic retry; a non-mutating same-id receipt lookup establishes the terminal outcome, or the attempt remains explicitly unresolved. |

## 6. Validation plan

- Add focused broker/service tests with more than 100 active requests across multiple main/worktree targets, plus expired and terminal records. Prove exact per-workspace counts independently of list overflow and verify request-state bytes remain unchanged.
- Exercise the real storage traversal with controlled slow reads, cancellation while waiting for lifecycle serialization, and large valid patches. Observe maximum in-flight/retained records and page metadata rather than inferring memory bounds from a small response. Verify the whole-read deadline, guard/handle release, continued broker responsiveness, no later scan from a cancelled queued read, and unavailable rather than partial results on budget exhaustion. Verify summary/list responses contain no patches.
- Test actual broker admin routes for workspace filtering, expiry projection, request detail, diff retrieval, same-id terminal receipt reconciliation, and error mapping.
- Test Manager controller/UI states for zero, positive, unknown, loading, overflow, stale/expired, approval confirmation/cancellation, unresolved approval outcomes, and count refresh after approval.
- Verify cancellation before dispatch sends no approval POST. Delay a real broker approval and lose/abort its client response after dispatch; verify the Manager never reports zero effects or retries automatically, same-id reconciliation reports the canonical terminal receipt, and repeated confirmation cannot apply twice. Pending, missing, or unavailable reconciliation results must retain an unknown outcome.
- Delay a count refresh, start approval without waiting for that obsolete read, and finish the action before the old read retires. Verify the obsolete result cannot commit and exactly one completion refresh starts only after retirement. Cover late list/detail results after navigation or target changes.
- Render literal ESC/ANSI sequences, other terminal controls, and literal escape-looking text in diff content and filenames at both widths. Verify generated visible escapes are distinguishable, every hunk remains reachable, and no input control sequence reaches terminal output as an active sequence. Confirm review leaves stored patch bytes unchanged and approval targets the same request id.
- Verify receipt metadata does not disclose absolute workspace roots and requests from another workspace cannot be selected. Patch source text may itself contain absolute-path literals; do not redact or alter the proposed content to satisfy a metadata-only restriction.
- Run affected write-request and Manager suites, full typecheck/build, and task-scoped diff checks.
- Exercise the installed `c2c manager` path in narrow and wide terminal sessions; verify the diff remains navigable, explicit approval applies exactly once, and cancelling confirmation applies nothing. During slow reads and an already-dispatched approval, verify q/Ctrl+C/SIGTERM restore the terminal within the existing two-second target without promising to undo broker effects.
- Snapshot the disposable request-state files before and after Manager refresh and request inspection to prove read invariance.

## 7. Implemented decisions

- “Has requests” is represented as an exact number of active pending requests, rather than a boolean badge.
- Counts and request-list navigation are scoped to the registered workspace selected in the Manager; request counts include its derived worktrees.
- This slice adds inspection and approval, including same-id outcome reconciliation. Rejection/history browsing remain in the CLI unless the owner expands scope.
- Daily usage is the ROI evidence supplied for this draft; no production frequency telemetry is assumed.

## 8. Work tracking

- **Owner outcome:** See pending requests per workspace and inspect/apply a selected request from the C2C Manager.
- **Authorization:** Owner invoked `$start-work` for this record on 2026-10-05, authorizing bounded implementation and the workflow's local slice commit gate. Installation, push, PR and deployment remain outside scope.
- **Execution:** WSL/Linux; `/home/emkej/projects/chat-to-codex`; branch `codex/change-008-pending-write-requests`; start HEAD `30db47c86b29f05cc735fdd0ebe4a12449f269b9`.
- **Ownership:** `/home/emkej/projects/chat-to-codex/docs/verification/artifacts/change-008/task-ownership.json`; tracker `python3 /home/emkej/.codex/workflows/scripts/track_dirty_paths.py`. Pre-existing untracked spec/work/worktree data is excluded.
- **Metrics:** continuation runs 0; observed context compactions 0; failed validation attempts 9; workflow owner-decision round-trips 0. This includes the initial ownership check before evidence claims, two broker fixture assertions/comparison attempts, one CRLF diff check, four terminal probe marker/input synchronization attempts, and one final instrumentation attempt stopped because global array spies recursively recorded their own calls. Corrected checks passed; no failed acceptance remains.
- **Preflight:** Node 24.15.0, pinned pnpm 11.24.0 and existing dependencies available; typecheck and write-request/admin baseline passed ([summary](../verification/artifacts/change-008/preflight/summary.json)). Prerequisite failure cache initialized empty.

| Slice | Status | Outcome and boundary |
| --- | --- | --- |
| S1 — Broker observation | Completed | Bounded non-mutating inventory/detail/receipt reads and guarded local admin transport. Exact counts, overflow, isolation, read invariance, sequential reads, deadline/queue cancellation and existing write regressions passed; [gate](../verification/artifacts/change-008/s1-gate/summary.json), [independent review](../verification/artifacts/change-008/s1-review.json). |
| S2 — Manager review and approval | Completed | Counts share the existing refresh; scoped queue/diff, explicit confirmation, retained unknown attempts and same-id reconciliation share the foreground guard. Real broker response-loss/cancellation applies once and reconciles without retry. [Gate](../verification/artifacts/change-008/s2-gate/summary.json), [review repair](../verification/artifacts/change-008/s2-review-repair/summary.json), [review](../verification/artifacts/change-008/s2-review.json). |
| R1 — Persistent uncertain-outcome display | Completed | Unresolved approval id stays in the fixed header at any scroll offset; the footer shares the controller's approval predicate. [Focused gate](../verification/artifacts/change-008/r1-outcome-header/summary.json) and [independent review](../verification/artifacts/change-008/r1-review.json) passed. |
| S3 — Terminal acceptance | Completed | Twelve disposable tmux cases passed: local and installed-launcher candidate import at 80/120 columns, all hunks/escapes, resize, cancelled confirmation, slow-read exits/deadline, q/Ctrl+C/SIGTERM during dispatched approval, visible terminal receipt, exactly-once apply and count refresh. [Gate](../verification/artifacts/change-008/s3-terminal-final/summary.json), [evidence](../verification/artifacts/change-008/terminal-acceptance.json). Installed files/live profile untouched; scratch and fixture processes removed. |
| S4 — Documentation and final validation | Completed | README, architecture and local E2E owners aligned. All 512 tests in 50 suites, typecheck, build, diff and ownership checks passed; [current final gate](../verification/artifacts/change-008/final-current/summary.json). Direct metadata-retention and approval/obsolete-refresh contract checks passed ([evidence](../verification/artifacts/change-008/final-contract-checks/summary.json)). [Acceptance mapping](../verification/artifacts/change-008/acceptance.json) covers A1–A9. Local integration/closeout belongs to `$close-work`. |

### Ready for local closeout

- Implementation and required candidate acceptance are complete. Broker/Manager slices, the outcome-header repair and terminal probes are committed on the topic branch. Documentation, strengthened final contract tests and verification evidence form the final checkpoint.
- Terminal restoration in the twelve final cases took at most 0.120 seconds. No disposable fixture process or task-created scratch directory remains.
- The installed launcher was exercised through a temporary process-only import redirect to the candidate build. The candidate is not installed; installed files, live profiles and existing services remain unchanged. Installation and live restart require separate authorization.
- The typed closeout handoff is `docs/verification/artifacts/change-008/work-state.json`; ownership manifest classification passed, with task-owned documentation/tests/evidence and pre-existing spec/work/worktree data excluded. Reconcile the enclosing final checkpoint commit before Git integration.
- Concurrent, unrelated `CHANGE-009` and `SPEC-004` command-execution drafts appeared after final ownership validation. Their headers establish separate scope; they remain untouched and unclaimed. The manifest records their explicit preservation alongside the checkpoint's unclaimed workflow metadata.

### Evidence-backed follow-ups (later, outside CHANGE-008)

1. README's older blanket “read-only / no mutation surface” statements conflict with the existing SPEC-002 proposal and local broker approval path. This matters because users could infer that no local write path exists. A bounded documentation audit has medium ROI for accurate security/product expectations; keep it separate from this Manager change and reconcile the capability owner rather than changing policy.
2. The installed continuity tracker excludes only its manifest from ownership checks, while the shared contract forbids claiming other workflow metadata. A newly dirty handoff can therefore be reported as unexpected until committed. A scoped workflow-tool repair under `$codex-global-config` has medium ROI by preventing false ownership blocks; do not add another local tracker or duplicate a global rule here.
- **Draft evidence:** [Source review](../verification/artifacts/change-008/draft-validation.json).
- **Quality-gate revision:** QG-1–QG-4 from the [original review](../verification/artifacts/change-008/quality-gate-review.json) are addressed in the design and planned validation; [resolution evidence](../verification/artifacts/change-008/review-resolution.json). This is document-level resolution, not proof of implemented behavior.
