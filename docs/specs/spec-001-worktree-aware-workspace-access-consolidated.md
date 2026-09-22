# SPEC-001 — Worktree-aware workspace access

**Status:** Completed  
**Date:** 2026-09-21  
**Target branch:** `feat/worktree-support`  
**Review baseline:** HEAD `8712e95`  
**Scope:** Installation-broker worktree support, minimum CLI integration, Git hardening, Skill/docs updates  
**Related canonical docs:** `docs/architecture.md`, `docs/security.md`, `docs/multi-workspace.md`, `docs/local-e2e.md`, `skill/SKILL.md`

## 1. Summary

C2C currently treats each registered filesystem root as one workspace capability.

Git linked worktrees are separate filesystem roots, so a repository using worktrees currently has two undesirable options:

1. register every worktree as a separate C2C workspace, or
2. let the remote MCP client inspect only the one explicitly registered root.

This spec adds first-class, read-only Git worktree access to the installation broker while keeping the security model explicit and small.

The core model is:

```text
C2C installation
└── explicitly registered MAIN Git worktree
    ├── main worktree
    ├── linked worktree A
    ├── linked worktree B
    └── linked worktree C
```

The registered main worktree is the durable authorization anchor.

Linked worktrees are derived read targets:

- discovered dynamically from Git,
- addressed by opaque `worktree` IDs,
- never persisted in a worktree registry,
- never exposed by filesystem path through MCP,
- never given a new server-side session model.

An explicitly registered linked worktree remains valid as its own exact-root capability, but it does **not** authorize access to sibling worktrees.

The feature is broker-first. The legacy per-project bridge remains exact-root-only.

## 2. Terminology

This spec uses provider-neutral runtime terminology.

### C2C

The broker, MCP transport, authorization layer and local capability resolver.

### Codex

The local executor.

Codex owns:

- file mutation,
- shell commands,
- Git mutation,
- tests,
- local execution records,
- local Codex session lifecycle.

### MCP client / chat client

A remote read-only client connected to C2C.

It may be ChatGPT, Claude or another compatible MCP client.

The worktree model MUST NOT depend on one specific provider.

### Registered workspace

A durable `WorkspaceRegistry` entry with:

```text
id
displayName
canonicalRoot
registeredAt
updatedAt
```

### Registered main workspace

A registered workspace whose canonical root is Git's main worktree for that repository.

Only this registration may authorize derived sibling worktrees.

### Explicit linked-worktree registration

A linked worktree that was itself directly registered with C2C.

It remains an exact-root capability only.

### Derived worktree

A linked worktree dynamically discovered beneath a registered main workspace.

### Worktree ID

An opaque deterministic identifier for one derived worktree.

### Root key

The existing internal `Workspace.id` derived from one concrete filesystem root.

The current code historically calls this a workspace id in some local state paths.

For new worktree code and documentation, treat it conceptually as a `rootKey` to avoid confusing it with the durable registry `workspaceId`.

## 3. Existing code constraints

The current implementation establishes several contracts that this spec must preserve.

### 3.1 Registry is the durable capability boundary

`WorkspaceRegistry` stores canonical local roots.

Remote MCP clients can address only opaque registry IDs.

Remote MCP clients cannot:

- register roots,
- nominate filesystem paths,
- create sessions,
- mutate the registry.

### 3.2 Workspace path containment is already hardened

`Workspace`:

- canonicalizes its root with `realpath`,
- canonicalizes requested paths,
- rejects traversal,
- rejects symlink escape,
- applies sensitive-file filtering,
- loads `.c2cignore` relative to the selected root.

This implementation should be reused for derived worktrees.

### 3.3 Git reads are centralized

`src/workspace/git.ts` owns the current Git read helpers:

- `runGit`
- `gitInfo`
- `gitStatus`
- `gitDiff`

Worktree support must reuse or extend this layer instead of introducing a second Git execution mechanism.

### 3.4 SessionRegistry is parent-workspace scoped

`SessionRegistry` stores:

