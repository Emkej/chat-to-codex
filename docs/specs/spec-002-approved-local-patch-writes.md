# SPEC-002 — Approved local patch writes

**Status:** V1 conformant for Linux/WSL<br>
**Date:** 2026-09-24<br>
**Target branch:** `codex/spec-002-approved-local-patch-writes`<br>
**Review baseline:** `chat-to-codex` HEAD `0437169` (`feat/worktree-support`), working tree currently dirty<br>
**Scope:** Safe text patch writes, host-confirmation compatibility PoC, local approval fallback, write-request receipts, post-apply verification, minimum CLI/admin/MCP integration<br>
**Related canonical docs:** `docs/architecture.md`, `docs/security.md`, `docs/protocol.md`, `docs/local-e2e.md`, `docs/multi-workspace.md`, `skill/SKILL.md`

## 1. Summary

C2C is currently read-only through MCP.

**V1 platform support:** SPEC-002 write-request behavior is supported only on
Linux/WSL. The broker write owner uses Linux `flock`; every non-Linux platform
fails closed with `WRITE_OWNER_UNAVAILABLE`. Windows support is deferred to
separately implemented and validated future work. macOS is out of scope unless
it is separately proposed later. V1 conformance requires Linux/WSL evidence
only; Windows/macOS validation is not a completion condition.

That boundary is intentional and valuable, but it creates avoidable friction for small, reviewable edits such as:

- updating a SPEC,
- updating a CHANGE document,
- correcting a README,
- making a focused source-file patch that ChatGPT can already reason about and review.

Today the normal path is:

```text
ChatGPT reasons/reviews
        ↓
Codex executes locally
        ↓
ChatGPT re-reads/reviews
```

For many small text edits, invoking the full Codex execution loop is unnecessary overhead.

SPEC-002 adds one narrowly scoped mutation capability:

```text
apply an exact unified text patch
```

It does **not** add a shell, arbitrary file writes, Git mutation, delete, rename, binary writes, package management, or generic remote execution.

The preferred low-friction path is native host confirmation when the connected MCP host supports it:

```text
ChatGPT
   ↓
apply_patch(...)
   ↓
host confirmation
   ↓
C2C validates + applies
   ↓
ChatGPT re-reads + verifies
```

Because current OpenAI plan support is not sufficiently reliable to assume this path for the user's ChatGPT Plus account, implementation starts with a disposable compatibility PoC.

If native destructive writes are not available but ChatGPT can still invoke a non-destructive state-changing MCP tool, C2C uses the preferred fallback:

```text
ChatGPT
   ↓ MCP
propose_patch(...)
   ↓
C2C stores one pending local write request
   ↓
user runs:
c2c approve
   ↓
C2C validates + applies
   ↓
ChatGPT re-reads + verifies
```

This is the normal fallback target because it keeps MCP as the transport and reduces user interaction to one explicit local approval command.

Manual compatibility import availability follows the authoritative §17.4 capability matrix: it ships whenever Probe B is `BLOCKED`, regardless of Probe A. That path is compatibility-only, not the desired everyday UX.

All mutation paths share the same patch parser, target resolution, sensitive-path policy, stale-content preconditions, application logic, receipt model and verification semantics.

The installation broker is the sole write-request state writer in V1. CLI/TUI use the broker's local admin API; the legacy per-project bridge remains read-only.

---

## 2. Current external compatibility constraint

As of 2026-09-23, OpenAI's public documentation is not a sufficient basis for assuming that a ChatGPT Plus account can invoke full MCP write actions.

The current Help Center states that full MCP support, including modify/write actions, is available in beta for Business, Enterprise and Edu, and that Pro remains limited to read/fetch permissions in developer mode:

- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

OpenAI's current developer documentation also defines write/destructive tool annotations and host confirmation behavior:

- <https://developers.openai.com/plugins/build/mcp-server>
- <https://developers.openai.com/plugins/reference>

Therefore:

1. SPEC-002 MUST NOT assume native write support merely because C2C can advertise a write tool.
2. SPEC-002 MUST perform a real compatibility PoC against the user's current ChatGPT Plus environment before shipping the native `apply_patch` MCP tool.
3. C2C MUST NOT mislabel a state-changing tool as read-only to bypass host restrictions.
4. A fallback MUST exist that requires only the already-working MCP connector plus local CLI access.

The compatibility result is an implementation gate, not a permanent provider-specific architecture decision.

---

## 3. Terminology

### 3.1 Patch

A standard unified text diff describing one or more file creates/updates relative to a concrete C2C workspace target.

### 3.2 Concrete target

The exact local root that receives the patch:

```text
registered workspace
        +
optional validated derived worktree
```

The existing SPEC-001 target-resolution rules remain authoritative.

### 3.3 Prepared patch

A parsed patch for which C2C has already:

- resolved every path,
- validated every operation,
- loaded current file contents,
- applied every hunk exactly in memory,
- computed stale-content preconditions,
- computed intended result metadata.

A prepared patch has not yet mutated the workspace.

### 3.4 Write request

A local C2C record representing a manual-local patch awaiting approval or a terminal write receipt.

### 3.5 Host-confirmed write

A patch invocation for which the MCP host has already gated the write tool invocation according to its native permission/confirmation UX before C2C executes the handler.

C2C MUST NOT claim cryptographic proof that the host displayed a confirmation. This mode is enabled only if the compatibility PoC demonstrates acceptable real behavior in the intended host.

### 3.6 Manual-local write

A patch whose approval occurs locally through C2C CLI/admin tooling rather than through the remote MCP host.

### 3.7 Post-apply verification

The mandatory workflow step where ChatGPT independently reads the resulting workspace state after a successful write instead of treating the mutation receipt as proof of correctness.

### 3.8 Terminal request

A write request whose status is one of:

```text
applied
rejected
stale
expired
failed
```

`pending` is the only non-terminal persisted request status.

---

## 4. Goals

1. Let C2C apply a narrowly scoped unified text patch to a selected workspace/worktree.
2. Preserve the existing registered-workspace and derived-worktree security boundaries.
3. Prefer native host confirmation when it is genuinely available and usable.
4. Provide a reliable fallback when the host cannot perform direct writes.
5. Keep the normal fallback flow low friction: MCP creates one pending request and the user runs one explicit `c2c approve` command.
6. Support update and create operations only in V1.
7. Reject delete, rename, move, binary and metadata-only changes.
8. Detect stale files before mutation and fail closed.
9. Validate all files before the first workspace mutation.
10. Avoid partial application for ordinary validation and handled I/O failures.
11. Reuse the existing sensitive-file policy and add write-specific protected paths.
12. Keep patch/write business logic outside MCP, broker HTTP and CLI adapters.
13. Keep the feature modular enough for a future TUI without building a TUI abstraction now.
14. Persist small local receipts so ChatGPT/TUI/CLI can inspect recent write outcomes.
15. Require ChatGPT to independently verify the resulting files after a successful write.
16. Preserve unrelated dirty workspace state during normal handled execution.
17. Avoid requiring a clean Git working tree.
18. Keep future per-project auto-accept possible without implementing it in V1.
19. Keep the legacy per-project bridge read-only.
20. Keep the implementation KISS: no DB, queue, watcher, shell execution framework, transaction framework or dependency-injection layer.
21. Serialize final write revalidation/commit in the installation broker so concurrent write paths cannot overwrite results prepared from stale content.

---

## 5. Non-goals

SPEC-002 does not add:

- arbitrary `write_file`,
- arbitrary append,
- arbitrary delete,
- rename or move,
- directory creation,
- directory deletion,
- symlink creation,
- symlink mutation,
- binary patching,
- file-mode/chmod patches,
- Git commit,
- Git checkout/reset/merge/rebase,
- shell execution,
- test execution,
- package-manager execution,
- arbitrary command execution,
- automatic conflict merging,
- fuzzy patch application,
- three-way merge,
- clean-worktree requirements,
- automatic staging,
- automatic commits,
- automatic rollback across process/OS crashes,
- a durable crash-recovery journal,
- a database,
- SQLite,
- a background queue,
- a background approval watcher,
- a filesystem watcher,
- a TUI,
- per-project auto-accept,
- pending-request deduplication,
- directory/glob allowlists for auto-accept,
- native mobile/desktop notifications,
- legacy per-project bridge writes,
- pretending a write tool is read-only to work around host restrictions.

---

## 6. Explicit V1 decisions

The following decisions are already accepted for V1.

### D1 — Operations

Allowed:

- update an existing text file,
- create a new text file.

Denied:

- delete,
- rename/move,
- binary mutation,
- metadata-only mutation.

### D2 — Stale behavior

Fail closed.

An existing file is bound to the SHA-256 hash of its exact raw bytes observed during preparation.

A create operation is bound to:

```text
expected = absent
```

If any precondition changes before approval/apply, the whole request becomes stale and nothing is intentionally applied.

### D3 — Multi-file semantics

All files are validated and prepared before the first workspace mutation.

A validation or stale-content failure on one file prevents all files from being mutated.

Handled commit-time I/O failures trigger rollback of already-replaced files where possible.

This is application-level all-or-nothing behavior, not a claim of crash-safe filesystem transactions across multiple files.

### D4 — Dirty workspace

Dirty workspaces are allowed.

SPEC-002 does not use global `git status` cleanliness as a precondition.

Only the files touched by the patch are protected by exact content preconditions.

### D5 — Content type

Text only.

V1 does not support binary patches.

### D6 — Pending TTL

Manual-local pending requests expire after:

```text
60 minutes
```

### D7 — Terminal history

Terminal receipts are retained for:

```text
7 days
```

Cleanup is lazy during normal store operations. No scheduler is introduced.

### D8 — MCP input

The MCP patch inputs remain minimal:

```text
workspace?
worktree?
patch
```

`workspace` keeps the existing MCP convention: it may be omitted only when the existing broker target resolver can resolve one unambiguous registered workspace. Filesystem paths are never accepted as remote selectors.

The remote client does not provide file hashes, file lists, approval mode, expiry, atomicity flags or derived metadata.

### D9 — Domain organization

New business logic lives under:

```text
src/write-requests/
```

with a small number of focused files.

### D10 — Verification

A successful write is not the end of the workflow.

ChatGPT MUST independently inspect the resulting files/diff before considering the edit verified.

### D11 — Approval UX hierarchy

Preferred order:

```text
1. native host-confirmed apply_patch
2. MCP propose_patch + local c2c approve
3. manual compatibility handoff
```

The second path is the normal fallback target for V1.

### D12 — One explicit approval action

`c2c approve` is itself the user's explicit approval action.

When it selects an unambiguous relevant pending request, V1 MUST NOT immediately ask for a second `[y/N]` confirmation.

If the user wants to inspect first, use `c2c pending` / `c2c pending --diff`.

### D13 — Concurrency model

The installation broker is the sole V1 writer of write-request state and workspace patch commits.

A single process-local write-lifecycle mutex serializes:

- pending → terminal transitions,
- final security/precondition revalidation,
- staging + commit + handled rollback,
- host-confirmed commits.

This deliberately favors correctness and KISS over parallel patch commits. Patch preparation may happen before the mutex, but **final revalidation and commit MUST happen while holding it**.

---

## 7. Architecture

