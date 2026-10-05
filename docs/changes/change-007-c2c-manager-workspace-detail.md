# CHANGE-007: Add C2C Manager workspace detail

- **Status:** Completed — implemented, installed and verified
- **Date:** 2026-10-04
- **Scope:** `chat-to-codex`, WSL Manager only
- **Primary area:** Optional SPEC-003 Phase 2 workspace detail
- **Authority:** [SPEC-003](../specs/spec-003-c2c-manager-mvp.md), §11.5 and Phase 2 in §20

## 1. Problem and proposed outcome

The Manager overview displays registered workspace names and live session counts. It already supports selection, but does not open the selected workspace's detail. A user who needs its derived worktrees, branch or commit must inspect that information elsewhere.

Add a small, read-only detail view for the selected workspace, entered with `Enter` and closed with `Esc`. Reuse the validated worktree model through a bounded, cancellable asynchronous local read path. SPEC-003 remains the authority and its Phase 0 + Phase 1 MVP remains completed.

The missing view is established by static review of `src/manager/ui/workspace-panel.tsx`, `src/manager/ui/manager-app.tsx` and `src/manager/types.ts` at revision `8f098397ddb8c7c9a242c465ed53c859d6ac61f3`. This does not establish recurring user friction, time saved or high ROI.

### Approval prerequisite

The owner explicitly authorized implementation on 2026-10-04 and waived the usage-example prerequisite with a direct instruction to begin. On 2026-10-05 the owner authorized applying the prepared installed update with backup and completing acceptance.

## 2. Scope and behavior

### Navigation and presentation

- `Enter` on the overview opens the selected registered workspace. With no selection, it does not start discovery.
- Existing confirmation, Actions menu and Help input handling take precedence. Their `Enter`/`Esc` keys must not also open or close workspace detail.
- `Esc` returns to the overview with the selected workspace preserved if it still exists. Existing `q`, Ctrl+C and bounded shutdown behavior remain available.
- Show only display name, opaque workspace id, live session count, derived worktrees, branch and commit, as required by SPEC-003 §11.5. Do not display local filesystem paths, including in errors.
- Keep identity and selection based on existing workspace ids. A detached worktree has `branch: null`; present it as detached without inventing a branch name or new worktree-state model.
- Preserve the distinction between no live sessions and unavailable session information. An unavailable broker must not be presented as zero live sessions.
- Support the existing wide and narrow layouts. Long names and ids must remain readable without breaking keyboard navigation.
- Bound the detail viewport by the current terminal rows and columns, reserving space for navigation hints. Wrap long values without permanently truncating required content. In detail, `↑`/`↓` scroll one rendered line and `PageUp`/`PageDown` scroll one viewport; these keys do not change the selected workspace. Keep confirmation, Actions menu and Help input precedence. Opening detail starts at the top; refresh or resize preserves the offset where possible and clamps it to the available content. Every worktree and every wrapped value must remain reachable; `Esc` returns to the same overview selection. This scrolling belongs only to detail and does not redesign the overview.

### Lazy reads and lifecycle

- Discover derived worktrees only when opening the selected workspace detail. Overview polling and movement between overview rows must not scan all repositories.
- Reuse the validated local workspace/worktree ownership rules and contracts from SPEC-001. A displayed derived worktree is not a new registered workspace or a new authorization capability.
- Keep all detail-reachable external commands asynchronous, including any required path conversion. Accept the foreground operation's `AbortSignal`, enforce a finite whole-read deadline, and terminate/reap owned command children on cancellation or timeout. Do not wrap synchronous discovery in a Promise and treat it as nonblocking. Loading, navigation and quit handling must remain responsive while Git is slow.
- Do not fetch, checkout, create/remove worktrees, run repository commands supplied by the user, or start/restart services to load detail.
- Show explicit loading, empty and unavailable/error states. Handle missing directories, inaccessible repositories, non-Git roots and stale registry entries without crashing or attempting repair.
- Fit detail reads into the existing foreground guard and generation model. Do not start overlapping detail reads or introduce a second scheduler; retain SPEC-003 §17.1's allowance for an already-running, invalidated status refresh. Returning to the overview, closing the Manager, losing the selected workspace or changing its selection invalidates and cancels the pending detail read. Hold the foreground guard until that read and its children retire; navigation remains available during cleanup. Shutdown retains SPEC-003 §17.4's two-second terminal-restoration target.
- A late result must never overwrite the view or selection for another workspace. Refresh a displayed detail through the existing refresh interaction; it must not accumulate per-workspace background polling.
- Keep the detail read-only. Existing service, pairing and confirmation behavior stays governed by the current action policy; detail adds no lifecycle or Git actions.

## 3. Implementation boundary

Use a focused `src/manager/ui/workspace-detail.tsx` component, already anticipated by SPEC-003. Keep presentation separate from reads, selection and operation lifecycle.