```text
sessionId → workspaceId
```

It already permits multiple concurrent sessions for the same registered workspace.

No worktree-specific server session schema is required.

### 3.5 Local state is already concrete-root scoped

The following local state already uses the concrete root's internal `Workspace.id`:

- local session binding filename,
- saved conversation state,
- plan records,
- execution records.

This is desirable for parallel worktrees and should remain unchanged.

### 3.6 Current Skill calls `c2c use`

The Codex Skill instructs Codex to run:

```text
c2c use --json
```

when a project session starts.

Therefore MCP-only worktree support would be incomplete: `c2c use` must avoid registering a covered linked worktree as a duplicate workspace.

### 3.7 Doctor can currently register roots

`c2c doctor --fix` checks registration by exact canonical root and may POST the current root to `/admin/workspace`.

Doctor must use the same local target resolver as `c2c use`.

## 4. Goals

1. Let the installation broker discover linked Git worktrees under an explicitly registered main worktree.
2. Let existing read-only broker MCP tools target a derived worktree by opaque ID.
3. Keep registry authorization explicit and local.
4. Prevent a remotely supplied path from becoming a filesystem capability.
5. Prevent registration of an arbitrary linked worktree from automatically granting peer-worktree access.
6. Avoid duplicate registrations when Codex runs inside a linked worktree whose main worktree is already registered.
7. Preserve exact-root registrations when they already exist.
8. Preserve local per-root plan, conversation and execution state.
9. Keep the feature additive for existing broker callers.
10. Keep the legacy per-project bridge exact-root-only.
11. Add no persistent worktree registry.
12. Add no new server-side worktree session model.
13. Add no MCP mutation or execution capability.
14. Keep the implementation small enough to reuse existing workspace, Git, session and state primitives.
15. Harden Git discovery so inherited environment variables cannot redirect repository resolution.

## 5. Non-goals

This spec does not add:

- worktree creation,
- worktree deletion,
- worktree move,
- worktree prune,
- worktree lock/unlock,
- automatic migration of existing duplicate workspace registrations,
- automatic removal of old worktree registrations,
- a persistent `worktrees.json`,
- worktree ACLs,
- per-worktree OAuth scopes,
- worktree-specific server sessions,
- MCP writes,
- MCP shell execution,
- Git mutation,
- generic provider renaming across the whole repository,
- Windows ↔ WSL path translation,
- bare-repository worktree ownership,
- worktree support to the legacy per-project bridge.

## 6. Authorization model

### 6.1 Main worktree is the only derived-worktree owner

A registered main worktree may authorize its current linked worktrees.

```text
registered MAIN
├── exact main root
├── derived linked A
├── derived linked B
└── derived linked C
```

A registered linked worktree does not authorize peers.

```text
registered LINKED B
└── exact linked B only
```

This prevents an explicitly authorized temporary branch root from silently expanding into repository-wide filesystem access.

### 6.2 Exact registration always wins

If the current local root is already an exact registry entry, C2C uses that exact registration.

This remains true even when the same root could also be reached as a derived worktree beneath a registered main workspace.

No automatic migration or deduplication occurs in V1.

### 6.3 Main-worktree detection uses Git as SSOT

The implementation MUST NOT add a persistent `isMainWorktree` registry flag.

Use Git's own worktree model.

Preferred mechanism:

```bash
git worktree list --porcelain -z
```

For one repository, the first worktree record is the main worktree.

A root may act as a derived-worktree owner only when its canonical path equals the canonical first worktree record and the record is not bare.

### 6.4 Registered subdirectories do not gain worktree access

A workspace may currently be registered below a Git repository toplevel.

Example:

```text
/repo/packages/app
```

Such a registration remains scoped to that subtree.

It MUST NOT gain peer-worktree discovery.

The registered root must itself equal the Git worktree toplevel before it can be a worktree owner.

## 7. Git hardening

### 7.1 Problem

Current `runGit()` inherits `process.env`.

Git repository-location environment variables can override repository discovery independently of `cwd`, including variables such as:

- `GIT_DIR`
- `GIT_WORK_TREE`
- `GIT_COMMON_DIR`
- `GIT_INDEX_FILE`
- object-directory overrides

For normal read commands this is already undesirable.

For worktree discovery it is security-sensitive because Git output is used to derive additional filesystem capability.

### 7.2 Requirement

Workspace Git discovery MUST use a sanitized environment where repository-location overrides cannot redirect Git away from the chosen root.

The implementation SHOULD centralize this hardening in the existing Git execution layer rather than create a worktree-only runner.

Do not attempt to isolate every Git configuration variable in V1.

The goal is:

```text
C2C selects cwd/root
→ Git discovers the repository from that root
→ inherited repository-location overrides cannot retarget it
```

### 7.3 Do not expose raw Git errors

Git stderr and unexpected error messages may contain local paths.

Worktree discovery/validation errors exposed through MCP MUST use typed, sanitized error codes.

Raw errors may be logged locally.

They MUST NOT be returned through generic `INTERNAL_ERROR` messages containing the original `error.message`.

## 8. Worktree discovery

### 8.1 Source of truth

Prefer:

```bash
git worktree list --porcelain -z
```

Some supported Git versions do not implement `-z` for `worktree list`.
In that case, retry with:

```bash
git worktree list --porcelain
```

Both forms are machine-readable porcelain output. Do not parse the default
human-readable output. If both forms fail, worktree discovery is unavailable.

### 8.2 Eligible derived worktree

A candidate is eligible only when all of these are true:

1. it comes from the registered main workspace's current Git worktree list,
2. it is not the main record when resolving a derived worktree,
3. it is not bare,
4. it is not marked prunable,
5. its root exists,
6. its root canonicalizes successfully,
7. its canonical root equals its own Git toplevel,
8. its canonical Git common directory equals the main workspace repository identity.

### 8.3 Locked worktrees

A locked worktree remains readable if all validation checks pass.

`locked` does not need to be exposed through the V1 MCP API.

### 8.4 Detached worktrees

Detached worktrees are valid derived targets.

Represent them with:

```text
branch = null
```

No separate `detached` field is required in V1.

### 8.5 Bare repository

A bare registration is never a derived-worktree owner in V1.

No special bare-owner model is introduced.

## 9. Repository identity

Use the canonical Git common directory as internal repository identity.

It is used only to verify that:

```text
selected candidate
belongs to
the same repository as
the registered main workspace
```

Repository identity MUST remain local-only.

It MUST NOT be returned through MCP.

## 10. Worktree identity

Derived worktrees receive deterministic opaque IDs.

Recommended shape:

```text
wt-<16 hex chars>
```

Recommended derivation:

```text
sha256(repositoryIdentity + "\0" + canonicalWorktreeRoot)
```

Requirements:

- deterministic while the worktree remains at the same canonical path,
- independent of branch name,
- changes when the worktree moves,
- non-reversible to a filesystem path,
- repository-scoped through the repository identity input.

Branch names MUST NOT be selectors.

A worktree ID is an address, not a secret.

## 11. Worktree domain helper

Add one focused domain helper, preferably:

```text
src/workspace/worktrees.ts
```

Responsibilities:

- parse `git worktree list --porcelain -z`,
- determine the main worktree,
- resolve canonical repository identity,
- derive opaque worktree IDs,
- discover sanitized derived-worktree metadata,
- resolve one worktree ID,
- validate the selected candidate,
- determine whether a concrete local root is a linked worktree of a given main root,
- determine the current local root's main worktree.

It MUST NOT:

- mutate the registry,
- create sessions,
- persist worktrees,
- expose filesystem paths through MCP.

## 12. New broker MCP tool: `list_worktrees`

### 12.1 Availability

`list_worktrees` exists only in installation broker mode.

The legacy per-project bridge does not expose this tool.

### 12.2 Input

```text
list_worktrees(workspace?)
```

`workspace` follows the existing broker semantics:

- required when multiple workspaces are registered,
- optional when exactly one registration is unambiguous.

### 12.3 Scope

Required scope:

```text
git.read
```

### 12.4 Output

V1 response:

```json
{
  "worktrees": [
    {
      "worktree_id": "wt-9f8e7d6c5b4a3322",
      "branch": "feat/example",
      "commit": "5344e58b"
    }
  ]
}
```

Rules:

- derived worktrees only,
- no main-root entry,
- `branch` may be `null`,
- no `path`,
- no repository path,
- no `locked`,
- no `detached`,
- no lock reason,
- no Git administrative path.

### 12.5 Non-owner workspace

If the selected registered workspace is not an eligible main-worktree owner, return:

```json
{
  "worktrees": []
}
```

Do not add a special public `WORKTREE_SCOPE_UNAVAILABLE` error.

This keeps the API small and fail-closed.

## 13. Optional `worktree` selector on broker tools

Add:

```text
worktree?: string
```

to broker-mode schemas for:

| Tool | Existing required scope |
| --- | --- |
| `workspace_info` | `workspace.read` |
| `list_directory` | `workspace.read` |
| `read_file` | `workspace.read` |
| `search_workspace` | `workspace.search` |
| `git_status` | `git.read` |
| `git_diff` | `git.read` |
| `test_status` | `execution.read` |
| `execution_summary` | `execution.read` |

Supplying `worktree` does not require an additional `git.read` scope for non-Git tools.

The durable workspace capability remains the authorization anchor.

The worktree ID only selects a validated derived target.

## 14. Legacy bridge compatibility

The legacy per-project bridge remains exact-root-only.

It keeps its existing tool surface.

It does not expose `list_worktrees`.

If a future shared schema allows a `worktree` selector to reach legacy mode, the bridge MUST return an explicit sanitized error such as:

```text
WORKTREE_UNSUPPORTED
```

It MUST NOT silently ignore the selector.

This preserves the historical single-root OAuth/security boundary.

## 15. Broker target resolution

Broker resolution becomes:

```text
resolve durable workspace registration
        ↓
construct registered Workspace
        ↓
if no worktree:
    selected = registered root
else:
    require registered root to be eligible MAIN owner
    run current worktree discovery
    match opaque worktree ID
    construct canonical Workspace(candidate)
    validate selected candidate repository identity
    selected = candidate
        ↓
run existing primitive against selected
```

Requirements:

1. unknown registry IDs fail closed,
2. unknown worktree IDs fail closed,
3. moved/removed/stale worktree IDs fail closed,
4. selection failure never falls back to main root,
5. candidate paths are never accepted from the MCP client,
6. the registered workspace identity remains available independently of selected root.

## 16. Selected-root semantics

When `worktree` is supplied:

```text
workspace:/
```

means the selected derived worktree root for that tool call.

All existing `Workspace` containment and sensitive-file rules then apply relative to that selected root.

There is no cross-worktree virtual filesystem.

For example:

```text
../../other-worktree/file
```

must still fail containment.

## 17. `workspace_info`

Without `worktree`, behavior remains unchanged.

With `worktree`:

- `workspaceId` remains the parent durable registry ID,
- `workspaceName` remains the parent registered display name,
- `rootAlias` remains `workspace:/`,
- project detection runs against selected root,
- Git info runs against selected root,
- response adds `worktreeId`.

Example:

```json
{
  "workspaceId": "veterinar-af58c35d",
  "workspaceName": "veterinar",
  "worktreeId": "wt-9f8e7d6c5b4a3322",
  "rootAlias": "workspace:/",
  "git": {
    "isRepo": true,
    "branch": "feat/example",
    "commit": "5344e58b",
    "dirty": false
  }
}
```

Do not expose the selected root's internal `Workspace.id`.

## 18. Local target resolver

Add one read-only local helper used by:

- `c2c use`,
- `c2c setup`,
- `c2c doctor`.

Conceptually:

```text
currentRoot
   │
   ├─ exact registry match?
   │      └─ YES → exact registration
   │
   ├─ is currentRoot a linked worktree?
   │      │
   │      └─ determine its MAIN root
   │             │
   │             └─ is that MAIN root registered?
   │                    └─ YES → parent registration + derived worktreeId
   │
   └─ no target → unregistered
```

This resolver is read-only.

It MUST NOT:

- register roots,
- create sessions,
- heartbeat sessions,
- mutate local state.

This separation is required so `doctor --no-fix` remains genuinely non-mutating.

## 19. `c2c use`

### 19.1 Resolution

`c2c use` performs:

```text
resolve local target
→ if exact/derived target exists: use it
→ otherwise: register current root
→ ensure Codex session
```

### 19.2 Security behavior

If Codex is started inside a linked worktree and the main worktree is not registered:

- do not silently register the main worktree,
- register only the current linked root.

This preserves explicit authorization.

### 19.3 Exact registration precedence

If the linked root already has an explicit registry entry, that entry wins even if the main root is also registered.

No migration occurs.

### 19.4 `--name`

`--name` applies only when:

- refreshing an exact registration, or
- creating a new exact registration.

It MUST NOT silently rename a parent main workspace when the current root resolves as a derived worktree.

For V1, derived-target `--name` SHOULD fail with a concise actionable message rather than be ignored.

### 19.5 JSON output

Preserve existing output fields for compatibility.

Add optional:

```text
worktreeId
```

when the current root resolves as a derived worktree.

The existing local-only `root` field may remain unchanged.

The Codex Skill should not propagate the absolute root.

## 20. `c2c setup`

`setup` reuses the same local target resolution and session logic as `use`.

When run from a derived worktree beneath an already registered main workspace:

- no new workspace registration is created,
- returned `workspaceId` is the parent registration,
- returned `worktreeId` identifies the concrete worktree.

Human wording SHOULD use neutral status such as:

```text
Workspace ready
```

rather than always saying:

```text
Workspace registered
```

because registration may not have occurred.

## 21. `c2c doctor`

### 21.1 `doctor --no-fix`

Must be read-only with respect to:

- registry,
- session creation,
- session heartbeat,
- tunnel mutation,
- pairing mutation.

For registration state, use only the read-only local target resolver.

### 21.2 `doctor --fix`

May:

- register the current root when truly unregistered,
- reuse a parent registration for a covered derived worktree,
- ensure the Codex session.

It MUST NOT create a duplicate linked-worktree registration when the main owner is already registered.

## 22. Local session binding

Do not add `worktreeId` to `LocalSessionBinding`.

Current binding data remains sufficient:

```text
sessionId
workspaceId
refreshedAt
```

The binding file is already keyed by the current concrete root's internal `Workspace.id`.

This naturally isolates:

- main worktree session,
- linked A session,
- linked B session.

Heartbeat and `c2c use --end` continue to operate on the correct concrete root without a new schema.

## 23. Server-side Codex sessions

Do not change `SessionRegistry`.

A Codex session launched from a derived worktree is still bound to the parent durable `workspaceId`.

Multiple worktree sessions may therefore coexist under one parent workspace.

The existing session model already supports this.

If a worktree disappears without `c2c use --end`, the existing session TTL handles eventual cleanup.

Do not add a worktree watcher or cleanup daemon.

## 24. Local per-root state

Keep the following keyed by the current concrete root key:

### Conversation state

`c2c session get/set/clear`

A worktree SHOULD keep its own long-lived planning/review conversation.

Do not collapse conversations onto the parent registry workspace.

### Plan history

`c2c plan`

Plans remain per concrete root.

### Execution records

`c2c record`

Execution records remain per concrete root.

### Rationale

Parallel worktrees commonly represent independent feature/review tasks.

Sharing these local task histories across sibling worktrees would create context leakage and friction.

## 25. Execution MCP tools

When `test_status` or `execution_summary` selects a derived worktree, read records using:

```text
selectedWorkspace.id
```

This matches the root key used by `c2c record` inside that worktree.