### 7.1 High-level model

```text
                         ┌──────────────────────┐
                         │   MCP host/client    │
                         │ ChatGPT / compatible │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ installation broker  │
                         │ MCP + /admin adapters│
                         └──────┬────────┬──────┘
                                │        ▲
                                │        │ loopback admin
                                ▼        │
                         ┌──────────────────────┐       ┌──────────────┐
                         │ WriteRequestService  │◀──────│ c2c CLI/TUI  │
                         └──────────┬───────────┘       └──────────────┘
                                    │
                            ┌───────┴────────┐
                            ▼                ▼
                     Patch domain       Write store
                            │
                            ▼
                  concrete Workspace target

legacy per-project bridge: read-only; no write/admin-write routes
```

The important ownership rule is:

```text
MCP / broker HTTP / CLI = adapters
write-requests/          = write business logic
workspace/               = existing target/path security
installation broker      = sole write lifecycle/store writer
```

### 7.2 No new architectural framework

Do not introduce:

```text
domain/
application/
infrastructure/
ports/
adapters/
repositories/
use-cases/
commands/
```

Do not add an IoC container or dependency-injection framework.

The project already organizes code by functional domain. SPEC-002 follows that style.

### 7.3 Sole-writer rule

V1 MUST NOT let CLI commands import `write-requests/store.ts` or mutate request files directly.

CLI/TUI write-request commands use the installation broker's loopback `/admin/*` API. MCP write/proposal handlers are hosted by that same broker.

Before a broker may expose **any** write-request mutation surface, it MUST acquire exclusive process-lifetime ownership for the active canonical installation/state boundary. That ownership is keyed by the resolved state directory, not by TCP port, runtime-pointer contents or connector URL.

Requirements:

- two broker processes using the same resolved state directory MUST NOT both become write owners,
- preferred-port fallback MUST NOT bypass this rule,
- an unrelated process occupying the preferred port MUST NOT allow a second C2C broker to become a competing writer,
- ownership MUST use an OS/process-lifetime exclusive lock semantics that releases on process exit; a plain persistent sentinel file is insufficient by itself,
- failure to acquire ownership fails broker write-capability startup closed before write/admin-write routes become usable.

On Linux/WSL the broker acquires this owner before constructing the write
service or mounting write-request surfaces. Outside V1's supported platform,
the write service, MCP write tools, and write-request admin router stay absent;
the broker may still serve its existing read-only MCP surface. This read-only
fallback does not imply write-request support on that platform.

Only after that ownership is held is the broker-local write-lifecycle mutex authoritative for serializing C2C writes.

This is one installation-level ownership primitive plus one in-process write-lifecycle mutex; do not add per-request/per-file distributed locking in V1.

The legacy per-project bridge at `src/bridge/server.ts` MUST NOT expose write-request admin routes or mutation tools.

---

## 8. Domain module layout

Initial layout:

```text
src/
├── write-requests/
│   ├── types.ts
│   ├── patch.ts
│   ├── apply.ts
│   ├── store.ts
│   └── service.ts
│
├── mcp/
│   └── server.ts
│
├── broker/
│   └── server.ts
│
└── cli/
    └── index.ts
```

### 8.1 `types.ts`

Owns:

- statuses,
- operation metadata,
- precondition metadata,
- receipt metadata,
- manual-local write-request shape,
- sanitized DTOs used across adapters,
- the shared terminal-status predicate such as `isTerminal()`.

It MUST NOT import Express, Commander or MCP SDK types.

### 8.2 `patch.ts`

Owns pure/in-memory patch behavior:

- unified diff parsing,
- patch normalization,
- operation validation,
- exact in-memory hunk application,
- text validation,
- stats,
- precondition generation,
- intended result hashes.

It MUST NOT own:

- filesystem staging/commit/rollback,
- MCP authorization,
- HTTP routes,
- CLI prompts,
- write-request history.

### 8.2.1 `apply.ts`

Owns the narrow filesystem side effects used by the service:

- same-parent temporary-file staging,
- existing-mode preservation,
- rollback snapshots,
- commit replacement/create,
- handled rollback,
- best-effort cleanup of known temporary artifacts.

It MUST NOT parse patches or decide approval/security policy.

### 8.3 `store.ts`

Owns file-backed persistence under the canonical C2C state directory returned by the existing state-path helpers.

The write-request directory is:

```text
stateSubdir("write-requests")
```

not a new hard-coded home path. This preserves `C2C_STATE_DIR`, profiles and existing state migration behavior.

It provides only small primitives such as:

```text
create
get
list
update
removeExpired
```

Persisted record replacement MUST use a secure same-directory temp file plus atomic rename/replace so readers never observe a partially written JSON record. Files remain owner-only (`0600`) under existing secure-state conventions.

It MUST NOT decide whether a patch is safe or approved.

### 8.4 `service.ts`

Owns the write lifecycle.

Conceptual API:

```ts
preparePatch(...)
createManualRequest(...)
approveManualRequest(...)
rejectManualRequest(...)
applyHostConfirmedPatch(...)
listRequests(...)
getRequest(...)
```

Names may change during implementation if a smaller API expresses the same responsibilities.

The service is the single place that coordinates:

- target resolution input,
- patch preparation,
- write-lifecycle mutex ownership,
- approval-time security/stale revalidation,
- apply,
- status transitions,
- receipts,
- history cleanup.

### 8.5 Adapter rule

`src/mcp/server.ts`, `src/broker/server.ts` and `src/cli/index.ts` MUST remain thin adapters.

Patch parsing or filesystem mutation MUST NOT be implemented independently in those files.

---

## 9. Target resolution

SPEC-001 remains authoritative for workspace/worktree selection.

Remote selectors remain:

```text
workspace?: durable opaque workspace id when needed by the existing resolver
worktree?: optional opaque derived-worktree id
```

The native write/proposal tools use the exact same broker target resolver as existing read tools.

Rules:

1. Unknown workspace fails closed.
2. Unknown/stale/moved worktree fails closed.
3. Worktree selection failure never falls back to the main root.
4. A linked-worktree registration remains exact-root-only.
5. A derived worktree remains authorized only through its registered main owner.
6. Filesystem paths are never accepted as remote target selectors.
7. Local CLI implicit selection uses the containing-target cwd rule from §19.6; remote MCP target resolution remains unchanged.
8. The resolved concrete `Workspace` object remains the path-confinement authority.

---

## 10. Write path policy

Read safety is necessary but not sufficient for writes.

### 10.1 Reuse existing confinement

Every patch path MUST pass through the existing workspace canonicalization model.

The implementation MUST preserve:

- workspace containment,
- deepest-existing-ancestor canonicalization for not-yet-existing leaves,
- traversal rejection,
- cross-root rejection,
- sensitive-file filtering.

### 10.2 Sensitive paths

The existing workspace sensitive-file policy is the SSOT for sensitive paths. Write preparation and approval-time revalidation MUST call the same `Workspace`/`IgnoreRules.isSensitive` policy rather than maintain a second write-specific copy.

Examples such as `.env`, private keys, `.ssh/`, `.aws/`, `.gnupg/`, `.npmrc` and service-account secrets are non-normative illustrations only.

A write capability MUST NOT be able to create or overwrite a file that the remote client is forbidden to read.

### 10.3 Write-control paths

V1 additionally protects C2C/Git control paths even when they are not currently part of the read-sensitive list.

At minimum, remote/native patch writes MUST reject workspace-relative control names:

```text
.git
.git/**
.c2c
.c2c/**
.c2c.json
.c2cignore
```

These control-name comparisons are ASCII case-insensitive on every host, so variants such as `.C2C.JSON` or `.Git/` are denied consistently across Windows/WSL/Linux boundaries.

Name-based protection is not the only boundary. The broker MUST also provide the write domain with the active canonical C2C installation/state roots, and every prepared/finally-revalidated target MUST be denied when its canonical path is equal to or below any such root.

This resolved-path deny applies regardless of the workspace-relative name and therefore covers:

- the normal `~/.c2c` installation/state layout,
- `C2C_HOME`, `C2C_STATE_DIR` and profile-resolved locations,
- test/explicit broker state-directory overrides,
- a workspace registration that is itself the C2C state root or contains a relocated state root.

The active broker-resolved roots are the SSOT; write code MUST NOT guess them from a `.c2c` pathname alone.

Rationale:

- `.git` mutation would turn patch writing into Git/repository-control mutation,
- `.c2cignore` can change what the remote client is allowed to read,
- `.c2c.json` is a C2C control/configuration surface and may later contain write approval policy,
- `.c2c/**` blocks the normal in-workspace naming case,
- canonical installation/state-root denial protects the same control material when it is relocated or registered directly.

The model MUST NOT be able to weaken its own write/read controls or mutate C2C installation/state material through the same write capability.

### 10.4 Symlinks

V1 MUST reject writes whose requested target or existing path resolution relies on a symlink.

Do not silently follow a symlink and mutate its resolved target.

### 10.5 Regular files only

Update targets MUST be regular files.

Create targets MUST:

- not already exist,
- have an existing real parent directory inside the concrete workspace,
- not require directory creation.

---

## 11. Patch format

### 11.1 Standard unified diff

The patch payload uses standard unified diff text.

Existing-file update:

```diff
--- a/docs/example.md
+++ b/docs/example.md
@@ -1,3 +1,3 @@
 before
-old
+new
 after
```

New file:

```diff
--- /dev/null
+++ b/docs/new-file.md
@@ -0,0 +1,2 @@
+line one
+line two
```

Create semantics are explicit:

- create is allowed only when the old path is exactly `/dev/null`,
- the new path must be a normal workspace-relative path after prefix normalization,
- `/dev/null` is rejected in every other position,
- updates require both old and new paths to resolve to the same logical path.

### 11.2 Allowed path forms

V1 accepts normal Git-style prefixes:

```text
a/path
b/path
```

Prefix stripping is deterministic:

- for updates, strip exactly one leading `a/` from the old path and one leading `b/` from the new path **only when both are present as the paired Git-style form and their remainders are equal**;
- for creates, `--- /dev/null` plus `+++ b/path` treats the leading `b/` as the Git-style prefix;
- otherwise paths are treated literally before normal workspace validation.

Therefore a real workspace file `a/foo` can be represented by paired `a/a/foo` / `b/a/foo`, while mismatched or one-sided prefixes are not silently rewritten.

### 11.3 Rejected patch constructs

Reject:

- deletion (`+++ /dev/null`),
- `/dev/null` outside the create form defined in §11.1,
- update old/new paths that resolve to different logical paths,
- two or more file sections/operations targeting the same normalized logical path within one patch,
- rename headers,
- copy headers,
- binary patch sections,
- mode changes,
- submodule/gitlink changes,
- absolute paths,
- traversal,
- paths outside the selected target,
- empty file-operation sets.

Duplicate-target detection MUST happen after path normalization and **before any hunk is applied or any precondition/result metadata is computed**. A duplicate target fails the whole preparation with `PATCH_INVALID`.

### 11.4 Exact application

Patch hunks MUST apply exactly to the observed source content.

V1 uses:

```text
fuzz = 0
```

conceptually.

No offset guessing, conflict markers, three-way merge or fuzzy matching.

If exact application fails, preparation fails before any mutation.