Expected integration points are `src/manager/ui/manager-app.tsx`, `src/manager/controller.ts`, `src/manager/types.ts`, `src/manager/services.ts`, and the existing refresh/layout owners where required. These are candidate touch points, not permission to refactor all of them. Before implementation, inspect those owners and `src/workspace/worktrees.ts` to select the smallest safe patch.

Reuse existing services and worktree contracts. No new public API, MCP/admin endpoint, database, persisted Manager state, dependency, installation mechanism or compatibility migration is included.

### Asynchronous read prerequisite

The current `discoverDerivedWorktrees`/`WorktreeRunner` path is synchronous and reaches `runGit`, which uses `spawnSync` with a 30-second per-command timeout. It cannot be called directly from the Manager while satisfying SPEC-003 §17.2. This draft explicitly includes the minimal internal asynchronous worktree-read support needed by detail. Keep parsing and ownership validation under the canonical workspace module; share those rules rather than copy them into a Manager-specific validator. Preserve existing synchronous consumers and their contracts. No worker pool, task queue or general job framework is needed.

At the start of S1, before wiring the UI, establish this read path through `ManagerServices`: select the smallest shared-validation extraction, set a concrete finite whole-read timeout and output bound, propagate cancellation through all commands, and verify child cleanup. Use the existing five-second Manager read timeout as the default total budget, rather than multiplying a per-command timeout by the number of worktrees. Timeout produces a path-free unavailable state, never a successful empty or partial inventory. If this cannot preserve canonical validation and existing consumers within the bounded change, stop and propose the smallest scope amendment.

Keep changes local. Read line counts before editing; extract detail-specific responsibilities rather than growing an already mixed coordinator. Do not introduce a general detail-view framework or redesign the overview.

### Non-goals

- General Git dashboard, branch switching, repository-ref browsing/search/comparison or execution controls.
- Logs, test results, write-request management, workspace registration/removal or session cleanup.
- Native Windows Manager, multiple installations, runtime identity migration or DevEx plugin packaging.
- New authorization scopes, broad repository discovery, telemetry or persistent detail caches.
- Reopening SPEC-003 MVP acceptance or changing its historical evidence.

## 4. Acceptance and planned validation

| Criterion | Required evidence |
| --- | --- |
| A1 — Navigation | Selected workspace opens with Enter; Esc returns with selection preserved; empty selection makes no discovery call; confirmation/menu/help retain input precedence, including detail scrolling keys. |
| A2 — Required content | Name, opaque id, session count, derived worktrees, branch and commit match canonical read results; detached branch is null; local paths are absent from rendered output and error states. |
| A3 — Lazy loading | No worktree discovery during overview refresh or row selection; opening detail queries only its selected workspace. Refresh does not add a background polling lane. |
| A4 — Async safety | Loading, failure, removed workspace, late completion after Esc, changed selection, and shutdown are covered; stale results never enter the current view; foreground actions do not overlap. A deliberately slow command through the real asynchronous runner proves the whole-read deadline and cancellation, owned-child termination/reaping, and guard retention until cleanup; timeout is unavailable rather than empty success. |
| A5 — Read-only boundary | No service start, repository mutation, registry/state mutation, new capability or additional endpoint is caused by opening or refreshing detail. |
| A6 — Terminal behavior | At both 80×24 and 120×24, an inventory with long names/ids/branches and enough worktrees to exceed the viewport proves every entry and wrapped value is reachable with the defined scrolling keys, hints remain visible, and Esc preserves overview selection. Verify offset clamping after resize/refresh. While a deliberately slow Git command is pending, directly observe loading, responsive navigation/Esc and normal-screen restoration within two seconds after each of q, Ctrl+C and SIGTERM. |

Extend the relevant existing controller, refresh and layout tests; use canonical worktree fixtures for attached, detached, empty/unavailable and invalid roots. Add focused rendering/input tests where existing coverage cannot establish the visible requirements. Validate observable behavior rather than a copied implementation algorithm.

For the asynchronous boundary, run the canonical ownership fixtures against the new path and retain regression coverage for existing consumers. A deferred service mock alone does not prove responsiveness or process cleanup: use a controlled slow Git executable through the production asynchronous runner, observe its child exit, and exercise the real Manager input/terminal path while it is pending. Keep this probe confined to the test environment; do not replace the user's Git or alter installed state to inject it.

For implementation acceptance, run the focused affected tests, TypeScript no-emit check, build and task-scoped `git diff --check`, then the existing Manager entry/CLI regression checks. Reuse the terminal verification approach from [CHANGE-003](change-003-c2c-manager-alternate-screen.md). Final acceptance must exercise the installed `c2c manager` entry path; any build/install needed for that later check requires explicit authorization and protection of unrelated installed state.

These checks are planned, not executed by drafting this document. Retain sanitized implementation evidence under `docs/verification/artifacts/change-007/`; avoid real profile dumps, tokens, filesystem paths in screenshots, and full session transcripts.

## 5. Execution boundary and ledger