No execution-record migration is required.

## 26. Performance model

### 26.1 No cross-request cache

V1 uses dynamic Git discovery.

Do not add:

- persistent cache,
- daemon cache,
- background refresh,
- invalidation machinery.

### 26.2 `list_worktrees`

May validate all discovered candidates because discovery explicitly asks for the list.

### 26.3 Selected tool call

A scoped call with one worktree SHOULD:

1. run one machine-readable worktree listing,
2. match the requested opaque ID,
3. canonicalize/construct the selected Workspace,
4. validate repository identity for that candidate only,
5. run the requested primitive.

Do not fully validate every sibling worktree on every `read_file`.

### 26.4 Existing Git command counts

Do not refactor `gitInfo`, `gitStatus` or `gitDiff` for micro-optimization as part of this feature unless implementation evidence shows a real problem.

No performance benchmark is required for V1.

## 27. Race behavior

A worktree may move or disappear between discovery and operation.

Required behavior:

- fail closed,
- no fallback to parent root,
- no fallback to another worktree,
- no reuse of a failed candidate.

The implementation SHOULD construct the canonical selected `Workspace` and perform final repository identity validation immediately before using it.

Do not introduce filesystem locks or file-descriptor-level capability pinning for V1.

The local operating user and Git process remain part of the trusted local control plane.

## 28. Portability

### 28.1 Native Windows

Use native Windows paths returned by Git and canonicalized by Node.

### 28.2 WSL

Use POSIX paths returned by Git inside WSL.

### 28.3 No translation layer

Do not translate:

```text
C:\...
↔
/mnt/c/...
```

If C2C and Git are operating in incompatible path namespaces and canonicalization fails, the worktree is unavailable.

Fail closed.

### 28.4 Path equality

Canonicalize both sides with `fs.realpathSync.native()` before equality checks.

Do not add speculative path normalization beyond what the current supported platform actually requires.

## 29. MCP errors

Add a typed worktree error class/domain mapping.

Minimum public errors:

### `UNKNOWN_WORKTREE`

The supplied opaque ID is not a current eligible derived worktree.

This covers:

- invented IDs,
- removed worktrees,
- moved worktrees,
- stale worktrees,
- candidates that fail final validation.

### `WORKTREE_UNSUPPORTED`

Used if a worktree selector reaches a context that does not support derived worktrees, especially the legacy bridge.

### Internal discovery failure

Return a generic sanitized error.

Never return raw Git stderr or filesystem paths.

Do not add `WORKTREE_SCOPE_UNAVAILABLE`; non-owner workspaces simply expose no derived worktrees.

## 30. Tool surface compatibility

### Broker mode

Current broker tools:

```text
9
```

After SPEC-001:

```text
10
```

New tool:

```text
list_worktrees
```

### Legacy bridge

Remains at:

```text
9
```

No `list_worktrees`.

No derived-worktree access.

This exact-count distinction should remain covered by tests because it protects the intended compatibility/security boundary.

## 31. Provider-neutral worktree documentation

New worktree code, tool descriptions and spec text SHOULD use:

```text
MCP client
remote MCP client
chat client
```

for the remote read-only consumer.

Use `Codex` only where referring to:

- local execution,
- local Codex session,
- Skill behavior,
- recorded execution results.

Do not make SPEC-001 a broad rename of the existing Claude-specific user-facing integration.

Existing provider-specific copy cleanup belongs in a follow-up change.

## 32. Implementation shape

### `src/workspace/git.ts`

- harden Git execution environment,
- keep Git process execution centralized.

### `src/workspace/worktrees.ts`

Add focused worktree domain logic:

- parser,
- main detection,
- repository identity,
- opaque IDs,
- discovery,
- selected candidate validation,
- current-root → main-root resolution.

### `src/mcp/server.ts`

- broker-only `list_worktrees`,
- optional `worktree` on broker readers,
- target resolution preserving parent registration + selected concrete Workspace,
- sanitized typed worktree errors.