### 11.5 Parser implementation

Prefer one small, mature unified-diff library over a broad handwritten parser if it can satisfy:

- multi-file parsing,
- exact hunk application,
- create/update support,
- no implicit fuzzy matching,
- support for the standard `\ No newline at end of file` marker,
- no shell/Git execution.

Do not pin a library in the spec before implementation proves it satisfies these constraints. Do not add a general patch framework.

If the chosen library cannot enforce the V1 restrictions cleanly, implement only the narrow missing validation around it rather than re-implementing a complete diff engine.

### 11.6 Text encoding and line endings

V1 supports UTF-8 text only.

Hard invariants for updates:

- invalid UTF-8 is rejected,
- an existing UTF-8 BOM, if present, is preserved,
- untouched source lines/bytes remain byte-identical,
- a uniformly CRLF target remains CRLF for changed/added lines,
- a uniformly LF target remains LF for changed/added lines,
- patch transport line endings (`LF` or `CRLF`) do not cause target-file normalization,
- the standard `\ No newline at end of file` marker is honored,
- final-newline behavior follows the patch without normalizing unrelated content.

The parser may normalize **patch-document separators only** to LF internally. It MUST NOT normalize the target file as a whole in order to make a hunk match.

Mixed-line-ending targets are accepted only when the implementation can produce the exact intended edit while preserving untouched raw bytes. If the selected library can apply only by whole-file newline normalization, fail closed with `PATCH_DOES_NOT_APPLY`.

For new files:

- default encoding is UTF-8 without BOM,
- default line ending is LF,
- the no-final-newline marker is honored when present.

This matters because C2C commonly operates across Windows/WSL worktrees.

---

## 12. Input limits

V1 applies explicit conservative limits.

Initial constants:

```text
max patch payload:        1 MiB UTF-8 bytes
max files per patch:      50
max source file size:     1 MiB raw bytes per file
max resulting file size:  1 MiB raw bytes per file
```

Limits are bytes, not JavaScript character counts.

The source cap is intentionally the same as the result cap. A tiny patch MUST NOT cause C2C to allocate/read an arbitrarily large source file before rejecting it.

Source loading MUST therefore be bounded: read at most the configured source cap plus one byte (or use an equivalent bounded/streaming primitive) and return `WRITE_FILE_TOO_LARGE` when the cap is exceeded. Approval-time hashing/revalidation MUST also remain bounded and MUST NOT read an unbounded file into memory merely to discover that it became oversized.

The 50-file and per-file limits bound prepared result/rollback memory; V1 does not add a second aggregate-result-size policy.

All MCP/admin HTTP body limits that can carry `patch` MUST be configured above the patch cap plus normal JSON/MCP envelope overhead. Transport-level oversize MUST map to `PATCH_TOO_LARGE` / HTTP 413 rather than leak a framework-specific body-limit error.

The implementation MAY centralize these values as constants.

They MUST NOT be user-configurable in V1.

Oversized input fails before patch persistence or workspace mutation.

---

## 13. Preparation and stale preconditions

### 13.1 Update operation

During preparation:

1. resolve path,
2. reject protected/sensitive/symlink/non-file targets,
3. verify required target/parent access for the intended staged replacement,
4. perform the bounded source read from §12 and reject oversized sources with `WRITE_FILE_TOO_LARGE`,
5. retain the exact raw bytes and require valid supported text,
6. compute:

```text
baseSha256 = sha256(raw bytes)
```

7. apply the patch exactly in memory,
8. compute:

```text
resultSha256 = sha256(result raw bytes)
```

9. retain enough original raw bytes + mode metadata for handled rollback during the current operation lifecycle.

The remote client does not supply `baseSha256`.

### 13.2 Create operation

During preparation:

1. resolve deepest existing parent,
2. verify containment,
3. verify protected/sensitive policy,
4. require target absence,
5. require parent directory already exists and is writable enough for same-parent staging/create,
6. build resulting text,
7. compute result hash.

Precondition:

```text
expected = absent
```

If the create target already exists at preparation time, return `WRITE_TARGET_EXISTS` rather than treating it as approval-time staleness.

### 13.3 Approval-time revalidation

Immediately before manual commit, while holding the write-lifecycle mutex:

1. re-resolve the registered workspace/worktree target,
2. re-run full path containment/canonicalization,
3. re-run the canonical sensitive policy,
4. re-run write-control-path checks,
5. re-check symlink denial,
6. re-check update regular-file/create parent rules and required writability,
7. then re-check stored content preconditions:
   - every update target must still be within the source-size cap and hash to its stored `baseSha256` using bounded/streamed revalidation,
   - every create target must still be absent.

Any approval-time target-resolution, path-security, file-type or content/absence revalidation failure means the prepared request is no longer valid for its original target. The request transitions to terminal `stale`, records the specific underlying domain code (for example `WRITE_SYMLINK_DENIED`, `WRITE_TARGET_NOT_FILE`, `WORKSPACE_UNAVAILABLE`, `WORKTREE_UNAVAILABLE` or `WRITE_STALE`), clears the raw patch, persists the receipt, and begins zero intentional writes.

A pure transient staging/commit I/O failure after all revalidation has passed is not `stale`; it follows the handled `failed`/rollback path in §14.

### 13.4 Native host-confirmed path

The direct host-confirmed path has no human-delay pending phase, but it still:

1. prepares all operations,
2. enters the same write-lifecycle mutex,
3. performs the same full approval-time security + precondition revalidation,
4. commits only if every check still passes.

This serialization prevents a host-confirmed apply and a manual approval from both committing results prepared from the same stale base.

---

## 14. Multi-file application semantics

### 14.1 Preflight

Before the first visible mutation:

- every patch operation is parsed,
- every target is resolved,
- every permission/path rule passes,
- every source hunk applies exactly,
- every result is built,
- every precondition is known,
- every parent directory is writable enough for the intended operation,
- duplicate normalized targets have been rejected.

A failure here changes no workspace file.

### 14.2 Staging

After final revalidation and while holding the write-lifecycle mutex, result contents are staged to unique hidden temporary files **inside each target file's own parent directory**.

Use a recognizable C2C-owned pattern such as:

```text
.<target-basename>.c2c-tmp-<request-id>-<random>
```

The exact suffix implementation may vary, but it MUST be collision-resistant and MUST stay in the target parent. Do not use an OS/global temp directory; same-parent staging avoids cross-device `EXDEV` replacement failures.

Before the first target replacement/create:

- all result temp files exist successfully,
- every update has an in-memory rollback snapshot containing the exact original raw bytes and original mode metadata,
- all created-target rollback actions are known.

The configured V1 file-count/source/result-size caps keep these rollback snapshots bounded without introducing backup/journal files.

Rollback material MUST remain available until the terminal success receipt has been durably persisted, not merely until workspace replacement finishes.

Existing file permissions are preserved for updates.

New files use normal local file creation semantics; V1 does not accept mode instructions from the patch.

Known temp files MUST be unlinked best-effort in a `finally`-style cleanup after success or handled failure.

### 14.3 Commit and external concurrency

After all staging succeeds, C2C commits targets while still holding the write-lifecycle mutex.

The mutex serializes **C2C writers only**. It cannot lock out editors, Git, build tools or other external filesystem writers.

To narrow that race window:

- immediately before each update replacement, C2C MUST re-check that the current target is still within the source-size cap and still hashes to the prepared `baseSha256`,
- create operations MUST use a no-clobber/exclusive-create primitive that fails if the target exists at the actual creation step; a plain rename/replace that can overwrite a file created after revalidation is not sufficient,
- if a per-target commit guard fails after earlier targets were changed, normal handled rollback begins.

For updates there remains an unavoidable filesystem TOCTOU window between the final hash check and replacement unless the host filesystem provides a stronger compare-and-replace primitive. SPEC-002 does not claim that the broker mutex protects against such external writes.

Each staged temp is already in the target parent, so update replacement may use same-filesystem rename/replace semantics where appropriate; create uses the no-clobber rule above.

### 14.4 Handled failure rollback and receipt persistence

If a normal I/O/precondition error occurs after one or more targets have been changed, rollback is ownership-aware:

- restore an updated file from retained original bytes/mode **only if** its current bytes still hash to the exact `resultSha256` C2C wrote,
- remove a file created by C2C **only if** its current bytes still hash to C2C's intended `resultSha256`,
- if an external writer changed a C2C-written target, do not overwrite/delete that external change; treat rollback as failed/unresolved for that path,
- best-effort remove all known staging temps.

This prevents rollback from destroying a concurrent external edit **when the ownership mismatch is observed by the rollback guard**. The same unavoidable filesystem TOCTOU limitation described in §14.3 also applies between that guard and the restore/remove operation; SPEC-002 does not claim absolute protection against arbitrary external writers racing inside that window.

The implementation MUST test handled rollback with deterministic injected failures and external-edit hooks, including a detected ownership mismatch that is left untouched.

Terminal receipt persistence is part of successful completion:

1. keep rollback material after workspace mutation,
2. persist the terminal receipt with raw patch removed,
3. only after that persistence succeeds may C2C discard rollback material and report `applied`.

If terminal `applied` receipt persistence fails after workspace mutation:

- do **not** report success,
- attempt the same ownership-aware rollback while still holding the write-lifecycle mutex,
- if rollback succeeds, return `WRITE_RECEIPT_PERSIST_FAILED`; the prior durable request state may remain pending because the terminal write itself failed, and C2C MUST NOT automatically retry it,
- a later retry, if any, must be an explicit user action after storage health is restored and normal full revalidation runs again,
- for host-confirmed apply, rollback success means the workspace is restored even if no terminal receipt could be durably recorded.

If rollback cannot safely complete, return `WRITE_ROLLBACK_FAILED`, report the outcome as unresolved, and block further write mutations in that broker process until the user restarts/repairs after inspecting the affected paths. Do not invent a durable journal solely for this case.

### 14.5 Crash limitation

SPEC-002 does not promise a multi-file ACID transaction across:

- process kill,
- kernel crash,
- power loss,
- filesystem corruption.

A process/OS crash may leave a C2C-named staging temp because `finally` cleanup did not run. V1 does **not** add a blind project-directory sweep or durable journal solely to remove such crash artifacts; a blind sweep risks deleting user files with coincidental names and would expand scope beyond the stated crash guarantee.

This limitation MUST be documented rather than hidden behind the word "atomic".

---

## 15. Write-request model

### 15.1 Statuses

```text
pending
applied
rejected
stale
expired
failed
```

Manual lifecycle:

```text
                  ┌──▶ applied
                  │
pending ──────────┼──▶ rejected
                  │
                  ├──▶ stale
                  │
                  ├──▶ expired
                  │
                  └──▶ failed
```

Host-confirmed prepared attempt:

```text
prepared ────────┬──▶ applied
                 ├──▶ stale
                 └──▶ failed
```

`applied`, `rejected`, `stale`, `expired` and `failed` are terminal.

`failed` is reserved for an application/rollback failure after a request/host-confirmed attempt was otherwise valid enough to reach the write lifecycle. Pure parse/validation failures that never produce a prepared patch do not require a persisted receipt.

### 15.2 Manual request shape

Conceptually:

```ts
interface WriteRequest {
  id: string;
  kind: "patch";
  status: WriteRequestStatus;

  workspaceId: string;
  worktreeId?: string;

  approvalMode: "manual-local" | "host-confirmed";

  files: WriteRequestFile[];
  preconditions: WritePrecondition[];

  patch?: string;

  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolutionCode?: string;
}
```

The exact persisted shape may be smaller.

### 15.3 Terminal receipt

Terminal records retain only what is useful for audit/verification:

- id,
- status,
- workspace/worktree identity,
- approval mode,
- touched relative paths,
- operation type,
- additions/deletions,
- base hash for updates,
- result hash,
- created/resolved timestamps,
- failure/stale code when applicable.

Raw patch content MUST be removed before persisting the transition to **any** terminal status:

```text
applied
rejected
stale
expired
failed
```

This is deterministic security/data-minimization behavior for every terminal record that is successfully persisted.

If terminal persistence itself fails, no terminal transition has been durably recorded; follow §14.4. The prior durable manual record may therefore remain `pending` with its pending-only patch body until an explicit retry/rejection can be persisted. C2C MUST NOT describe such a record as terminal or successfully applied.

### 15.4 Host-confirmed receipt

A successful native write persists a terminal receipt with:

```text
approvalMode = host-confirmed
status       = applied
```

It MUST NOT first persist a locally approvable `pending` record.

Once a host-confirmed invocation has successfully produced a prepared patch/request id, a later stale revalidation or application failure normally persists a terminal `stale` or `failed` host-confirmed receipt with the sanitized resolution code. This lets `get_write_request` recover the outcome after an interrupted client interaction.

If receipt persistence itself fails, §14.4 is authoritative: do not claim a persisted receipt that does not exist, roll back any workspace mutation where safely possible, and return the persistence/rollback error.

A parse/security failure before a prepared patch exists may return its typed error without creating history.

### 15.5 IDs

Use opaque random request IDs such as:

```text
wr_<random>
```

Do not encode workspace paths or filenames into the ID.

---

## 16. Write-request storage

Store records in the existing state boundary via:

```text
stateSubdir("write-requests")
```

The default installed location is typically under `~/.c2c/state/`, but the existing state resolver remains authoritative for profiles, tests, overrides and legacy migration compatibility.

Requirements:

- state directory remains local,
- directory permissions follow existing secure-state conventions,
- record files are `0600`,
- record replacement uses same-directory temp + atomic rename/replace,
- no request data is written into the project,
- no database is added,
- only the installation broker process writes request state in V1.

### 16.1 TTL

Pending:

```text
60 minutes
```

Terminal:

```text
7 days
```

### 16.2 Lazy cleanup

Cleanup occurs during broker-owned operations such as:

- create,
- list,
- get,
- approve.

If lazy cleanup transitions an expired pending request, it uses the same write-lifecycle serialization, clears raw patch content and persists terminal `expired` before returning it as non-pending.

No scheduler or background process is needed.

### 16.3 No V1 pending deduplication

Each accepted proposal/manual import creates a fresh pending request id.

V1 does not compare normalized patch/precondition tuples to deduplicate pending requests. This avoids optional behavior and request-equality logic that is not required for correctness.

If duplicate proposals become real friction in production, exact pending-request deduplication can be added later as a separate small change.

---

## 17. Phase 0 — ChatGPT MCP write-capability PoC

The PoC happens before finalizing which MCP mutation path ships.

### 17.1 Purpose

Test two distinct capabilities against the user's actual ChatGPT Plus environment.

#### Probe A — direct destructive write

Truthfully annotated state-changing tool:

```ts
{
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false
}
```

The probe changes only a dedicated disposable C2C state record, never a project workspace.

Questions:

1. Does ChatGPT discover the tool?
2. Can ChatGPT invoke it?
3. Does the host show an explicit native confirmation before execution?
4. Does denial prevent execution?
5. Does approval execute exactly once?
6. Does the required OAuth scope upgrade/re-pair flow work acceptably?

#### Probe B — non-destructive proposal write

Truthfully annotated state-changing but non-destructive tool:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
}
```

Its only effect is to create a disposable pending C2C state record.

Questions:

1. Does ChatGPT discover the tool?
2. Can ChatGPT invoke it on Plus?
3. Is it allowed even when Probe A is blocked?
4. Does it create exactly one local pending record for that invocation?
5. Does it avoid project/workspace mutation?

### 17.2 Probe safety

Neither probe may mutate a project workspace.

Use dedicated disposable C2C state files under the existing secure state directory.

Probe tools MUST be behind an explicit development/probe opt-in gate and MUST NOT appear in the default production MCP tool listing. The gate exists only for Phase 0 and is removed with the probe handlers after evidence is captured.

### 17.3 Authorization

If a scope is required for the PoC, use the intended production mutation scope:

```text
workspace.write
```

Do not silently grant it to existing tokens.

### 17.4 Authoritative capability matrix

Probe A and Probe B are independent. This table is the SSOT for which mutation transports ship:

```text
Probe A   Probe B   Shipped MCP mutation                  Required fallback
-------   -------   ------------------------------------  -----------------------------
SUPPORTED SUPPORTED apply_patch + propose_patch           propose_patch + c2c approve
SUPPORTED BLOCKED   apply_patch                           c2c patch + c2c approve
BLOCKED   SUPPORTED propose_patch                         c2c approve
BLOCKED   BLOCKED   none                                  c2c patch + c2c approve
```

Rules:

- Probe A controls only direct host-confirmed `apply_patch` shipment.
- Probe B controls only MCP `propose_patch` shipment.
- Probe B being blocked MUST NOT disable `apply_patch` when Probe A is supported.
- Probe A being blocked MUST NOT disable `propose_patch` when Probe B is supported.
- manual `c2c patch` import is implemented only when Probe B is blocked, because otherwise `propose_patch` is the lower-friction transport.
- production docs, implementation phases and acceptance criteria MUST reference this matrix rather than restate conflicting capability rules.

### 17.5 No annotation workaround

If either capability is unsupported, do **not**:

- mark a state-changing tool `readOnlyHint: true`,
- hide mutation behind a "preview" tool,
- persist pending state from a tool advertised as read-only,
- misuse read scopes for writes.

The compatibility fallback must remain honest.

### 17.6 Required evidence artifact

Phase 0 evidence is committed to one SSOT file:

```text
docs/verification/artifacts/spec-002/mcp-write-probes.md
```

It contains separate fixed sections for Probe A and Probe B with:

- date,
- plan/tier,
- connector/app mode,
- tool annotations,
- discovery result,
- invocation result,
- confirmation behavior where applicable,
- host confirmation settings and any remembered-approval behavior observed,
- deny behavior where applicable,
- state-change result,
- scope/re-pair behavior,
- final `SUPPORTED` or `BLOCKED` decision.

Phase 3 and Phase 6 MUST reference this artifact for their go/no-go decision.

---

## 18. Native MCP `apply_patch` contract

This section is conditional on Phase 0 Probe A = `SUPPORTED`.

### 18.1 Tool

```text
apply_patch
```

### 18.2 Input

```ts
{
  workspace?: string;
  worktree?: string;
  patch: string;
}
```

Use the existing `workspace` / `worktree` naming and target-resolution conventions. Omitted `workspace` is allowed only when the existing broker resolver can resolve one unambiguous workspace; it is not a filesystem-path fallback.

The tool MUST NOT accept:

- filesystem root,
- absolute paths,
- expected hashes,
- file lists,
- approval flags,
- expiry,
- "force",
- fuzzy mode,
- shell commands.

### 18.3 Authorization

Require:

```text
workspace.write
```

Existing tokens lacking this scope remain read-only.

There is no silent scope escalation.

### 18.4 Annotations

Because the tool may overwrite existing user files:

```ts
{
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false
}
```

`openWorldHint: false` is correct because the operation is limited to one bounded private workspace capability.

### 18.5 Handler behavior

The MCP adapter delegates to:

```text
WriteRequestService.applyHostConfirmedPatch(...)
```

The adapter does not perform filesystem mutation itself.

### 18.6 Success response

Return a compact receipt:

```json
{
  "request_id": "wr_...",
  "status": "applied",
  "files": [
    {
      "path": "docs/example.md",
      "action": "update",
      "additions": 4,
      "deletions": 2
    }
  ]
}
```

Do not return absolute local paths.

### 18.7 Failure response

Use sanitized typed errors.

Examples:

```text
PATCH_INVALID
PATCH_UNSUPPORTED_OPERATION
PATCH_TOO_LARGE
WRITE_ACCESS_DENIED
WRITE_PROTECTED_PATH
WRITE_STALE
WORKSPACE_UNAVAILABLE
WORKTREE_UNAVAILABLE
WRITE_APPLY_FAILED
```

Do not leak local absolute paths.

---

## 19. Preferred fallback — MCP `propose_patch` + local approval

This path ships whenever Probe B is `SUPPORTED`.

### 19.1 Tool

```text
propose_patch
```

This tool is state-changing because it persists a local pending write request.

It MUST therefore be truthfully annotated:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
}
```

### 19.2 Input

Keep the contract minimal:

```ts
{
  workspace?: string;
  worktree?: string;
  patch: string;
}
```

Use the same existing MCP target-resolution convention as read tools and `apply_patch`; filesystem paths are never accepted.

The remote client does not provide hashes, file lists, approval mode, expiry or atomicity flags.

### 19.3 Behavior

`propose_patch` requires:

```text
workspace.write
```

because persisting a pending request is truthfully state-changing even though it does not mutate project files.

The handler:

1. resolves the workspace/worktree target,
2. parses and validates the patch,
3. prepares all operations in memory,
4. computes exact preconditions,
5. persists one fresh local `pending` write request through the broker-owned write service,
6. returns a compact request receipt.

It does **not** modify project workspace files.

### 19.4 Response

Example:

```json
{
  "request_id": "wr_...",
  "status": "pending",
  "files": [
    {
      "path": "docs/example.md",
      "action": "update",
      "additions": 4,
      "deletions": 2
    }
  ],
  "expires_at": "..."
}
```

Do not return absolute paths.

### 19.5 User UX

Normal flow:

```text
user: "zapracuj tieto body do specu"

ChatGPT
   ↓
propose_patch(...)
   ↓
"Patch je pripravený. Spusti `c2c approve`."

user:
c2c approve

C2C:
✓ Applied wr_...

ChatGPT:
list/get receipt → read_file/git_diff → verify
```

Do not force the user to copy `request_id` in the common one-relevant-pending case.

### 19.6 `c2c approve`

`c2c approve` is the explicit approval action.

Without an explicit request id, **relevant** means pending requests whose stored `workspaceId` and optional `worktreeId` match the concrete target containing `process.cwd()`. The local resolver MUST support cwd inside a workspace/worktree, not only cwd equal to its root.

Resolution stays local and deterministic:

1. canonicalize cwd,
2. collect explicit registered workspace roots that contain cwd,
3. when Git/worktree discovery identifies a valid current concrete main/derived worktree target under SPEC-001, include that concrete root as another candidate,
4. choose the candidate with the **deepest canonical root** containing cwd; on an equal-root tie, the explicit registration wins.

