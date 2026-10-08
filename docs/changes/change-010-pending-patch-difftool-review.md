# CHANGE-010: Pending Patch Difftool Review

- **Status:** Draft — not authorized for implementation
- **Date:** 2026-10-05
- **Scope:** `chat-to-codex`, Linux/WSL local CLI, SPEC-002 manual-local patch review
- **Authority:** [SPEC-002](../specs/spec-002-approved-local-patch-writes.md), especially patch preparation, manual-local approval, stale detection, and §19.7 inspection before approval
- **Related:** [CHANGE-008](change-008-c2c-manager-pending-write-requests.md) remains unchanged; [CHANGE-009](change-009-approved-local-command-requests.md) is a separate command-request capability
- **Baseline:** `main` at `e323589ee9c2482bf6cb5a9d9b44bf82b86f402f` (verified 2026-10-08; recheck before implementation)
- **Primary areas:** write-request preparation/revalidation helpers, local CLI review, temporary snapshot materialization, Git difftool process handling, focused tests and SPEC-002 documentation alignment

## 1. Outcome

Add an optional external difftool review path for pending patch requests:

```text
pending patch request
        ↓
c2c pending [wr_...] --difftool
        ↓
resolve stored workspace/worktree
        ↓
re-prepare current patch
        ↓
verify stored preparation still matches
        ↓
owner-only temporary before/after snapshot
        ↓
git difftool --gui --no-index --no-prompt
        ↓
cleanup
        ↓
request remains pending
        ↓
c2c approve [wr_...]
```

The feature improves local review ergonomics without changing patch syntax, approval, persistence, write ownership, rollback, MCP, OAuth, or post-apply verification.

C2C does not implement a diff viewer. It delegates display to the user's existing Git difftool configuration.

## 2. Classification

This is a bounded UX extension of SPEC-002, not a new capability SPEC.

SPEC-002 remains authoritative for patch validation, protected paths, request lifecycle, approval, stale detection, application, rollback, and verification. CHANGE-010 adds one local inspection mode beside the existing `c2c pending --diff`.

Do not generalize write requests, add a preview lifecycle, or introduce a generic external-viewer framework as a prerequisite.

## 3. Observed current behavior

Current code already provides the required semantic inputs:

- `src/cli/write-requests.ts` supports `c2c pending [request-id]`, `--diff`, cwd-scoped implicit selection, explicit-id inspection, approval, and rejection.
- `src/write-requests/patch.ts` prepares every patch before mutation. Each `PreparedWriteFile` contains the workspace-relative path, exact `beforeBytes` for updates, exact `resultBytes`, and content hashes.
- `src/write-requests/service.ts` re-runs `preparePatch()` on approval and compares the current preparation with stored `files` and `preconditions` through `samePreparation()`.
- SPEC-002 V1 supports only update and create operations; delete, rename, binary, and metadata-only patches are out of scope.
- `src/workspaces/targets.ts` already owns registered main/derived-worktree target validation.
- `src/workspace/git.ts` already exposes the Git environment sanitization used by repository operations, but its synchronous 30-second `runGit()` helper is not appropriate for a human-driven GUI session.
- C2C currently has no difftool launch path.

The implementation should reuse these contracts rather than reconstructing changes from the stored unified diff independently.

## 4. CLI contract

Add:

```text
c2c pending [request-id] --difftool
```

Behavior:

1. With an explicit `wr_...` id, inspect that patch request directly, matching today's explicit-id `--diff` behavior.
2. Without an id, use the existing cwd-resolved relevant-target rule and require exactly one relevant pending patch request.
3. Zero matches returns the existing not-found behavior.
4. Multiple matches returns the existing ambiguity behavior and candidate ids.
5. `--difftool` is mutually exclusive with `--diff`.
6. `--difftool` is mutually exclusive with `--json`; launching a local interactive viewer is not a machine-readable operation.
7. No extra `[y/N]` prompt is added. Explicitly invoking `--difftool` is sufficient intent to open the configured review tool.
8. The command never approves, rejects, applies, stages, commits, or modifies project files.

If command requests from CHANGE-009 exist by implementation time, `--difftool` remains patch-only. A command-request id must be rejected as unsupported for this option, and implicit selection must not accidentally launch a viewer for a command request.

## 5. Review revalidation

The viewer must represent the prepared request, not an arbitrary comparison against whichever workspace bytes happen to exist when Git starts.

Required sequence:

```text
read selected pending request including stored patch
        ↓
resolve its stored workspaceId/worktreeId
        ↓
preparePatch(current target, stored patch, canonical protected roots)
        ↓
compare current files/preconditions to stored files/preconditions
        ↓
materialize prepared beforeBytes/resultBytes
```

Factor the existing `samePreparation()` logic into a small shared pure helper usable by both approval and review. Approval must retain its existing stale transition and persistence semantics.

Do not create a second patch parser, hunk applier, hash algorithm, or stale-check implementation in the CLI.

If target resolution or preparation proves that the request no longer matches its stored preparation:

- fail closed,
- do not spawn Git or any viewer,
- do not modify project files,
- report the stale/unavailable condition locally,
- do not transition the request to `stale` merely because it was reviewed.

The authoritative lifecycle transition remains approval. Existing lazy expiry behavior of the current local request read path is unchanged.

## 6. Target resolution

Reuse the same registered main/derived-worktree validation primitives already used by broker reads/writes.

For an explicit request id, resolve the target from the request's stored `workspaceId` and optional `worktreeId`; do not silently substitute the caller's cwd workspace.

For implicit selection, retain the current cwd-based selection rule, then still verify that the selected stored target resolves to the intended concrete workspace/worktree before preparation.

If a small extraction from `src/workspaces/targets.ts` is needed so the CLI can reuse the existing target checks without constructing a second resolver, prefer that extraction over duplicated worktree logic.

Use the same protected-root set as broker patch preparation. Factor the current protected-root construction into one shared helper if necessary; do not let CLI review prepare a patch under weaker path policy than approval.

## 7. Temporary snapshot

Materialize only prepared changed paths into a fresh OS temporary directory:

```text
$TMPDIR/c2c-difftool-<random>/
├── before/
└── after/
```

Rules:

- root and created directories: owner-only `0700`,
- materialized files: owner-only `0600`,
- update: exact `beforeBytes` under `before/<path>` and exact `resultBytes` under `after/<path>`,
- create: no file on the before side and exact `resultBytes` on the after side,
- never use the live workspace file itself as either viewer input,
- never persist snapshot paths or bytes into the request record,
- never preserve or synthesize file modes as review semantics; SPEC-002 V1 is content-only,
- materialization must contain every prepared path within its snapshot root even if future parser rules change,
- cleanup the whole temporary directory in `finally` after the Git process exits or fails to start.

The existing SPEC-002 file/count limits bound snapshot size. Do not add a second review-specific size model in V1.

A hard process crash or `SIGKILL` may leave an owner-only temporary directory behind. Treat that as a documented V1 limitation; do not add a cleanup daemon, durable journal, retention database, or startup scavenger without evidence that orphaned review snapshots are a real problem.

## 8. Git difftool invocation

V1 invokes Git directly with argv, never through a C2C-created shell string:

```text
git difftool --gui --no-index --no-prompt -- <before-dir> <after-dir>
```

Process requirements:

- asynchronous `spawn`, not the existing synchronous `runGit()`,
- `shell: false`,
- cwd = the resolved workspace/worktree root so normal local Git difftool configuration is available,
- reuse the repository Git environment sanitization boundary rather than inheriting repository override variables,
- inherit terminal stdio so Git/viewer diagnostics remain visible,
- wait for the Git process before deleting snapshot files.

Do not use `--dir-diff`: Git does not support combining directory-diff mode with `--no-index`.

Do not add:

- `c2c.diffViewer`,
- viewer auto-detection,
- VS Code/Meld/Beyond Compare-specific branches,
- a C2C viewer registry,
- `--tool` selection in V1,
- `--trust-exit-code`,
- a temporary Git repository solely to enable `--dir-diff`.

Git's existing `--gui` difftool selection is the integration boundary. Git resolves `diff.guitool` with its documented fallback configuration; C2C adds no viewer setting or tool-specific selection.

## 9. Multi-file and create behavior

`--no-index` directory comparison may invoke the configured difftool separately for changed files instead of one whole-tree viewer session. Accept that as a V1 limitation.

Do not create a temporary Git repository/index just to obtain one-window `--dir-diff`. Besides added lifecycle complexity, Git indexing/plumbing introduces additional semantics such as attributes/filters that are unnecessary for reviewing the exact already-prepared bytes.

Create operations rely on Git's normal missing-side/new-file semantics. Add an acceptance probe proving that a create request reaches the configured test difftool with the intended result content. Do not add a synthetic-empty-file compatibility layer unless an actual supported-tool failure demonstrates the need.