| Slice | Status | Outcome |
| --- | --- | --- |
| D0 — Draft | Completed | Existing SPEC/source requirements reconciled into this bounded proposal; draft checks in [draft validation](../verification/artifacts/change-007/draft-validation.json). |
| S1 — Detail implementation and focused verification | Completed | Bounded asynchronous reads share canonical ownership validation; detail and scrolling implemented. A1–A5 checks passed in [S1 gate](../verification/artifacts/change-007/s1-gate/summary.json); independent review's Unicode finding resolved in [repair evidence](../verification/artifacts/change-007/unicode-repair/summary.json) and [review](../verification/artifacts/change-007/review.json). |
| R1 — SIGTERM restoration repair | Completed | Keep the Manager handler registered until screen restoration so Ink's signal-exit cannot re-send SIGTERM during teardown. [Lifecycle checks](../verification/artifacts/change-007/sigterm-repair/summary.json), independent review and the real pending-read SIGTERM exit passed. |
| R2 — Installed helper export prerequisite | Completed | The older installed Git module had the canonical environment sanitizer but did not export it. Backed up that module and added only the export keyword, preserving all other bytes. Installed Manager services/UI imports passed; [installation receipt](../verification/artifacts/change-007/installed-update.json). |
| S2 — Terminal acceptance and documentation closure | Completed | [Local terminal acceptance](../verification/artifacts/change-007/terminal-local.json) and [installed-entry acceptance](../verification/artifacts/change-007/terminal-installed.json) passed, including resize/refresh clamping, slow-command deadline, child cleanup, normal-screen restoration and unchanged fixture state. Documentation and ownership closure completed. |

The installed update was separately authorized and applied with backup. Merge, push and deployment remain outside scope. Unrelated dirty/untracked work was preserved. No claim of high ROI is established by the usage-prerequisite waiver.

### Execution identity

- **Owner outcome:** Open the selected registered workspace's read-only detail in C2C Manager, with responsive cancellable reads and reachable content at both terminal widths.
- **Environment/worktree:** WSL/Linux; `/home/emkej/projects/chat-to-codex`.
- **Branch/start HEAD:** `codex/change-007-plan-review-fixes`; `f66e4b2c62362e75ba43f0d3c73135dd23f83c11`.
- **Ownership manifest:** `docs/verification/artifacts/change-007/task-ownership.json`.
- **Tracker:** `python3 /home/emkej/.codex/workflows/scripts/track_dirty_paths.py`.
- **Metrics:** continuation runs 1; observed context compactions 0; failed validation attempts 11; owner-decision round-trips 2. [Attempt classification](../verification/artifacts/change-007/failed-attempts.json).
- **Preflight:** Node 24.15.0 and pinned pnpm 11.24.0 available; existing dependencies, tmux and installed c2c present. Baseline results: `docs/verification/artifacts/change-007/preflight/summary.json`. Prerequisite failure cache initialized empty.
- **Implementation:** Existing synchronous discovery remains compatible through one canonical validation program; the async executor bounds all Git/WSL commands to five seconds and 1 MiB total output, waits for child closure, and terminates owned process groups on cancellation. Manager detail exposes only name/id/session count and path-free worktree metadata. Modal input routing and viewport presentation are focused modules.
- **S1 validation:** 118 affected regression tests passed across 11 suites; typecheck, build and task diff checks passed. Additional Unicode rendering regressions, typecheck/build and diff checks passed after the review repair. Failed attempts are classified separately; successful evidence supersedes them.
- **Local terminal acceptance:** tmux 3.2a at 80×24 and 120×24 verifies long values, all 12 branch suffixes, scrolling, refresh and Esc. During slow Git, q, Ctrl+C, SIGTERM and Esc+q restore a usable normal screen within two seconds, and owned command processes retire. A real whole-read deadline produces unavailable rather than empty inventory. Fixture installation/registry state remains unchanged.
- **Installed update:** Applied the prepared 20-file build plus the export-only prerequisite in the older installed Git module. [Prepared hashes](../verification/artifacts/change-007/prepared-app-update.json), [receipt](../verification/artifacts/change-007/installed-update.json) and [installed terminal evidence](../verification/artifacts/change-007/terminal-installed.json) are retained. Existing dependency declarations match; profile/state, launchers, skills, dependencies and running services were preserved. Terminal acceptance through `/usr/local/bin/c2c` passed with restoration in 0.098–0.169 seconds during slow reads.
- **Commit gate:** One coherent task commit covers the feature, tests, necessary terminal repair and retained evidence. Unrelated pre-existing spec and work data remain outside task ownership; no amend, push or hook bypass is authorized.
- **Current blocker:** None. All approved slices and acceptance criteria completed.
- **Closure evidence:** [Closeout](../verification/artifacts/change-007/closeout.json); ownership classification in `task-ownership.json`. Active handoff retired. Disposable terminal fixtures, private tmux servers and the prepared bundle were removed. Rollback backup of the 11 overwritten files remains at `work/change-007-installed-backup/`; the receipt distinguishes the 10 newly added files.