This preserves SPEC-001 exact-registration ownership: a parent Git root MUST NOT override a more specific explicitly registered subtree such as registered `/repo/package` inside registered `/repo`. Conversely, a valid derived worktree root deeper than its registered main workspace remains selectable when no deeper explicit registration owns that subtree. An unregistered cwd fails closed and never falls back to global pending requests. Remote MCP target semantics are unchanged.

Rules:

- 0 relevant pending requests → do not fall back to a global pending request; explain none exist for the current target and, if useful, show concise ids/targets of other pending requests,
- exactly 1 relevant pending request → apply it immediately,
- more than 1 relevant pending request → fail safely and show concise candidate ids,
- stale/expired request → persist its terminal status, clear raw patch, and do not apply.

An explicit `c2c approve wr_...` selects that id directly rather than applying the cwd filter; normal local admin authorization and target re-resolution still apply.

When exactly one request is selected, V1 does **not** ask another `[y/N]`.

### 19.7 Inspection before approval

If the user wants to review first:

```text
c2c pending
c2c pending --diff
```

Without an explicit id/selector, these commands use the same cwd-resolved relevant-target rule.

`c2c pending` shows concise metadata by default.

`--diff` shows the pending patch locally.

### 19.8 Reject

```text
c2c reject [request-id]
```

Without an id, the same cwd-relevant one-pending ambiguity rule applies.

Reject transitions the request under the broker write-lifecycle mutex and clears the raw patch before persisting terminal state.

### 19.9 Manual compatibility fallback

Availability is defined only by the authoritative §17.4 matrix. When Probe B = `BLOCKED`, provide this manual compatibility transport regardless of Probe A:

```text
c2c patch
c2c patch --file <path>
c2c patch --stdin
```

Default `c2c patch` may read the clipboard by reusing the existing `c2c plan` clipboard helper.

If clipboard access is unavailable/fails, the command MUST exit non-zero, create no request, and tell the user to use `--file` or `--stdin`.

This is a compatibility path, not the normal UX.

The manual path:

1. imports the patch locally,
2. resolves the containing concrete target from cwd using the §19.6 rule,
3. sends the request through the broker `/admin` API,
4. prepares it through the same write domain,
5. creates a local pending request,
6. lets `c2c approve` apply it.

Do not build a second mutation implementation for the manual path.

---

## 20. Local Admin API

The installation broker already exposes a loopback-only, random-token-protected `/admin/*` API used by CLI/local tooling.

Write-request administration belongs **only** there, in `src/broker/server.ts`.

The legacy per-project bridge `src/bridge/server.ts` MUST NOT expose these routes.

Suggested endpoints:

```text
POST /admin/write-requests
GET  /admin/write-requests
GET  /admin/write-requests/:id
POST /admin/write-requests/:id/approve
POST /admin/write-requests/:id/reject
```

### 20.1 Create

Conceptual local body:

```json
{
  "workspaceId": "veterinar-af58c35d",
  "worktreeId": "wt_...",
  "patch": "..."
}
```

This endpoint is local/admin only.

Every accepted create produces a fresh pending request id in V1; there is no pending deduplication.

### 20.2 List

Support narrow filters useful to CLI and future TUI:

```text
workspaceId?
worktreeId?
status?
limit?
```

Ordering is deterministic:

```text
(resolvedAt ?? createdAt) descending,
then id ascending
```

Apply `limit` after sorting.

Avoid building a generic query language.

### 20.3 Detail

Local detail may include the raw pending patch because local approval UI may need to display it.

Terminal detail MUST omit raw patch because terminal persistence has already cleared it.

### 20.4 Approve

`approve` means:

```text
enter write-lifecycle mutex
    ↓
reload request and require pending
    ↓
check expiry; persist expired if needed
    ↓
re-resolve workspace/worktree
    ↓
re-run full path/security/type checks
    ↓
re-check all bounded content/absence preconditions
    ↓
stage same-parent temps + retain rollback snapshots
    ↓
per-target commit guards + apply / handled rollback
    ↓
persist terminal receipt with raw patch cleared
    ↓
only then discard rollback material and report success
    ↓
leave mutex
```

There is no durable intermediate:

```text
approved-but-not-applied
```

Two concurrent approvals of the same request serialize. After the first terminal transition, the second reload sees non-pending and returns `WRITE_REQUEST_NOT_PENDING`; it cannot apply again.

A terminal-receipt persistence failure after workspace mutation follows §14.4. In particular, it is not reported as `applied`, rollback material is still available, and C2C does not blindly retry the request.

### 20.5 Reject

Reject uses the same write-lifecycle serialization, records terminal `rejected`, clears raw patch content, and never mutates project files.

### 20.6 TUI reuse

A future C2C Manager TUI uses the same admin endpoints.

SPEC-002 does not create TUI-specific service abstractions now.

---

## 21. Read-only MCP write-receipt tools

These tools may ship even when MCP mutation tools are unsupported because callers can only inspect receipts through them; they cannot approve, reject, create, or apply requests.

Recommended:

```text
list_write_requests
get_write_request
```

### 21.1 Purpose

They let ChatGPT recover local write context after a CLI approval without requiring the user to paste CLI output.

Example:

```text
user: applied
        ↓
ChatGPT list_write_requests(status=applied, limit=1)
        ↓
ChatGPT reads affected files / git diff
        ↓
verification result
```

### 21.2 Input and ordering

`list_write_requests`:

```ts
{
  workspace?: string;
  worktree?: string;
  status?: "pending" | "applied" | "rejected" | "stale" | "expired" | "failed";
  limit?: number; // default 20, max 100
}
```

`get_write_request`:

```ts
{
  workspace?: string;
  worktree?: string;
  request_id: string;
}
```

`workspace`/`worktree` follow the same remote target-resolution convention as existing read tools.

List ordering is:

```text
(resolvedAt ?? createdAt) descending,
then id ascending
```

Apply `limit` after sorting so `status=applied, limit=1` deterministically means the latest relevant applied receipt.

### 21.3 Authorization

Use existing read authorization for the selected workspace target.

A remote client may inspect receipts only for a workspace/worktree it can already address.

### 21.4 Output minimization

Remote receipt tools return:

- opaque request id,
- status,
- approval mode,
- relative file paths,
- operation type,
- additions/deletions,
- timestamps,
- result hashes where useful,
- sanitized resolution code when relevant.

They MUST NOT return:

- local absolute paths,
- raw persisted patch bodies,
- unrelated workspace receipts.

### 21.5 Annotations

```ts
{
  readOnlyHint: true,
  openWorldHint: false
}
```

The read-only annotation describes the caller-facing operation: these tools never write workspace files or accept a caller-selected request mutation. A `list` or `get` may persist broker-owned expiry or retention cleanup in the request store under §16.2. This internal maintenance is a store side effect, not a caller-selected mutation.

---

## 22. Post-apply verification

Post-apply verification is part of the feature, not optional advice.

### 22.1 Rule

After any successful:

```text
host-confirmed apply
or
manual-local apply
```

ChatGPT MUST independently inspect the resulting target before declaring the requested edit correct.

### 22.2 Preferred verification sources

Use the smallest sufficient combination of:

- `get_write_request`,
- `read_file`,
- `git_diff`,
- `git_status`.

### 22.3 Verification behavior

For each touched file:

1. confirm the expected file exists,
2. read the changed region or whole file when reasonably small,
3. compare the result to the intended change,
4. inspect surrounding context when semantic correctness depends on it.

For Git workspaces, `git_diff` is useful as an independent final view.

### 22.4 Receipt is not proof

A result hash proves what C2C wrote, not that the content is semantically correct.

ChatGPT MUST NOT replace re-reading with:

```text
"hash matched, therefore correct"
```

### 22.5 Verification failure

If verification finds a mistake:

- explain the mismatch,
- prepare a corrective patch,
- send it through the same approval path.

Do not silently perform an additional unapproved mutation.

### 22.6 Protocol update

`docs/protocol.md` and Skill guidance should distinguish:

```text
APPLIED
```

from:

```text
VERIFIED / DONE
```

No new network state machine is required solely for this distinction; protocol wording may express it as a review requirement.

---

## 23. Future auto-accept compatibility

Auto-accept is explicitly not implemented by SPEC-002 V1.

However, V1 must avoid architecture that makes it difficult later.

### 23.1 Central policy decision point

Do not scatter logic such as:

```ts
if (autoAccept) ...
```

across MCP, CLI and broker adapters.

Future approval policy belongs centrally around the write service.

### 23.2 Likely future modes

Conceptually:

```text
manual-local
host-confirmed
auto
```

This is not a required V1 interface hierarchy.

Do not create `ApprovalProvider` classes until more than one real policy needs the abstraction.

### 23.3 Per-project policy

A future project may opt into a narrow rule such as:

```text
auto-accept docs/**/*.md
```

or a docs-only preset.

SPEC-002 does not define the final config schema.

### 23.4 Control-file protection

`.c2c.json`, `.c2cignore` and `.c2c/**` are write-protected so a future model cannot weaken C2C policy/state through the same patch capability.

### 23.5 Verification remains

Future auto-accept MUST NOT remove post-apply ChatGPT verification.

The desired future flow is:

```text
ChatGPT patch
    ↓
policy allows
    ↓
apply
    ↓
ChatGPT re-read
    ↓
verify
```

---

## 24. OAuth and permission model

### 24.1 Mutation scope

If **any** production MCP state-changing write/proposal tool ships, use one scope:

```text
workspace.write
```

This includes:

- `propose_patch`,
- `apply_patch` when Probe A is supported.

Do not introduce a separate `workspace.propose_write` scope in V1.

If both Probe A and Probe B are blocked, no production MCP mutation scope is required.

Phase 0 may test `workspace.write` behind the explicit probe gate without implying that the scope ships to normal clients.

### 24.2 Explicit write authorization and safe defaults

Adding `workspace.write` to the set of supported scopes MUST NOT make it part of an implicit/default grant.

Keep two concepts distinct:

```text
SUPPORTED_SCOPES     = every scope the server understands
DEFAULT_READ_SCOPES  = only the existing read/offline defaults
```

Rules:

- omitted/empty requested scope grants only `DEFAULT_READ_SCOPES`, never `workspace.write`,
- a request containing only unknown scopes MUST NOT fall back to all supported scopes; reject/return no unsupported grant according to the existing OAuth error contract,
- `workspace.write` is granted only when explicitly requested and explicitly represented in the authorization/consent flow,
- existing tokens do not gain `workspace.write` automatically,
- read-only clients continue to work with their existing scopes,
- the consent page may say "read-only" only when the actual requested/granted scopes are read-only; when `workspace.write` is requested it MUST explicitly describe the narrow C2C mutation capability,
- any shipped mutation capability documents the required re-pair/re-authorization flow.

This scope-default separation and scope-aware consent wording MUST be implemented before running authenticated Probe A/B so the probe cannot accidentally validate an implicit write grant.

### 24.3 Scope enforcement

`propose_patch` requires `workspace.write`.

`apply_patch` requires `workspace.write` when it ships.

A token without the scope receives the existing sanitized `INSUFFICIENT_SCOPE` error.

Read receipt tools require only appropriate existing read access.

Local `/admin` approval uses the existing loopback/admin-token trust boundary, not remote OAuth.

### 24.4 Provider neutrality