A configured graphical tool must remain attached to the Git difftool process long enough to consume its input files. For tools that normally detach, the user's Git difftool command must use that tool's normal wait/block option. C2C does not guess process trees, sleep after Git exits, or retain temp snapshots on a timer to compensate for a misconfigured detached viewer.

A richer single-window directory viewer can be proposed later if real multi-file review friction justifies the extra mechanism.

## 10. Exit and failure semantics

Launching a diff is expected to find differences. In `--no-index` mode, diff-style exit status `1` must not be reported as a C2C failure merely because the two snapshots differ.

Treat the normal Git no-index diff outcomes as successful review completion. A spawn failure or Git invocation error outside normal diff-result status is a local difftool failure and must:

- set a non-zero C2C command result,
- retain the pending request unchanged,
- print a concise actionable error plus Git stderr when safe,
- still clean up the temporary snapshot.

Do not convert a difftool launch failure into patch rejection, stale state, failed write receipt, or approval failure.

## 11. Concurrency and lifecycle

Review is informational and must not hold the broker write-lifecycle mutex or any workspace lock for the duration of a human GUI session.

The snapshot is truthful for the successful revalidation instant. External workspace edits or another local approval may occur while the viewer is open.

That race does not require a review lock because `c2c approve` remains authoritative and re-runs target/precondition validation immediately before mutation. A successful review is never proof that later approval will succeed.

If the request becomes applied, rejected, stale, or expired while its already-materialized viewer is open, closing the viewer performs no lifecycle action.

## 12. Source layout

Prefer a small focused CLI helper rather than growing patch-domain or broker adapters around viewer behavior, for example:

```text
src/cli/write-requests.ts
src/cli/patch-difftool.ts
```

Exact filenames are not normative.

Patch-domain changes should be limited to small reusable preparation-equivalence/protected-root helpers needed to ensure review and approval share the same rules.

No new:

- request record fields,
- request status,
- store,
- admin persistence route,
- MCP tool,
- OAuth scope,
- broker background task,
- Manager screen,
- generic external-process framework

is required.

Do not send `beforeBytes` / `resultBytes` through a new JSON/base64 broker endpoint merely to feed the local viewer. The CLI and workspace are local; reuse local preparation and target validation instead.

## 13. Security boundary

`--difftool` is an explicit local-user action.

C2C controls:

- which pending patch is selected,
- target resolution,
- patch revalidation,
- exact snapshot bytes,
- snapshot permissions and lifetime,
- shell-free Git argv invocation.

The configured Git difftool itself is trusted local Git configuration and may execute arbitrary local software with the user's privileges. CHANGE-010 does not sandbox, validate, or attest that viewer.

Do not describe opening a configured difftool as safe execution of untrusted binaries. The security property is narrower: remote MCP input cannot choose an arbitrary viewer command through this feature, and no viewer starts until the local user explicitly invokes `c2c pending --difftool`.

The external viewer receives temporary copies of the reviewed source/result content. Canonical security documentation must state that local difftool configuration can therefore read that content.

## 14. Tests and validation

Focused automated coverage:

1. single update materializes byte-identical before/after files,
2. create materializes only the after-side file and reaches the configured test difftool correctly,
3. CRLF and no-final-newline bytes remain exact,
4. multi-file nested paths materialize under the correct relative tree,
5. path containment prevents temp-tree escape,
6. temp directories/files use owner-only permissions on Linux/WSL,
7. successful Git exit cleans the snapshot,
8. Git spawn/invocation failure cleans the snapshot and leaves the request pending,
9. stale preparation prevents Git spawn,
10. workspace/worktree disappearance prevents Git spawn,
11. explicit id resolves its stored target rather than substituting cwd,
12. implicit selection preserves existing zero/one/many semantics,
13. `--diff`, `--difftool`, and `--json` conflict as specified,
14. Git argv is exact, `shell:false`, cwd is the concrete target, and repository override variables remain sanitized,
15. normal no-index differences are not surfaced as command failure,
16. closing review does not approve/reject/apply or rewrite the request,
17. approval after review still performs the existing independent revalidation,
18. existing `pending --diff`, approve, reject, stale, rollback, and Manager tests remain regression-clean.

