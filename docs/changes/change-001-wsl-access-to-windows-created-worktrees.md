# CHANGE-001: WSL Access to Windows-Created Linked Worktrees

- **Status:** Completed
- **Date:** 2026-09-23
- **Scope:** `chat-to-codex`
- **Related:** `SPEC-001: Worktree-Aware Workspace Access`
- **Primary areas:** `src/workspace/worktrees.ts`, `src/workspace/git.ts`, `src/mcp/server.ts`, worktree/Git/MCP tests

## 1. Summary

C2C currently omits linked worktrees that Git marks `prunable`.

That is correct for genuinely missing worktrees, but it creates a false negative when:

1. C2C runs inside WSL,
2. the registered main repository is in WSL,
3. a linked worktree was created by Windows Git/Codex,
4. Git metadata contains Windows/UNC paths,
5. the worktree files are nevertheless reachable from WSL.

Support this case without changing the worktree on disk.

The implementation MUST keep the existing fail-closed repository-identity checks and MUST NOT blindly expose every `prunable` worktree.

The minimal model is:

- normal worktrees keep the current path,
- when normal candidate resolution fails under WSL, C2C may resolve the Windows path into a local WSL path,
- when the linked worktree `.git` pointer references the same WSL repository through a Windows UNC form, C2C may resolve it to the local Git administrative directory,
- validated cross-namespace worktrees carry the existing internal `GitTarget` with optional `gitDir`,
- filesystem operations use the validated worktree root,
- Git operations use the validated `gitDir + workTree` context,
- no filesystem paths are exposed through MCP.

## 2. Problem

A Windows-created linked worktree can be omitted from `list_worktrees`:

```text
C:/Users/<user>/.codex/worktrees/<worktree-name>/<repo>
<commit> [<branch>] prunable
```

From WSL, the same working tree exists and is readable at the mounted Windows path.

Its `.git` file contains a Windows-compatible UNC reference to the WSL repository:

```text
gitdir: //wsl$/<distro>/home/<user>/projects/<repo>/.git/worktrees/<worktree-name>
```

A normal WSL Git call fails:

```text
git -C /mnt/c/Users/<user>/.codex/worktrees/<worktree-name>/<repo> status

fatal: not a git repository:
 //wsl$/<distro>/home/<user>/projects/<repo>/.git/worktrees/<worktree-name>
```

The same working tree is valid when WSL Git receives the equivalent local `--git-dir` and `--work-tree` arguments explicitly:

```text
git \
  --git-dir=/home/<user>/projects/<repo>/.git/worktrees/<worktree-name> \
  --work-tree=/mnt/c/Users/<user>/.codex/worktrees/<worktree-name>/<repo> \
  status
```

Observed result:

```text
On branch <branch>
nothing to commit, working tree clean
```

`rev-parse --show-toplevel` with the same explicit context returns the mounted worktree root.

Therefore the worktree is not empty or lost. It is unavailable only through the implicit cross-platform Git path representation.

## 3. Current behavior

`src/workspace/worktrees.ts` currently rejects `prunable` records before candidate validation:

```ts
if (record.bare || record.prunable || !record.commit) return null;
```

This occurs in both candidate validation and worktree-id resolution.

Git helpers in `src/workspace/git.ts` then assume that `cwd = worktreeRoot` is sufficient:

```ts
spawnSync("git", args, {
  cwd: root,
  ...
});
```

That assumption is false for the Windows-created / WSL-accessed case above.

`SPEC-001` also explicitly defines:

- Windows ↔ WSL path translation as a non-goal,
- `prunable` worktrees as ineligible,
- incompatible path namespaces as unavailable.

This change intentionally narrows those rules.

## 4. Goals

1. Make a live Windows-created linked worktree usable through a WSL-hosted C2C installation when both its working tree and Git administrative metadata can be safely resolved locally.
2. Keep `list_worktrees` opaque: return only `worktree_id`, branch and commit.
3. Preserve the current behavior for ordinary Linux, WSL-native and native-Windows worktrees.
4. Preserve repository ownership and identity validation.
5. Keep the implementation stateless and read-only.
6. Require no manual repair, recreation or migration of the user's worktree.
7. Avoid modifying `.git` files or Git worktree metadata.

## 5. Non-goals

This change does not add:

- worktree creation, repair, move, prune, lock or unlock,
- rewriting of linked-worktree `.git` files,
- rewriting of main-repository worktree metadata,
- a persistent worktree registry,
- a worktree cache or watcher,
- a new MCP tool or argument,
- Windows Git execution from WSL,
- generic arbitrary path translation,
- support for foreign repositories,
- support for unreachable or genuinely stale worktrees,
- automatic repair of malformed Git metadata,
- changing `c2c use`, `c2c setup` or `c2c doctor` when those commands are launched directly from a cross-namespace Windows-created worktree,
- migration, aliasing or reconciliation of conversation, plan or execution-record state written under another path namespace.

This change is intentionally limited to making such a worktree available as a derived target of an already registered WSL main workspace through the installation broker/MCP path.

## 6. Design

### 6.1 Keep the normal path as the fast path

For every candidate, first use the existing behavior.

If the root canonicalizes and the existing Git checks succeed, no cross-platform fallback is involved.

This keeps current Linux, WSL-native and native-Windows behavior unchanged.

### 6.2 `prunable` is not an automatic rejection under the fallback

`prunable` remains a useful Git signal but is not sufficient by itself to declare a candidate unavailable.

A `prunable` candidate MAY proceed only through the WSL cross-namespace fallback defined below.

A candidate still fails closed if the translated working tree or Git administrative directory cannot be resolved and validated.

Do not change this into "include all prunable worktrees."

### 6.3 Detect WSL narrowly

Cross-namespace fallback is available only when C2C is running on Linux under WSL.

Use existing runtime/environment information where available. A minimal check may use:

- `process.platform === "linux"`, and
- `WSL_DISTRO_NAME` or another already-established WSL indicator.

Do not enable Windows-path translation on generic Linux hosts.

### 6.4 Resolve the working-tree path

When the Git porcelain root cannot be canonicalized normally and is a Windows drive path, resolve it into the local WSL namespace.

Example:

```text
C:/Users/<user>/.codex/worktrees/example/repo
→
/mnt/c/Users/<user>/.codex/worktrees/example/repo
```

Do not hard-code `/mnt/<drive>` as the only supported WSL mount layout.

Prefer the host's WSL path conversion mechanism for Windows drive paths, then canonicalize the result with the existing filesystem checks.

If conversion is unavailable or fails, reject the candidate.

The existing SPEC-001 verification harness already demonstrates the narrow `C:/...` → WSL-path normalization concept. Production code may use the same constrained idea, but MUST NOT depend on verification-artifact code or introduce a generic path-conversion framework.

### 6.5 Resolve the linked-worktree Git directory

After resolving the working-tree root, inspect its `.git` file only as part of candidate validation.

For the supported cross-namespace case it may contain a UNC WSL reference such as:

```text
gitdir: //wsl$/Ubuntu/home/<user>/projects/repo/.git/worktrees/repo
```

or the equivalent backslash form.

C2C MAY map this to a local POSIX path only when:

1. `<workTree>/.git` is a regular file,
2. it contains the expected `gitdir:` pointer form,
3. the reference is a WSL UNC path,
4. its distro component matches the current WSL distro,
5. the resulting path canonicalizes,
6. the resulting Git administrative directory belongs to the registered main repository.

The translated pointer is not trusted merely because it exists. The fallback MUST prove both repository identity and the exact pairing between the selected working tree and its linked-worktree administrative directory.

First validate the explicit Git target:

```text
git --git-dir=<gitDir> --work-tree=<workTree> rev-parse --show-toplevel
git --git-dir=<gitDir> --work-tree=<workTree> rev-parse --git-common-dir
```

After canonicalization:

- `--show-toplevel` MUST equal the resolved `workTree`,
- `--git-common-dir` MUST equal the registered main repository identity,
- `gitDir` MUST resolve inside the registered repository's linked-worktree administrative area (normally `<repositoryIdentity>/worktrees/*`).

Then validate the linked-worktree reverse pointer:

```text
<gitDir>/gitdir
```

The reverse pointer MUST resolve, after the same supported Windows/WSL normalization rules, to exactly:

```text
<workTree>/.git
```

This reverse check is required because an explicit `--work-tree` can otherwise make Git accept the administrative metadata of worktree A together with the files of worktree B from the same repository, producing the wrong branch, index or diff.

Example:

```text
//wsl$/Ubuntu/home/<user>/projects/repo/.git/worktrees/repo
→
/home/<user>/projects/repo/.git/worktrees/repo
```

A UNC reference to another distro MUST be rejected.

Other arbitrary UNC/network paths MUST NOT be translated.

### 6.6 Internal Git target

Use the existing `GitTarget` concept as the single internal representation. Extend it minimally with optional `gitDir` support instead of introducing a parallel `GitContext` type.

A compatible shape is:

```ts
type GitTarget = string | {
  root: string;
  ignoreRules?: IgnoreRules;
  gitDir?: string;
};
```

For normal worktrees `gitDir` is absent and current behavior remains unchanged.

For a cross-namespace worktree:

```text
root   = canonical mounted Windows worktree root
gitDir = canonical local WSL linked-worktree Git directory
```

This target is internal only and MUST NOT be serialized through MCP.

Do not add another persistent entity or alternate `workTree` naming model.

### 6.7 Git execution

Git helpers must support the validated `GitTarget`.

Normal target:

```text
git <args>
cwd = workTree
```

Cross-namespace target:

```text
git --git-dir=<gitDir> --work-tree=<workTree> <args>
cwd = workTree
```

Continue sanitizing inherited Git repository-location environment variables.

Do not set client-controlled `GIT_DIR` or `GIT_WORK_TREE` environment variables.

An explicit `gitDir` on `GitTarget` must originate only from C2C's validated resolver.

### 6.8 Filesystem operations

`Workspace` continues to use the canonical resolved working-tree root.

Therefore these operations require no Git-specific behavior change:

- `read_file`,
- `list_directory`,
- workspace search,
- ignore-rule and path-boundary checks.

Do not make `Workspace` responsible for translating Git metadata.

### 6.9 MCP target resolution

When an MCP call selects a derived worktree:

1. enumerate the current machine-readable worktree records,
2. resolve only enough path information to compute candidate IDs and match the requested opaque `worktree_id`,
3. fully validate only the selected candidate,
4. obtain its validated worktree root and optional `gitDir`,
5. construct `Workspace` from the validated root,
6. perform the existing final current/repository-identity and reverse-pairing validation immediately before use,
7. pass the selected `GitTarget` only to Git-backed operations.

Do not fully validate unrelated sibling worktrees on a selected tool call.

Calls without a `worktree` argument remain behaviorally unchanged.

This change does not make `resolveLocalWorktree()` discover the same cross-namespace target when C2C CLI commands are launched directly from that Windows-created worktree. That is a separate local-target concern and is deliberately outside this change.

### 6.10 Repository identity

Cross-namespace resolution MUST preserve the existing repository-identity boundary.

At minimum verify that:

1. the canonical main root is still the registered main workspace,
2. the translated worktree root exists and is a directory,
3. `<workTree>/.git` is a regular pointer file for the supported fallback shape,
4. the canonical translated `gitDir` is inside the registered repository's linked-worktree administrative area,
5. the explicit Git target reports the translated root as its toplevel,
6. the explicit Git target reports the same canonical common Git directory as the registered main workspace,
7. `<gitDir>/gitdir`, after the same supported normalization, points back to exactly `<workTree>/.git`,
8. final selected-worktree validation repeats the relevant identity and pairing checks immediately before use.

A translated path that merely exists is not sufficient.

`worktree_id` MAY be computed before full candidate validation for internal comparison and cheap candidate preselection. Computing an ID does not authorize or expose the candidate. A worktree may be returned or used only after the selected candidate has passed all validation above.

## 7. Minimal implementation shape

Prefer extending the existing primitives instead of introducing a parallel subsystem.

Expected touch points:

### `src/workspace/worktrees.ts`

- stop treating `prunable` as an unconditional early rejection for the supported WSL fallback,
- resolve the candidate working-tree root,
- resolve and validate the linked `gitDir`,
- validate `<gitDir>/gitdir` points back to the selected `<workTree>/.git`,
- return the optional `gitDir` as part of the existing internal target shape,
- preserve the selected-call flow: candidate ID preselection first, then full validation of only the selected candidate,
- use the same normalization/validation primitives for discovery, selected resolution and final validation,
- keep the existing injectable worktree/Git runner path testable; do not bypass it with an unmockable one-off process call for the fallback.

Keep one canonical resolver path; do not duplicate translation rules across functions.

### `src/workspace/git.ts`

- allow Git execution against an optional validated `gitDir + root`,
- preserve the existing simple `cwd` behavior when no explicit `gitDir` is required,
- extend the existing `GitTarget` shape rather than replacing it with a parallel abstraction,
- preserve `Workspace.ignoreRules` when `gitDiff` receives an explicit `GitTarget`,
- make `gitInfo`, `gitStatus`, `gitDiff` and repository-validation calls use the same execution primitive.

A minimal compatible target can remain structurally equivalent to:

```ts
type GitTarget = string | {
  root: string;
  ignoreRules?: IgnoreRules;
  gitDir?: string;
};
```