The production domain MUST NOT import ChatGPT/OpenAI-specific approval concepts.

Host compatibility is an adapter/deployment concern.

The domain only needs to know whether it was asked to:

```text
applyHostConfirmedPatch
```

or manage a local manual request.

---

## 25. Security invariants

1. Remote callers never nominate filesystem roots.
2. Remote callers never nominate raw worktree paths.
3. Every patch path remains workspace-relative at the protocol boundary.
4. Every target is canonicalized before use and re-canonicalized immediately before commit.
5. Symlink write targets/parents are rejected at preparation and final revalidation.
6. Sensitive paths use the canonical workspace sensitive policy and are denied.
7. `.git`, `.c2c`, `.c2c/**`, `.c2c.json` and `.c2cignore` are write-protected with case-insensitive control-name matching.
8. Canonical active C2C installation/state roots are denied regardless of workspace-relative names.
9. Existing files require exact raw-byte hash preconditions.
10. New files require absence preconditions and no-clobber commit.
11. Source loading/hashing is bounded by the V1 source-size cap.
12. Duplicate normalized logical targets in one patch are rejected.
13. All operations validate before mutation.
14. Final security/stale revalidation and C2C commit are serialized under the broker write-lifecycle mutex.
15. The mutex protects against competing C2C writers only; external filesystem writers remain a documented limitation.
16. Rollback restores/removes a target only while its current bytes still match the exact C2C-written result.
17. Delete/rename/mode/binary operations are rejected.
18. No fuzzy patch application exists.
19. No shell is introduced.
20. No Git write command is introduced.
21. Local pending patch record files are `0600`.
22. Raw pending patch content is removed before every successfully persisted terminal record.
23. Write-request JSON replacement is atomic temp+rename within the state directory.
24. Terminal `applied` is not reported until its receipt is durably persisted; persistence failure follows §14.4.
25. MCP errors do not expose absolute paths.
26. MCP receipt tools do not expose raw patch bodies.
27. `workspace.write` is not part of default/implicit OAuth scope grants.
28. `propose_patch` and `apply_patch` require explicitly authorized `workspace.write` when they ship.
29. The installation broker holds exclusive state-directory write ownership and is the sole V1 write-request state/workspace writer.
30. The legacy per-project bridge remains read-only and exposes no write-request admin routes.
31. Host incompatibility is never bypassed through false annotations.
32. Future approval configuration/state cannot be modified through the same remote patch capability.
33. Unrelated dirty workspace files are not rewritten or cleaned.

---

## 26. Error model

Use stable codes rather than parsing human messages.

Recommended domain errors:

```text
PATCH_INVALID
PATCH_TOO_LARGE
PATCH_TOO_MANY_FILES
PATCH_UNSUPPORTED_OPERATION
PATCH_DOES_NOT_APPLY
WRITE_ACCESS_DENIED
WRITE_PROTECTED_PATH
WRITE_SYMLINK_DENIED
WRITE_TARGET_NOT_FILE
WRITE_TARGET_EXISTS
WRITE_PARENT_MISSING
WRITE_FILE_TOO_LARGE
WRITE_STALE
WRITE_REQUEST_NOT_FOUND
WRITE_REQUEST_NOT_PENDING
WRITE_REQUEST_EXPIRED
WRITE_APPLY_FAILED
WRITE_RECEIPT_PERSIST_FAILED
WRITE_ROLLBACK_FAILED
```

Existing workspace/worktree and authorization errors remain reusable, including:

```text
WORKSPACE_UNAVAILABLE
WORKTREE_UNAVAILABLE
INSUFFICIENT_SCOPE
```

Do not add separate parent/target-not-writable codes in V1; `WRITE_ACCESS_DENIED` is sufficient unless implementation evidence shows callers need more precision.

### 26.1 HTTP mapping

Deterministic mapping:

```text
400  PATCH_INVALID / PATCH_UNSUPPORTED_OPERATION / PATCH_DOES_NOT_APPLY
403  WRITE_ACCESS_DENIED / WRITE_PROTECTED_PATH / WRITE_SYMLINK_DENIED / INSUFFICIENT_SCOPE
404  WRITE_REQUEST_NOT_FOUND / unknown workspace/target
409  WRITE_STALE / WRITE_TARGET_EXISTS / WRITE_REQUEST_NOT_PENDING / WRITE_REQUEST_EXPIRED / target conflict
413  PATCH_TOO_LARGE / PATCH_TOO_MANY_FILES / WRITE_FILE_TOO_LARGE
500  WRITE_APPLY_FAILED / WRITE_RECEIPT_PERSIST_FAILED / WRITE_ROLLBACK_FAILED
```

Framework/MCP transport body-limit failures for patch-bearing routes map to `PATCH_TOO_LARGE` / 413.

### 26.2 Remote sanitization

MCP-facing errors MUST omit:

- absolute roots,
- temp-file paths,
- state-directory paths,
- admin details.

---

## 27. Logging

Security-sensitive logging rules remain in force.

Log:

- request id,
- workspace opaque id,
- optional worktree opaque id,
- status transition,
- file count,
- aggregate additions/deletions,
- error code.

Avoid logging:

- raw patch content,
- full file contents,
- secrets,
- absolute workspace paths in normal remote-related logs.

Local debug logging MAY include additional local context only when existing logger policy permits it.

---

## 28. CLI UX

### 28.1 Normal fallback

Preferred user interaction when `propose_patch` is available:

```bash
c2c approve
```

That single command is the local approval action.

For implicit local selection, cwd may be the concrete workspace/worktree root **or any descendant directory**. The CLI resolves that containing concrete target using the §19.6 rule before filtering pending requests. It MUST NOT require users to `cd` back to the repository root merely to approve/reject/list a request.

### 28.2 Pending list

```bash
c2c pending
```

Without an explicit selector, list pending requests relevant to the cwd-resolved concrete target.

Show:

```text
ID          Workspace    Files   Changes   Age
wr_...      veterinar    1       +12 -4    2m
```

Do not print raw patch by default.

### 28.3 Diff inspection

```bash
c2c pending --diff
```

When one relevant pending request exists, show its diff.

With multiple relevant requests, require explicit selection.

### 28.4 Approve

```bash
c2c approve
c2c approve wr_...
```

Without ID, filter by the cwd-resolved concrete target first:

- 0 relevant pending → do not auto-select another workspace's request,
- 1 relevant pending → select and apply immediately,
- >1 relevant pending → require explicit id and show candidates.

Do not ask a second `[y/N]` after an explicit `c2c approve`.

### 28.5 Reject

Same cwd-relevant selection behavior as approve.

### 28.6 Manual compatibility import

Only when MCP proposal writes are unavailable:

```bash
c2c patch
c2c patch --file <path>
c2c patch --stdin
```

The imported patch still becomes a normal local write request through the broker admin API and is applied through the same service.

Clipboard failure creates no request, exits non-zero and suggests `--file` or `--stdin`.

### 28.7 JSON

`c2c pending`, `c2c approve`, `c2c reject` and conditional `c2c patch` MUST support stable `--json` output for Skill/agent use.

Receipt/request items include at least:

```json
{
  "request_id": "wr_...",
  "status": "pending",
  "workspace_id": "...",
  "worktree_id": "...",
  "files": [
    {
      "path": "docs/example.md",
      "action": "update"
    }
  ]
}
```

`worktree_id` may be omitted/null for the main workspace.

`c2c pending --json` returns these items in a top-level `requests` array using the deterministic store ordering.

Ambiguous implicit selection exits non-zero and returns a machine-readable error containing the candidate request items/ids; it MUST NOT silently choose the first item.

Successful `c2c patch --json` returns the same pending-receipt shape as successful `propose_patch` modulo local camel/snake adapter naming.

### 28.8 No giant CLI business logic

`src/cli/index.ts` is already large.

Add command wiring/admin HTTP calls there, but keep parsing, state transitions and filesystem writes in `write-requests/` inside the broker process.

If command wiring becomes unwieldy, extracting a focused CLI command module is allowed, but do not redesign the whole CLI as part of SPEC-002.

---

## 29. Tests

### 29.1 Patch domain

Cover:

1. exact single-file update,
2. exact multi-file update,
3. multi-hunk single-file update,
4. new text file,
5. update + create in one patch,
6. invalid hunk,
7. fuzzy-only match rejected,
8. delete rejected,
9. rename rejected,
10. mode change rejected,
11. binary patch rejected,
12. absolute path rejected,
13. traversal rejected,
14. mismatched update old/new paths rejected,
15. create accepted only as `--- /dev/null` + normal new path,
16. `/dev/null` in any other position rejected,
17. duplicate file sections resolving to the same logical path rejected before hunk application,
18. normal paired `a/` + `b/` prefix stripping,
19. real `a/foo` / `b/foo` path edge cases are not misresolved,
20. mismatched/one-sided prefixes are treated literally and validated,
21. oversize patch rejected by UTF-8 byte count,
22. too many files rejected,
23. oversize result file rejected,
24. CRLF target + LF patch preserves CRLF and untouched bytes,
25. LF target + LF patch remains LF,
26. existing UTF-8 BOM is preserved,
27. mixed endings either preserve untouched bytes exactly or fail closed without mutation,
28. `\ No newline at end of file` update behavior,
29. `\ No newline at end of file` create behavior,
30. invalid UTF-8 update is rejected,
31. source file over 1 MiB is rejected with bounded reading before hunk application.

### 29.2 Path security

Cover:

1. sensitive existing file denied through canonical policy,
2. sensitive new file denied through canonical policy,
3. `.git` denied,
4. differently-cased `.Git` denied,
5. `.git` pointer file denied in linked worktree,
6. `.c2c` / `.c2c/**` denied,
7. `.c2c.json` denied,
8. differently-cased `.C2C.JSON` denied,
9. `.c2cignore` denied,
10. leaf symlink denied,
11. parent symlink path denied,
12. outside-workspace resolution denied,
13. normal nested regular file allowed,
14. target under a relocated `C2C_STATE_DIR` is denied even without a `.c2c` path segment,
15. target under a profile/explicit broker state root is denied,
16. registering the state root itself as a workspace does not make its contents writable.

### 29.3 Stale and approval-time revalidation

Cover:

1. update base hash unchanged → applies,
2. update changed after proposal → whole request terminal stale,
3. create still absent → applies,
4. create appears after proposal → whole request terminal stale,
5. one stale file in multi-file request → zero intentional writes,
6. target becomes symlink after proposal → request terminal stale with `WRITE_SYMLINK_DENIED` and zero intentional writes,
7. target becomes directory/non-regular after proposal → request terminal stale with the specific target-type code and zero intentional writes,
8. parent path changes through a symlink after proposal → request terminal stale,
9. workspace/worktree becomes unavailable after proposal → request terminal stale with underlying resolution code,
10. stale/expired transitions persist before error return and raw patch is absent afterward.

### 29.4 Application/rollback

Cover:

1. all prepared result temps exist before commit,
2. every staging temp is in its target parent,
3. successful multi-file commit,
4. deterministic failure on second replacement restores first from exact original bytes,
5. deterministic failure after a create removes the created file,
6. rollback restores existing file mode metadata,
7. handled success/failure cleans all known staging temps best-effort,
8. rollback failure produces `WRITE_ROLLBACK_FAILED`,
9. existing file mode preserved on successful update,
10. unrelated dirty workspace files remain byte-identical,
11. create target appearing after final revalidation is not overwritten by commit,
12. external edit injected before an update replacement is detected by the per-target commit guard where it occurs before replacement,
13. deterministically injected external edit before the rollback ownership guard is detected and not overwritten/deleted; rollback reports unresolved failure,
14. terminal-receipt persistence failure after mutation triggers ownership-aware rollback and never returns `applied`,
15. successful rollback after receipt-persistence failure leaves the workspace restored and requires explicit later retry,
16. receipt-persistence failure plus unsafe/failed rollback returns `WRITE_ROLLBACK_FAILED` and blocks further writes in that broker process.

### 29.5 Store

Cover:

1. secure record creation under `stateSubdir("write-requests")`,
2. persisted record replacement uses same-directory temp + atomic rename/replace,
3. readers never observe partial JSON during a deterministic write/read race,
4. 60-minute pending expiry,
5. 7-day terminal cleanup,
6. raw patch removed on every terminal status,
7. unknown id,
8. terminal request cannot be approved again,
9. two identical accepted proposals create two fresh pending ids in V1.

### 29.6 Admin API

Cover:

1. admin token required,
2. forwarded/public request cannot access admin endpoints,
3. create,
4. list/filter with deterministic ordering + limit after ordering,
5. detail,
6. approve,
7. reject,
8. stale maps to 409 and is persisted terminal before response,
9. expired maps to 409 and is persisted terminal before response,
10. `WRITE_REQUEST_NOT_PENDING` maps to 409,
11. raw patch unavailable after every terminal resolution,
12. legacy `src/bridge/server.ts` exposes no write-request admin routes,
13. transport-level oversized patch bodies return `PATCH_TOO_LARGE` / 413 rather than a framework-specific error.

### 29.7 CLI

Cover:

1. cwd-resolved one-pending implicit approve selection,
2. one-pending `c2c approve` applies without a second prompt,
3. pending request for another workspace is never implicitly auto-selected,
4. multiple relevant pending ambiguity fails safely with candidates,
5. explicit request id bypasses cwd filtering but still uses admin auth/revalidation,
6. `c2c pending`,
7. `c2c pending --diff`,
8. reject flow,
9. worktree-aware cwd resolution,
10. stable `--json` request/receipt shape,
11. JSON ambiguity output + non-zero exit,
12. conditional manual compatibility clipboard import,
13. clipboard failure creates no request and suggests `--file`/`--stdin`,
14. conditional manual compatibility `--file`,
15. conditional manual compatibility `--stdin`,
16. conditional `c2c patch --json` returns pending-receipt shape,
17. cwd at a child directory of a registered main workspace resolves to that workspace,
18. cwd at a child directory of a derived worktree resolves to that worktree,
19. unregistered cwd fails closed and never selects a global pending request,
20. with explicit registrations at `/repo` and `/repo/package`, cwd under `/repo/package` resolves to the nested registration rather than the parent Git root,
21. a valid derived worktree root deeper than its registered main root still resolves to that derived worktree when no deeper explicit registration owns the cwd subtree.

### 29.8 Native MCP path — only if Probe A supported

Cover:

1. `apply_patch` requires `workspace.write`,
2. no write scope → `INSUFFICIENT_SCOPE`,
3. correct tool annotations,
4. main workspace apply,
5. derived worktree apply,
6. omitted workspace follows existing unambiguous resolver only,
7. stale target fails closed,
8. no absolute paths in output/errors,
9. receipt persisted as `host-confirmed`,
10. host-confirmed stale/apply failure after preparation persists terminal receipt,
11. no local pending request is left behind,
12. legacy bridge does not expose the tool.

### 29.9 Read-only receipt MCP tools

Cover:

1. read-only annotations,
2. workspace scoping,
3. worktree scoping,
4. defined list/get schemas,
5. no raw patch in output,
6. no absolute path in output,
7. deterministic most-recent-first ordering,
8. `status=applied, limit=1` discovers latest relevant applied request.

### 29.10 Compatibility PoC evidence

Require:

```text
docs/verification/artifacts/spec-002/mcp-write-probes.md
```

with the §17.6 fields recorded separately for Probe A and Probe B.

Do not claim native direct-write support without Probe A evidence.

Do not claim MCP proposal fallback support without Probe B evidence.

The default MCP tool listing MUST NOT expose disposable probe tools, and no probe handler/route remains after Phase 0 closeout.

### 29.11 Regression gate

The SPEC-002 V1 validation gate runs on Linux/WSL. Before completion, run the
focused write-request/owner tests and the full test, typecheck, and build gates.
Windows/macOS validation is not required for V1 completion.

```bash
pnpm test
pnpm typecheck
pnpm build
```

### 29.12 MCP proposal fallback — only if Probe B supported

Cover:

1. `propose_patch` requires `workspace.write`,
2. read-scoped token receives `INSUFFICIENT_SCOPE`,
3. annotations are state-changing + non-destructive,
4. proposal creates pending local state but zero project-file mutation,
5. workspace/worktree resolution matches existing MCP conventions,
6. filesystem paths are never accepted as selectors,
7. legacy bridge does not expose `propose_patch`,
8. accepted duplicate proposals remain separate pending ids in V1,
9. MCP transport-level oversized patch input is surfaced as sanitized `PATCH_TOO_LARGE`.

### 29.13 Concurrency

Cover deterministically:

1. two simultaneous approvals of one request → exactly one applies; the other receives `WRITE_REQUEST_NOT_PENDING`,
2. approve racing reject → exactly one terminal transition wins; no double transition/write,
3. host-confirmed apply racing manual approval on overlapping file → final revalidation/commit serialize; the second path cannot overwrite from stale prepared content,
4. two different manual requests touching the same file serialize; after the first commit the second becomes stale,
5. concurrent store/list activity never exposes truncated/partial JSON.

### 29.14 Installation ownership and OAuth safety

Cover:

1. two broker processes using the same resolved state directory cannot both acquire write ownership,
2. the same guarantee holds when the preferred port is occupied by an unrelated process and broker networking falls back,
3. brokers using different resolved state directories remain independent,
4. omitted OAuth scope grants only default read scopes,
5. an entirely unknown requested scope does not grant all supported scopes,
6. `workspace.write` is granted only when explicitly requested/authorized,
7. read-only consent wording is not shown when `workspace.write` is requested,
8. authenticated Probe A/B runs only after these scope-default/consent checks pass,
9. V1 write ownership is Linux/WSL-only, preserves the `flock` guarantee, and fails closed with `WRITE_OWNER_UNAVAILABLE` on non-Linux platforms.

---

## 30. Documentation updates

### 30.1 `docs/security.md`

Documentation MUST derive from the authoritative §17.4 matrix rather than from Probe A or B in isolation.

Always document the shared patch/security boundary: protected paths including canonical C2C installation/state roots, bounded source/result sizes, stale preconditions, no shell, no delete/rename/binary and the external-writer limitation.

Then document only the transports that actually ship:

- Probe A `SUPPORTED` → document direct `apply_patch`, host confirmation and explicit `workspace.write`,
- Probe B `SUPPORTED` → document `propose_patch` + local `c2c approve` and that proposal mutates only C2C pending state,
- Probe B `BLOCKED` → document manual `c2c patch` import as the required approval fallback,
- A/B both `BLOCKED` → preserve the production remote MCP read-only claim,
- A `SUPPORTED`, B `BLOCKED` → do **not** claim MCP is mutation-free; direct `apply_patch` still ships and manual import is its fallback.

Consent/re-pair documentation MUST state that write authorization is explicit and not part of default read scopes.

### 30.2 `docs/architecture.md`

Add `write-requests/` responsibility, the Linux/WSL-only `flock` ownership prerequisite, and broker-local write-lifecycle serialization. State that non-Linux V1 write ownership fails closed and that Windows/macOS validation is not a V1 completion condition.

Describe MCP surfaces by the authoritative §17.4 matrix:

- A+B supported: reads + direct approved patch write + proposal,
- A supported/B blocked: reads + direct approved patch write; manual local import fallback,
- A blocked/B supported: reads + patch proposal; local broker approval performs workspace write,
- both blocked: existing read-only MCP wording.

Explicitly keep `src/bridge/server.ts` legacy bridge read-only.

Do not imply generic mutation or protection against arbitrary external filesystem writers.

### 30.3 `docs/protocol.md`

Add post-write review semantics:

```text
apply success != verification success
```

ChatGPT must re-read before DONE.

Document that SPEC-002 V1 write requests are supported on Linux/WSL only.

### 30.4 `docs/local-e2e.md`

Add:

- propose + approve flow when Probe B is supported,
- conditional clipboard/file/stdin flow only when Probe B is blocked,
- approve/reject flow,
- stale request flow,
- cwd-relevant implicit selection,
- concurrency smoke coverage where practical,
- post-apply verification,
- native path only when Probe A is supported.
- Linux/WSL as the only supported SPEC-002 V1 write platform and the required local validation environment.

### 30.5 `docs/multi-workspace.md`

Clarify that writes target the same:

```text
workspaceId + optional worktreeId
```

model as reads, while CLI implicit selection resolves `process.cwd()` to that same identity before filtering pending requests.

### 30.6 `skill/SKILL.md`

Teach Codex/agent workflow:

- preserve exact workspace/worktree target,
- use `propose_patch` + local approval when supported,
- use manual import only when Probe B is unavailable,
- do not ask for filesystem paths remotely,
- consume stable CLI/receipt JSON when automating,
- require verification after apply.

---

## 31. Implementation sequence

### Phase 0 — capability probes

1. Separate OAuth `DEFAULT_READ_SCOPES` from all supported scopes and make consent wording scope-aware.
2. Verify omitted/unknown scopes cannot grant `workspace.write`.
3. Add gated disposable Probe A: destructive state-changing tool.
4. Add gated disposable Probe B: non-destructive state-changing proposal tool.
5. Verify default tool listing does not expose either probe.
6. Test actual ChatGPT Plus behavior, including confirmation settings/remembered approvals.
7. Record both results in `docs/verification/artifacts/spec-002/mcp-write-probes.md`.
8. Remove disposable probe tools and gate.
9. Verify no probe tool/route remains in the production/default surfaces.

No production workspace mutation ships in this phase.

### Phase 1 — shared write domain

Implement:

```text
write-requests/types.ts
write-requests/patch.ts
write-requests/apply.ts
write-requests/store.ts
write-requests/service.ts
```

including:

- exact text patch preparation,
- duplicate-target rejection,
- security policy,
- preconditions,
- installation-state exclusive writer ownership independent of broker port,
- broker write-lifecycle serialization,
- same-parent staging,
- ownership-aware handled rollback,
- terminal-receipt persistence rollback semantics,
- atomic request-record persistence,
- terminal receipt scrubbing.

### Phase 2 — local admin + approval lifecycle

Implement on the installation broker only:

- admin API,
- `c2c pending`,
- `c2c pending --diff`,
- `c2c approve`,
- `c2c reject`,
- cwd-relevant selection,
- stable CLI `--json`.

CLI is an admin HTTP client; it does not import the store/service as a second writer.