Avoid duplicating read/search/Git implementations.

### `src/broker/daemon.ts`

- reuse local target resolution before registration,
- keep root-keyed binding files,
- no binding schema expansion,
- no SessionRegistry changes.

### `src/cli/index.ts`

- propagate optional `worktreeId`,
- update `use`,
- update `setup`,
- make doctor use read-only resolution,
- preserve pre-existing unrelated unstaged changes.

### `skill/SKILL.md`

When `c2c use --json` returns:

```text
workspaceId
worktreeId
```

Codex should tell the MCP client to address both.

The Skill must not ask to register the linked worktree independently when the main owner already covers it.

## 33. Tests

Keep the worktree suite focused on C2C invariants rather than exhaustively retesting Git itself.

### 33.1 Worktree domain

Cover:

1. main + linked discovery,
2. deterministic opaque ID,
3. detached worktree with `branch: null`,
4. prunable/missing candidate omitted,
5. linked root cannot own peers,
6. repository identity mismatch rejected,
7. canonical main detection.

### 33.2 Security

Cover:

1. inherited `GIT_DIR` cannot redirect discovery,
2. inherited `GIT_WORK_TREE` cannot redirect discovery,
3. MCP outputs do not expose candidate paths,
4. MCP errors do not expose candidate paths,
5. invented worktree ID fails closed,
6. stale/moved worktree ID fails closed,
7. traversal from selected worktree fails,
8. sensitive-file policy still applies.

### 33.3 Broker MCP

Cover:

1. broker exposes 10 read-only tools,
2. `list_worktrees` requires `git.read`,
3. selected `read_file`,
4. selected `search_workspace`,
5. selected `git_status`,
6. selected `git_diff`,
7. `workspace_info` preserves parent `workspaceId`,
8. selected execution record namespace,
9. no `worktree` preserves current behavior.

### 33.4 CLI lifecycle

Cover:

1. exact registration wins,
2. linked root + registered main → no duplicate registration,
3. linked root without registered main → exact linked root is registered,
4. derived `--name` does not rename parent,
5. `doctor --no-fix` does not mutate registration or sessions,
6. `doctor --fix` does not create duplicate linked registration,
7. `c2c use --end` still ends the concrete-root binding.

### 33.5 Legacy compatibility

Cover:

1. legacy bridge remains at 9 read-only tools,
2. no `list_worktrees`,
3. worktree selector is explicitly unsupported if presented,
4. existing exact-root behavior remains unchanged.

### 33.6 Regression gate

Before completion:

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 34. Documentation updates

### `docs/security.md`

Update the filesystem trust boundary from:

```text
registered canonical workspace root
```

to the more precise broker model:

```text
explicit registered root
+
validated derived worktrees only when the registration is the Git main worktree
```

Document:

- linked registration does not authorize peers,
- Git environment hardening,
- opaque worktree IDs,
- fail-closed stale target resolution,
- no remote paths.

### `docs/architecture.md`

Show:

```text
registered workspace
        ↓
optional derived worktree
        ↓
existing Workspace/read/search/Git primitives
```

### `docs/multi-workspace.md`

Clarify hierarchy:

```text
installation
└── registered workspace
    └── optional derived worktree target
```

### `docs/local-e2e.md`

Update:

- broker tool count 10,
- legacy count remains 9,
- main registration + linked-worktree workflow.

### `docs/protocol.md`

Change the semantic wording from one conversation per durable workspace to one conversation per concrete workspace target/worktree where practical.

### `skill/SKILL.md`

Make worktree propagation explicit and keep the remote-client wording provider-neutral where practical.

## 35. Acceptance criteria

SPEC-001 is conformant when all of the following are true:

1. Broker mode can enumerate current derived worktrees beneath a registered main workspace.
2. A registered linked worktree cannot enumerate or access peers through that registration.
3. `list_worktrees` requires `git.read`.
4. Worktree paths never appear in MCP responses.
5. Worktree paths never appear in MCP errors.
6. Existing broker readers can target a derived worktree by opaque ID.
7. Unknown/stale/moved/deleted IDs fail closed.
8. Selection failure never falls back to main.
9. Selected worktree containment and sensitive-file rules remain enforced.
10. Inherited Git repository-location environment variables cannot redirect discovery.
11. Calls without `worktree` remain behaviorally unchanged.
12. Legacy per-project bridge remains exact-root-only.
13. Legacy bridge tool count remains 9.
14. Broker tool count becomes 10.
15. `c2c use` from a linked worktree reuses a registered main owner instead of creating a duplicate.
16. `c2c use` from a linked worktree with no registered main registers only the current linked root.
17. Exact explicit registration always wins.
18. Derived `--name` cannot silently rename the main parent.
19. `c2c setup` reuses the same resolution model.
20. `doctor --no-fix` is non-mutating.
21. `doctor --fix` avoids duplicate linked registration.
22. Local session binding schema remains unchanged.
23. SessionRegistry schema remains unchanged.
24. Conversation state remains per concrete root.
25. Plan history remains per concrete root.
26. Execution records remain per concrete root.
27. `workspace_info` preserves the durable parent `workspaceId`.
28. No persistent worktree registry is introduced.
29. No background worktree watcher/cache is introduced.
30. No Windows/WSL path translation layer is introduced.
31. No MCP mutation or execution capability is introduced.
32. Worktree-specific code and docs use provider-neutral remote-client terminology.
33. Full tests, typecheck and build pass.
34. Canonical documentation is updated to match implemented behavior.
35. Pre-existing unrelated unstaged changes on the implementation branch are preserved.

## 36. Explicit V1 decisions

For V1:

- installation broker only,
- main worktree is the only derived-worktree owner,
- explicit linked registration is exact-root-only,
- Git is the source of truth,
- discovery prefers `git worktree list --porcelain -z` and falls back to
  `git worktree list --porcelain` when the NUL form is unsupported,
- no human-output parser fallback,
- Git repository-location environment overrides are sanitized,
- worktree IDs are opaque and deterministic,
- no path leaves the machine through MCP,
- no worktree registry,
- no worktree cache,
- no worktree watcher,
- no server-side worktree session entity,
- no binding schema change,
- no execution schema change,
- no conversation/plan migration,
- no duplicate-registration migration,
- no bare-owner support,
- no Windows/WSL path conversion,
- locked worktrees are readable when otherwise valid,
- detached worktrees are represented by `branch: null`,
- prunable worktrees are omitted,
- exact registration wins,
- `c2c use/setup/doctor` share one read-only local resolver,
- local task state remains concrete-root scoped,
- MCP authorization remains durable-workspace scoped,
- the feature remains fully read-only.

## 37. Closeout verification

The final SPEC-001 follow-up gates completed on 2026-09-22:

1. `tests/cli-doctor.test.ts` contains an explicit `doctor --fix` regression that starts the real CLI child process against an in-process broker and verifies that a linked worktree reuses its registered main without a duplicate registry entry.
2. A live linked-worktree run used Git `2.53.0.windows.3` and the required `worktree list --porcelain -z` contract. `doctor --fix` exited successfully, created one active session, and left the linked root unregistered as a separate workspace.
3. The WSL host Git `2.34.1` rejects `-z`; discovery retries the machine-readable `--porcelain` form and the focused live fallback test passes.
4. The connected ChatGPT C2C tool returned workspace `chat-to-codex-aa044b94` and `workspace_info` reported commit `cc7e78f`. The configured public endpoint `c2c-test.emky.space` returned HTTP 530 during the rerun, so no new public `list_worktrees` success is claimed. A clean-checkout OAuth/PKCE loopback MCP probe called `list_workspaces` and `list_worktrees` successfully, returning `wt-f29da4c99239d439`, `branch: null`, and commit `cc7e78f24b7f3850a2c21db7b90f8a7b28347734`; detailed evidence is retained in `docs/verification/artifacts/spec-001/s8-chatgpt-live/summary.json`.