Add one disposable live Git compatibility probe on the supported Git 2.34.1 floor/current environment. Configure a local test difftool command in the fixture repository that records the supplied paths/content; do not require an actual desktop GUI in automated tests and do not mutate global Git config.

Run focused CLI/write-request suites, then `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

## 15. Documentation

At implementation closeout, minimally align:

- SPEC-002 §19.7 inspection-before-approval wording,
- SPEC-002 CLI/acceptance inventory where `c2c pending --diff` is enumerated,
- `docs/security.md` for owner-only temporary copies and trusted local difftool execution,
- `docs/local-e2e.md` with the non-GUI difftool compatibility probe.

No protocol, MCP, OAuth, multi-workspace model, or patch-format documentation change is required unless implementation reveals a real contract delta.

## 16. Non-goals

CHANGE-010 does not add:

- a built-in C2C diff viewer,
- one-window directory diff guarantees,
- browser review,
- Manager difftool launch,
- automatic approval after viewer close,
- review/approval coupling,
- viewer-specific configuration,
- remembered viewer choice,
- remote viewer selection,
- patch editing inside the viewer,
- merge/conflict resolution,
- delete/rename/binary patch support,
- a temporary Git repository,
- snapshot persistence/history,
- orphan-temp recovery infrastructure,
- changes to the one-hour pending request TTL.

## 17. Acceptance criteria

| ID | Required behavior |
| --- | --- |
| A1 | `c2c pending [wr_...] --difftool` opens a Git-configured local difftool for one selected pending patch without modifying project files. |
| A2 | Review reuses canonical target resolution, `preparePatch()`, protected roots, and the same preparation-equivalence contract as approval; no second patch reconstruction exists. |
| A3 | A stale/unavailable target fails closed before Git/viewer spawn and review itself does not persist a stale transition. |
| A4 | Viewer inputs are owner-only temporary copies of exact prepared before/result bytes; live workspace files are never passed as the compared inputs. |
| A5 | Temporary snapshot cleanup occurs after normal completion and handled failures; crash-orphan recovery remains explicitly out of scope. |
| A6 | Git is spawned asynchronously with `shell:false` as `git difftool --gui --no-index --no-prompt -- before after`; `--dir-diff` and C2C viewer-specific routing are absent. |
| A7 | Existing Git difftool configuration chooses the viewer; detached-tool waiting is configuration-owned and C2C adds no sleep/retention heuristic. |
| A8 | Multi-file patches may be reviewed per-file in V1; update and create patches both work, with no temporary Git repository. |
| A9 | Normal no-index diff-result status is not treated as a review failure; actual spawn/Git invocation failures leave the request pending and clean temp state. |
| A10 | `--difftool` preserves existing explicit-id and cwd-scoped ambiguity rules and conflicts with `--diff` / `--json`. |
| A11 | Review holds no broker lifecycle lock while the viewer is open; later approval independently revalidates before any mutation. |
| A12 | SPEC-002 patch lifecycle, one-hour pending TTL, approval/rollback behavior, Manager review, and unrelated command-request semantics remain regression-clean. |

## 18. Suggested implementation slices

**S1 — Shared revalidation + snapshot helper:** factor preparation-equivalence/protected-root reuse, secure temp materialization, cleanup, focused byte/security tests.

**S2 — CLI + Git process:** `--difftool` selection/conflicts, stored-target resolution, async Git invocation, exit/error handling, fixture difftool tests and Git 2.34.1 compatibility probe.

**S3 — Docs + final gate:** minimal SPEC-002/security/local-E2E alignment, full regressions/typecheck/build/diff check.

Do not split into separate broker, persistence, or viewer-framework slices; those are not required by the outcome.

## 19. Review questions before work authorization

Challenge with repository or compatibility evidence:

1. Can the CLI reuse canonical registered-target and protected-root logic without introducing a materially larger abstraction than the feature warrants?
2. Does the supported Git 2.34.1 probe confirm update/create/multi-file `--no-index --no-prompt` behavior and expected exit handling?
3. Does any actual supported difftool require synthetic create-side files or delayed temp cleanup? If not, do not add those mechanisms.
4. Is per-file multi-file review materially inadequate in real use? If not, keep one-window directory diff deferred.

The burden of proof is on adding a temp Git repository, new config surface, background cleanup, broker transport, or viewer-specific adapter.

## 20. Draft status

This is planning-only. No implementation branch, installation change, push, deployment, or merge is authorized.

Implementation begins only after CHANGE-010 passes review and normal C2C work-start authorization is given.