### Phase 3 — MCP proposal fallback, conditional on Probe B

Only if the Phase 0 artifact records Probe B = `SUPPORTED`:

- add/ship `workspace.write`,
- add `propose_patch`,
- create pending requests through MCP,
- keep `c2c approve` as the single local approval action.

### Phase 4 — manual compatibility import, conditional on Probe B blocked

Only if Probe B = `BLOCKED`:

- implement `c2c patch` clipboard/file/stdin as the last-resort transport,
- reuse the same broker admin API, write domain and local request lifecycle.

Do not implement/ship this compatibility surface when Probe B provides the intended lower-friction transport unless a later concrete need justifies it.

### Phase 5 — read-only receipt visibility

Implement:

```text
list_write_requests
get_write_request
```

for post-apply verification support with deterministic ordering.

### Phase 6 — native direct path, conditional on Probe A

Only when the Phase 0 artifact records Probe A = `SUPPORTED`:

- add real `apply_patch`,
- reuse the same `workspace.write` scope already used by `propose_patch` if Phase 3 shipped,
- add host-confirmed terminal receipt path,
- update connector docs/security semantics.

### Phase 7 — protocol/docs closeout

Update canonical docs to match the actual Probe A/B outcome and shipped surfaces.

Run full regression gates and verify disposable probe surfaces are absent.

---

## 32. Acceptance criteria

SPEC-002 is conformant when all applicable criteria below are true.

### Core write domain

1. V1 supports only text update and text create.
2. Delete is rejected.
3. Rename/move is rejected.
4. Binary mutation is rejected.
5. Mode-only mutation is rejected.
6. Patch application is exact; fuzzy matching is not used.
7. Dirty workspaces are allowed.
8. A clean Git state is not required.
9. Existing-file preconditions use exact raw-byte SHA-256.
10. New-file preconditions require absence.
11. Source reads/hashing are bounded by the V1 source-file cap.
12. All operations validate before the first workspace mutation.
13. One stale file prevents the entire multi-file request from applying.
14. Handled commit failures attempt ownership-aware rollback from retained exact originals.
15. Crash-safe multi-file ACID semantics are not falsely claimed.
16. Update targets are regular files.
17. Parent directories for creates must already exist.
18. Create commit uses no-clobber semantics and cannot overwrite a target that appears after revalidation.

### Security

19. Workspace/worktree target resolution reuses SPEC-001/existing resolver semantics.
20. Remote callers cannot provide filesystem roots or raw worktree paths.
21. Sensitive files cannot be written and the canonical sensitive policy is the SSOT.
22. `.git`, `.c2c`, `.c2c/**`, `.c2c.json` and `.c2cignore` cannot be written.
23. Write-control path matching is case-insensitive.
24. Canonical active C2C installation/state roots are denied regardless of workspace-relative names.
25. Symlink-targeted writes are rejected.
26. Absolute paths and traversal are rejected.
27. MCP responses/errors do not expose absolute local paths.
28. No shell execution or Git mutation command is introduced.
29. When rollback detects that a target's bytes no longer equal the exact result C2C wrote, it does not overwrite/delete that target; the external-writer TOCTOU limitation in §14.3/§14.4 remains explicit.

### Manual-local fallback / CLI

30. When Probe B is supported, `propose_patch` creates a pending local request through MCP without modifying project files.
31. `propose_patch` is truthfully marked state-changing and non-destructive and requires explicit `workspace.write`.
32. `c2c approve` is the explicit local approval action and does not ask a second `[y/N]` for one unambiguous relevant request.
33. Implicit approve/reject/pending selection filters by the concrete target containing `process.cwd()` and never auto-selects another workspace's request.
34. Implicit local resolution works from descendant directories, chooses the deepest valid concrete target, preserves a more-specific explicit registration over a parent Git root, and fails closed for unregistered cwd.
35. Multiple relevant pending requests require explicit selection.
36. `c2c pending --diff` supports local inspection before approval.
37. Manual clipboard/file/stdin import ships only when Probe B is blocked and uses the same broker/write domain.
38. Pending requests expire after 60 minutes; terminal history is retained for 7 days.
39. Raw patch content is removed before every successfully persisted terminal record.
40. CLI business logic remains delegated through the broker admin API/write domain.
41. CLI write-request commands expose stable `--json` output for agent use.

### Post-apply verification

42. A successful write returns/persists a receipt.
43. `applied` is not reported until terminal receipt persistence succeeds.
44. Receipt-persistence failure follows §14.4 and never becomes a blind automatic retry.
45. Read-only MCP receipt lookup can identify the latest relevant write deterministically.
46. Remote receipt output contains no raw patch body.
47. ChatGPT workflow requires re-reading changed state after apply.
48. Mutation receipt alone is not treated as semantic verification.
49. Corrective changes require a new approved patch.

### Native / compatibility paths

50. A real ChatGPT Plus compatibility PoC is completed before MCP mutation shipment.
51. OAuth default scopes/consent are hardened before authenticated probes so `workspace.write` cannot be granted implicitly.
52. The PoC does not modify a project workspace.
53. Probe A and Probe B results, confirmation settings and remembered-approval behavior are recorded in `docs/verification/artifacts/spec-002/mcp-write-probes.md`.
54. Unsupported mutation paths are not bypassed through false annotations.
55. Disposable probe tools are gated, absent from default discovery, and removed after Phase 0.
56. Shipped transports/fallbacks follow the authoritative §17.4 four-row capability matrix.
57. Probe B blocked alone does not disable `apply_patch` when Probe A is supported; manual `c2c patch` is then the fallback.
58. Probe A blocked alone does not disable `propose_patch` when Probe B is supported.
59. `propose_patch`/`apply_patch`, when shipped, require explicitly authorized `workspace.write`; existing tokens do not silently gain it.
60. Shipped MCP patch tools use only the existing `workspace?` + optional `worktree?` target convention plus `patch`.
61. If Probe A is supported, `apply_patch` is annotated truthfully as write/destructive/bounded and leaves no locally approvable pending record.
62. Host-confirmed prepared stale/failure outcomes normally persist terminal receipts; receipt-storage failure follows §14.4 rather than inventing persistence success.
63. Legacy per-project bridge remains read-only and exposes neither mutation tools nor write-request admin routes.

### Architecture / quality

64. New business logic lives in `src/write-requests/`.
65. `patch.ts` remains pure/in-memory and filesystem commit helpers live in focused `apply.ts`.
66. Before exposing write mutation surfaces, the installation broker acquires exclusive process-lifetime ownership keyed by the resolved state directory.
67. Two brokers for one state directory cannot become competing write owners even when the preferred port is occupied by an unrelated process.
68. Request-record replacement is secure same-directory temp + atomic rename/replace.
69. Final revalidation + C2C commit and pending terminal transitions are serialized by one broker write-lifecycle mutex.
70. The mutex is documented as C2C-writer serialization only; protection against arbitrary external filesystem writers is not claimed.
71. Two concurrent approvals cannot double-apply one request.
72. Overlapping host/manual writes cannot both commit from the same stale prepared base.
73. Duplicate normalized target paths in one patch are rejected before hunk application.
74. Create `/dev/null` and Git `a/`/`b/` prefix semantics are deterministic.
75. Untouched bytes are not changed by line-ending normalization; CRLF/LF/BOM/no-final-newline cases are covered.
76. Result temps are staged in target parent directories and known temps are cleaned after normal/handled completion.
77. Rollback material remains available through terminal receipt persistence.
78. Source/result/rollback memory is bounded by the V1 per-file limits.
79. No database, durable transaction journal, background queue or watcher is introduced.
80. Admin API remains loopback + admin-token protected.
81. Future TUI can use the same local admin API.
82. Future auto-accept policy can be inserted centrally without adapter-specific policy logic; auto-accept itself is not implemented.
83. Pending-request deduplication is not implemented by this spec.
84. Full tests pass.
85. Typecheck passes.
86. Build passes.
87. Canonical docs match the actual Probe A/B capability shipped.
88. Pre-existing unrelated working-tree changes are preserved during normal handled execution.
89. SPEC-002 V1 write support is Linux/WSL-only, non-Linux platforms fail closed, and Windows/macOS validation is not a completion condition.

---

## 33. Future work explicitly deferred

After SPEC-002 is stable in real use, consider separately:

- native Windows write-owner support as a separately implemented and validated change; it is not part of V1,
- macOS write-owner support only if separately proposed later; it is currently out of scope,

1. per-project auto-accept,
2. docs-only auto-accept preset,
3. path/glob approval policy,
4. C2C Manager TUI write-request screen,
5. native desktop notification for pending requests,
6. richer diff preview,
7. configurable retention,
8. crash-recovery journal if real evidence justifies it,
9. delete/rename support only with a separate threat-model review,
10. broader write operations only if patch-only proves insufficient,
11. exact pending-request deduplication if duplicate proposals become measurable friction,
12. stronger crash-orphan temp recovery only if real crashes justify a journal/ownership mechanism,
13. hard-link-specific threat handling if the threat model later requires it.

None of these are required to ship SPEC-002.

---

## 34. Final V1 shape

The desired UX is selected by the authoritative §17.4 capability matrix, not by separate mutation implementations.

### Probe A supported + Probe B supported

```text
ChatGPT
   │
   │ apply_patch(workspace?, worktree?, patch)
   ▼
native host confirmation
   ▼
installation broker / WriteRequestService
   ▼
serialized validate + bounded revalidation + apply
   ▼
durable applied receipt
   ▼
ChatGPT read_file/git_diff
   ▼
verified

fallback when direct apply is not desired/available for a request:
propose_patch → c2c approve → same WriteRequestService → verify
```

This is the lowest-friction full capability shape.

### Probe A supported + Probe B blocked

```text
ChatGPT
   │
   │ apply_patch(workspace?, worktree?, patch)
   ▼
native host confirmation
   ▼
same broker-owned WriteRequestService
   ▼
durable applied receipt
   ▼
verify

required fallback:
unified diff → c2c patch / --file / --stdin → c2c approve → same service → verify
```

Probe B being blocked does not disable the supported direct write path.

### Probe A blocked + Probe B supported

```text
ChatGPT
   │
   │ propose_patch(workspace?, worktree?, patch)
   ▼
pending request in broker state
   ▼
user: c2c approve
   ▼
CLI → broker /admin
   ▼
WriteRequestService
   ▼
serialized full revalidation + apply
   ▼
durable applied receipt
   ▼
ChatGPT list/get receipt + read_file/git_diff
   ▼
verified
```

This is the preferred expected V1 fallback UX when direct host-confirmed writes are unavailable.

### Probe A blocked + Probe B blocked

```text
ChatGPT
   │
   │ unified diff
   ▼
manual compatibility import
   │
   └── c2c patch / --file / --stdin
   ▼
CLI → broker /admin → pending request
   ▼
c2c approve
   ▼
same WriteRequestService
   ▼
verified through normal MCP reads
```

This path is compatibility-only and is implemented because Probe B is blocked.

The key architectural rule remains:

```text
one exclusively-owned broker write domain
+
multiple capability-gated approval/transport frontends
```

All shipped paths share the same security policy, bounded source handling, stale checks, external-writer limitations, receipt semantics and mandatory post-apply verification.