`gitDir` must be populated only from the validated worktree resolver. `gitDiff` must continue using the selected workspace's ignore/sensitive-file rules exactly as it does today.

Do not introduce a second `GitContext` or `workTree`-named target type alongside `GitTarget`.

Avoid a broad Git abstraction rewrite.

### `src/mcp/server.ts`

- keep `Workspace` rooted at the canonical working-tree directory,
- retain the selected `GitTarget` with optional validated `gitDir`,
- use that target only for Git-backed MCP operations.

No MCP schema change is required.

## 8. Tests

### 8.1 Unit tests

Add focused coverage for:

1. normal Linux linked worktree remains unchanged,
2. normal detached worktree remains valid,
3. normal locked worktree remains valid,
4. genuinely missing `prunable` worktree remains excluded,
5. Windows drive root under WSL resolves to an existing local worktree,
6. Windows drive root whose WSL target does not exist remains excluded,
7. supported current-distro `//wsl$/...` `.git` pointer resolves to local POSIX `gitDir`,
8. backslash WSL UNC form resolves equivalently,
9. UNC reference to a different WSL distro is rejected,
10. arbitrary network UNC reference is rejected,
11. translated candidate with a foreign repository identity is rejected,
12. selected-worktree resolution does not validate unrelated siblings,
13. final selected-worktree validation fails closed if the root or repository identity changes,
14. `.git` is not a regular pointer file → fallback rejected,
15. translated `gitDir` outside `<repositoryIdentity>/worktrees/*` → fallback rejected,
16. explicit `--show-toplevel` or `--git-common-dir` identity mismatch → fallback rejected,
17. worktree A files paired with worktree B `gitDir` from the same repository → rejected by `<gitDir>/gitdir` reverse-pointer validation,
18. selected call may compute IDs for siblings but performs full identity/pairing validation only for the requested candidate.

### 8.2 Git helper tests

Cover both execution modes:

```text
normal:
cwd only

cross-namespace:
--git-dir + --work-tree
```

Verify inherited repository-location environment variables remain sanitized.

Also verify that explicit-target `gitDiff` preserves the same sensitive-file filtering and ignore rules as the existing `Workspace` target path.

Add one focused regression proving that `--show-toplevel` and `--git-common-dir` alone are insufficient: pair worktree A's files with worktree B's `gitDir` from the same repository and require the reverse-pointer check to reject it.

### 8.3 MCP regression tests

For a derived cross-namespace target, verify:

- `list_worktrees`,
- `workspace_info`,
- `read_file`,
- `search_workspace`,
- `git_status`,
- `git_diff`,
- `test_status`,
- `execution_summary`.

For `test_status` and `execution_summary`, acceptance concerns successful worktree selection. Existing per-root execution records are not migrated or reconciled across Windows/WSL path namespaces; returning the existing "no records" result is valid when no record exists for the resolved root key.

Verify MCP output never contains the local worktree root or Git administrative directory.

## 9. Project-local acceptance

Use the real temporary linked-worktree fixture in `tests/mcp-worktrees.test.ts` as the acceptance case. It rewrites the fixture's pointers into Windows/WSL forms and exercises the broker through an in-memory MCP client; no external project or worktree is required.

Verify:

1. `list_worktrees` returns the cross-namespace worktree with an opaque `worktree_id`,
2. no filesystem path is returned,
3. `workspace_info` succeeds for that id,
4. `read_file` succeeds for that id,
5. `search_workspace` succeeds for that id,
6. `git_status` succeeds for that id,
7. `git_diff` succeeds for that id,
8. `test_status` accepts that id without `UNKNOWN_WORKTREE`,
9. `execution_summary` accepts that id without `UNKNOWN_WORKTREE`.

`test_status` / `execution_summary` do not require path-namespace state migration; an empty/no-record response is acceptable.


## 10. Documentation synchronization

Update the canonical `SPEC-001` in the same change.

At minimum revise:

- **Non-goals:** remove the blanket prohibition on Windows ↔ WSL path translation,
- **Eligible derived worktree:** replace "must not be prunable" with validated availability semantics,
- **Portability / WSL:** define the narrow cross-namespace fallback,
- **No translation layer:** replace the absolute prohibition with the constrained translation contract,
- **Acceptance criteria:** replace "No Windows/WSL path translation layer is introduced",
- **Explicit V1 decisions:** replace both "no Windows/WSL path conversion" and unconditional "prunable worktrees are omitted."

Do not broaden SPEC-001 beyond what CHANGE-001 implements.

## 11. Acceptance criteria

### AC-001-1 — Existing behavior is preserved

Ordinary eligible worktrees continue to resolve with the current path and API behavior.

### AC-001-2 — Windows-created WSL-accessible worktree is discoverable

A Windows-created linked worktree whose files and Git administrative directory can be safely resolved in the current WSL distro is returned by `list_worktrees`, even if Git's porcelain record is marked `prunable`.

### AC-001-3 — `prunable` alone never grants access

A candidate that is genuinely unavailable or fails identity validation remains omitted.

### AC-001-4 — Full MCP read surface works

The validated cross-namespace worktree works through `workspace_info`, file read/search tools, `git_status`, `git_diff`, `test_status` and `execution_summary`.

`test_status` and `execution_summary` are required to resolve the selected worktree correctly; this change does not migrate or merge existing per-root execution state across path namespaces.

### AC-001-5 — Repository boundary and exact worktree pairing are preserved

A translated candidate from another repository, another WSL distro or an arbitrary UNC location is rejected.

A working tree paired with a different linked-worktree `gitDir` from the same repository is also rejected by validating `<gitDir>/gitdir` back to the selected `<workTree>/.git`.

### AC-001-6 — No worktree mutation

C2C does not modify `.git`, worktree metadata, branches or working-tree contents.

### AC-001-7 — No path leakage

MCP responses continue to expose only opaque worktree ids and existing public metadata.

### AC-001-8 — No persistent model expansion

No new registry, cache, watcher, session schema or MCP schema is introduced.

The implementation uses the existing `GitTarget` concept with optional `gitDir`; no parallel `GitContext` model is added.

### AC-001-9 — ID preselection remains cheap

`worktree_id` may be computed before full candidate validation for internal matching.

A selected MCP call MUST fully validate only the matched candidate plus its final pre-use recheck; unrelated siblings are not fully validated merely to locate the requested ID.

Computing an ID never authorizes or exposes an unvalidated candidate.

### AC-001-10 — Local CLI scope stays unchanged

Launching `c2c use`, `c2c setup` or `c2c doctor` directly from the cross-namespace Windows-created worktree is not required to work as part of CHANGE-001.

No duplicate registration or local-target behavior should be introduced accidentally.

### AC-001-11 — SPEC-001 matches implementation

The conflicting portability and `prunable` rules in SPEC-001 are updated in the same change.

### AC-001-12 — Verification passes

At minimum:

```bash
pnpm test
pnpm typecheck
pnpm build
```

plus the project-local broker/MCP acceptance described above.

## 12. Rollback

The change is code-only and does not migrate persistent state or mutate worktrees.

Rollback is therefore the normal code rollback.

After rollback, cross-namespace worktrees return to being unavailable through C2C; their on-disk state remains untouched.

## 13. Implementation principle

Keep this as a compatibility adapter at the C2C boundary:

```text
Git metadata in Windows namespace
          ↓
narrow WSL resolver
          ↓
canonical root + validated gitDir
          ↓
existing Workspace / GitTarget / MCP behavior
```

Do not make users recreate valid worktrees solely because C2C and Codex are operating through different path namespaces.

## 14. Execution ledger

- **Owner outcome:** Make Windows-created, WSL-accessible linked worktrees available through the existing read-only broker/MCP surface without mutating worktree metadata, weakening repository identity checks, or exposing local paths.
- **Work state:** `docs/verification/artifacts/change-001/work-state.json`
- **Dirty-path manifest:** `docs/verification/artifacts/change-001/task-ownership.json`
- **Slices:** `S1-wsl-domain` (completed), `S2-broker-routing` (completed), `S3-spec-alignment` (completed), `S4-gates-live-closeout` (completed).
- **Repository gates:** Full tests, typecheck, build, and task-scoped diff hygiene passed. The aggregate diff check remains blocked by pre-existing trailing whitespace in `tests/oauth.test.ts`, which is outside this change's ownership.
- **Post-fix evidence:** The tightened current-distro UNC pointer contract and regression coverage passed in `docs/verification/artifacts/change-001/s4-pointer-contract/summary.json`; the final closeout gate passed in `docs/verification/artifacts/change-001/s4-closeout-final/summary.json`.
- **Project-local acceptance:** Passed through the in-memory broker/MCP coverage in `tests/mcp-worktrees.test.ts` and the complete recheck above. The earlier external example was unrelated copy-forward text and is not part of this project.
- **Dirty-path note:** The manifest-listed pre-existing generated file `work/bin/c2ct.js` was absent at final reconciliation and was not recreated without a trusted original snapshot; see `docs/verification/artifacts/change-001/dirty-reconciliation.json`.
