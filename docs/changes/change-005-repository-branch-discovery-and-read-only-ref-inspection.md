# CHANGE-005: Repository Branch Discovery and Read-Only Ref Inspection

- **Status:** Completed
- **Date:** 2026-10-02
- **Scope:** `chat-to-codex`
- **Related:** `SPEC-001 — Worktree-Aware Workspace Access`
- **Review evidence:** `docs/verification/artifacts/change-005/quality-gate/review-01.json`
- **Completion evidence:** [acceptance regressions and fresh broker OAuth smoke](../verification/artifacts/change-005/regression-closure-2026-10-03.json), [local merge closeout](../verification/artifacts/change-005/closeout/summary.json).
- **Separate rollout check:** Existing ChatGPT connector reauthorization/schema refresh and a call through that UI connector are owner-deferred. The required fresh broker-level OAuth → `list_branches` smoke is covered and passed; repository completion does not claim the existing UI connector is refreshed.
- **Primary areas:** `src/workspace/git-snapshot.ts` (new), `src/workspace/git.ts`, `src/workspaces/targets.ts`, `src/mcp/server.ts`, `src/auth/store.ts`, `src/auth/oauth.ts`, `src/broker/server.ts`, `src/bridge/server.ts`, `scripts/poc-client.mjs`, Git/MCP/OAuth tests, canonical docs

## 1. Summary

C2C can inspect the registered workspace root, validated linked worktrees, Git status, and working-tree/index diffs. It cannot inspect the repository ref namespace itself.

A local branch may therefore exist normally while remaining invisible to C2C unless that branch is represented by a visible worktree. `search_workspace` cannot compensate because it searches workspace files, not Git refs, and `.git/` is intentionally hidden.

This creates a concrete planning/review gap:

```text
user asks to inspect branch X
        ↓
branch X exists locally
        ↓
branch X has no visible linked worktree
        ↓
C2C cannot prove X exists
and cannot inspect its committed snapshot
```

CHANGE-005 adds bounded repository-level Git inspection without checkout, temporary worktrees, mutation, shell execution, network fetch, persistent state, or arbitrary revision parsing.

The installation broker gains four read-only tools:

```text
list_branches  → what local branch refs exist?
git_browse     → what file/tree content exists at one branch ref?
git_search     → where does content occur in one branch snapshot?
git_compare    → what changes did one branch introduce relative to another?
```

Repository-wide ref inspection is authorized only by an explicitly registered **main Git worktree**. An explicitly registered linked worktree remains an exact-root capability and does not gain peer-branch or repository-wide access.

The existing `git.read` scope is not broadened. A new `git.repository.read` scope protects the new capability so previously issued tokens do not silently gain access to committed content on other branches.

## 2. Classification

This is a **CHANGE**, not a new SPEC.

SPEC-001 remains the durable architecture:

```text
registered main worktree
        ↓
durable repository authorization anchor
```

CHANGE-005 extends what that existing anchor may authorize for read-only inspection. It adds no new durable owner, registry, persistence, session model, lifecycle, checkout manager, mutation path, or execution capability.

Because it extends the canonical SPEC-001 authorization contract, the relevant SPEC-001 sections MUST be synchronized in the same change.

## 3. Problem

### 3.1 Worktree discovery is not branch discovery

`list_worktrees` correctly reports validated linked worktrees derived from Git worktree inventory. It is not an enumeration of `refs/heads/*` or `refs/remotes/*`.

A branch can exist while correctly being absent from `list_worktrees`.

### 3.2 Workspace search cannot discover refs

`search_workspace` searches under a concrete filesystem root. `.git/` is intentionally hidden by the workspace noise policy.

A search miss for a branch name therefore says nothing about whether the Git ref exists.

### 3.3 Existing readers require checked-out filesystem state

`read_file`, `list_directory`, and `search_workspace` operate on a concrete `Workspace`.

Using them for an unchecked-out branch would require checkout or temporary worktree state, introducing mutation, cleanup, races, portability problems, and unnecessary lifecycle complexity.

### 3.4 Existing consent is too narrow

`git.read` currently means:

```text
Read git status and diffs
```

and is already part of the default read grant.

Reading arbitrary committed files from another local branch is materially broader. Reusing `git.read` would silently expand already-issued tokens.

CHANGE-005 therefore adds a distinct scope.

## 4. Decision

Add four installation-broker-only tools:

```text
list_branches
git_browse
git_search
git_compare
```

All four require:

```text
git.repository.read
```

They operate only through a registered main-worktree repository owner.

They do not accept a `worktree` selector.

The legacy per-project bridge does not expose them.

Do not add a generic revision browser, arbitrary object browser, history API, checkout API, temporary worktree manager, or network fetch.

## 5. Goals

1. Discover local branches even when they have no linked worktree.
2. Inspect committed file and directory content on such branches.
3. Search committed branch content without checkout.
4. Review target-branch changes relative to a base branch.
5. Keep the feature fully read-only and stateless.
6. Preserve SPEC-001 main-owner authorization.
7. Prevent linked-worktree-only registrations from gaining repository-wide access.
8. Prevent silent privilege expansion of existing tokens.
9. Reuse centralized sanitized Git execution.
10. Preserve sensitive-file and `.c2cignore` policy.
11. Preserve Git 2.34.1 compatibility.
12. Keep the public API small and model-friendly.

## 6. Non-goals

CHANGE-005 does not add:

- branch creation, deletion, rename, checkout, merge, rebase, reset, commit, push, pull or fetch,
- temporary/persistent worktree creation,
- live remote discovery,
- tags, stash or reflog inspection,
- arbitrary caller-supplied commit/OID inspection,
- arbitrary Git revision expressions,
- history/log traversal,
- generic Git object browsing,
- submodule traversal,
- symlink following,
- branch ACLs,
- repository caches or persistence,
- new server-side sessions,
- repository-wide reads to the legacy bridge,
- a generic repository/provider abstraction,
- lazy materialization of missing Git objects.

Remote-tracking refs are local cached Git state only.

**Partial/promisor repositories are intentionally unsupported for repository-snapshot inspection in CHANGE-005.** Git 2.34.1 has no compatible `--no-lazy-fetch` command-line boundary, so C2C must fail closed before snapshot/object/ancestry reads rather than risk an implicit fetch and object-store mutation.

## 7. Authorization and scope model

### 7.1 Main owner only

Repository-level reads require an explicitly registered main Git worktree:

```text
registered MAIN worktree
        ↓
repository ref inspection allowed

explicit linked-worktree registration
        ↓
existing exact-root behavior only
        ↓
repository ref inspection denied
```

This preserves SPEC-001's rule that registering a linked worktree does not authorize repository peers.

### 7.2 New scope

Add:

```text
git.repository.read
```

with consent wording equivalent to:

```text
Read Git branches and committed repository snapshots
```

The four CHANGE-005 tools require this scope.

Existing `git.read` continues to protect existing `git_status` / `git_diff` behavior.

### 7.3 Default grants, broker/legacy scope surfaces, and migration

The current OAuth implementation shares scope constants between the installation broker and legacy bridge. CHANGE-005 MUST NOT make the legacy bridge advertise or default-grant a repository capability that it does not expose.

Make the OAuth router's supported/default scope sets explicit per server mode:

```text
installation broker
  supported → existing supported scopes + git.repository.read
  default read → existing default read scopes + git.repository.read

legacy bridge
  supported → existing legacy-supported scope set, without git.repository.read
  default read → existing default read scopes, without git.repository.read
```

This may be implemented by passing supported/default scope sets into `createOAuthRouter()` / scope filtering rather than introducing a second OAuth implementation.

Do not rewrite stored tokens.

Therefore:

- new broker authorizations explicitly consent to repository snapshot reads,
- legacy authorizations do not advertise or default-grant `git.repository.read`,
- existing access/refresh tokens retain their recorded scopes,
- refreshing an old refresh token MUST preserve its old scope set and MUST NOT acquire `git.repository.read`,
- an old token receives `INSUFFICIENT_SCOPE` on CHANGE-005 tools,
- reauthorization is required to obtain the new capability.

Update hard-coded read-scope callers such as `scripts/poc-client.mjs` and relevant OAuth/E2E fixtures.

Silent privilege expansion is not allowed.

## 8. Repository target resolution

Reuse the existing validated local worktree model rather than implementing repository ownership a second time.

Required flow:

```text
resolve workspace registration
        ↓
construct/validate registered root
        ↓
resolveLocalWorktree(registration.canonicalRoot)
        ↓
require kind === "main"
        ↓
construct repository read target
```

If `resolveLocalWorktree()` does not return the registered root as `kind: "main"`, repository-ref inspection is unavailable.

Do not treat an arbitrary selected linked worktree as a repository authorization anchor.

A repository-read call against a linked-worktree-only registration MUST fail with a sanitized explicit error such as:

```text
REPOSITORY_SCOPE_UNAVAILABLE
```

Do not silently fall back to another registration.

This keeps main-owner identity rules single-sourced in the already validated worktree resolver.

## 9. Ref model

### 9.1 Allowed public refs

Limit caller-visible/accepted refs to exact:

```text
refs/heads/*
refs/remotes/*
```

Do not expose or accept:

```text
refs/tags/*
refs/stash
refs/replace/*
refs/notes/*
HEAD
reflog selectors
raw caller-supplied object ids
```

Omit symbolic remote aliases such as `refs/remotes/origin/HEAD`.

### 9.2 No arbitrary revspec

Caller input MUST NOT be passed as a generic Git revision expression.

Reject inputs such as:

```text
HEAD~10
branch^2
branch^{tree}
@{-1}
abc123
branch:path
```

Required flow:

```text
exact allowed ref
        ↓
validate exact namespace/ref
        ↓
resolve with an exact-ref primitive
        ↓
verify the resolved object is a commit
        ↓
use only that immutable commit OID for the rest of the request
```

Do not use a generic revision parser on caller input, even with option delimiters. Prefer an exact-ref primitive such as `show-ref --verify --hash <ref>` (or an equivalently exact API), then validate the returned object type using only the server-resolved OID.

This gives each individual request a stable snapshot if the branch moves concurrently.

### 9.3 OIDs are opaque

Do not assume SHA-1 or a fixed 40-character id. Treat Git-returned OIDs as opaque strings.

### 9.4 Multi-request pagination must detect ref movement

`git_browse` and `git_compare` may require multiple MCP calls to consume one logical result. Per-request OID resolution alone is insufficient because a branch can move between page 1 and page 2.

Server-returned commit values are continuation **preconditions only**, never object selectors:

```text
git_browse:
  expected_commit?

git_compare:
  expected_base_commit?
  expected_target_commit?
```

For every call the server still resolves the exact authorized ref(s) itself.

Continuation requirements are mandatory:

- `git_browse` directory request with `offset > 0` MUST include `expected_commit`,
- `git_browse` file request with `start_line > 1` MUST include `expected_commit`,
- `git_compare` request with `offset > 0` MUST include both `expected_base_commit` and `expected_target_commit`,
- if either compare precondition is supplied, both MUST be supplied,
- missing required continuation preconditions fail with `CONTINUATION_PRECONDITION_REQUIRED`,
- a supplied precondition that does not equal the newly resolved commit fails with `REF_CHANGED`.

First-page calls may omit the preconditions. If supplied on a first-page call, they are validated with the same rules.

Never use an `expected_*` caller value to select or authorize a Git object.

This keeps pagination coherent without adding snapshot persistence or allowing arbitrary OID access.

### 9.5 Replacement objects are disabled

Rejecting `refs/replace/*` as caller input is not sufficient. Git can transparently substitute replacement objects while reading an otherwise unchanged commit OID.

Every CHANGE-005 snapshot/object/ancestry operation MUST disable replacement-object lookup, including:

- commit/object type checks,
- tree/blob reads,
- snapshot search,
- merge-base calculation,
- comparison diff generation.

Use one centralized snapshot Git boundary that forces the equivalent of:

```text
git --no-replace-objects ...
```

or an equally reliable `GIT_NO_REPLACE_OBJECTS` setting.

The same resolved branch OID must therefore identify the same underlying committed object graph regardless of repository `refs/replace/*` state.

## 10. `list_branches`

### Input

```ts
{
  workspace?: string;
  offset?: number;
  limit?: number;
}
```

No `worktree`.

### Output

```json
{
  "branches": [
    {
      "name": "main",
      "ref": "refs/heads/main",
      "kind": "local",
      "commit": "<opaque Git OID>"
    },
    {
      "name": "origin/main",
      "ref": "refs/remotes/origin/main",
      "kind": "remote_tracking",
      "commit": "<opaque Git OID>"
    }
  ],
  "offset": 0,
  "limit": 200,
  "has_more": false
}
```

### Contract

Use machine-readable ref enumeration, preferably `for-each-ref`, with deterministic sorting.

The implementation may stream/discard entries before `offset` and needs to read only through `offset + limit + 1` to establish `has_more`; it does not need a repository-wide total count.

The tool performs no fetch and returns no filesystem/Git-admin paths.

## 11. `git_browse`

### Purpose

Inspect a committed directory entry or text file at one exact allowed branch ref.

Combining directory listing and file read keeps the caller model small:

```text
show this path at this committed snapshot
```

### Input

```ts
{
  workspace?: string;
  ref: string;
  path?: string;             // default "."
  start_line?: number;       // file response
  end_line?: number;         // file response
  offset?: number;           // directory response
  limit?: number;            // directory response
  expected_commit?: string;  // required for offset > 0 or start_line > 1
}
```

No `worktree`.

### Directory response

Return:

- exact ref,
- resolved commit,
- normalized path,
- `kind: "directory"`,
- bounded/paginated entries,
- `offset`, `limit`, `has_more`.

Do not require a total entry count. Read only far enough to produce the requested page plus one look-ahead entry.

Entries distinguish:

```text
file
directory
symlink
gitlink
```

### File response

Mirror `read_file`'s bounded text semantics:

- `size_bytes`,
- `total_lines`,
- `start_line`,
- `end_line`,
- `truncated`,
- `remaining_lines`,
- `next_start_line`,
- `content`.

Before reading content, inspect object type and blob size. Blobs over 1 MiB fail with `FILE_TOO_LARGE`; do not stream an arbitrarily large blob merely to truncate it afterward.

The returned `content` MUST fit within 256 KiB measured as UTF-8 bytes, including newline separators between returned lines. Return only complete lines. If the next requested line to emit exceeds 256 KiB by itself, fail the call with `FILE_TOO_LARGE` and a sanitized message identifying the single-line limit; do not return partial content or a continuation cursor for that failed call. This also applies to the first line: do not inherit `read_file`'s exception that allows the first collected line to exceed the byte limit.

If the next line fits in an empty response but not in the current page's remaining byte budget, end the page before that line and set `next_start_line` to its line number. Never split or skip a line, or return an empty successful page that repeats the same continuation without progress.

A directory request with `offset > 0` or file request with `start_line > 1` requires `expected_commit`.

Missing required precondition:

```text
CONTINUATION_PRECONDITION_REQUIRED
```

Moved branch:

```text
REF_CHANGED
```

### Object safety

- Never follow mode `120000` symlinks; return the stored target as data.
- Never traverse mode `160000` gitlinks/submodules; return metadata/OID only.
- A binary blob returns `BINARY_FILE` without blob bytes.
- Do not return arbitrary binary content.

## 12. `git_search`

### Input

Keep the model close to `search_workspace`:

```ts
{
  workspace?: string;
  ref: string;
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}
```

No `worktree`.

### Output

```json
{
  "ref": "refs/heads/example",
  "commit": "<opaque Git OID>",
  "matches": [
    {
      "path": "src/index.ts",
      "line": 42,
      "text": "..."
    }
  ],
  "match_count": 1,
  "truncated": false,
  "truncation_reason": null
}
```

`truncation_reason` is `null`, `"match_limit"`, or `"output_limit"`.

### Contract

Use a bounded Git-native snapshot search against the resolved immutable commit.

Requirements:

- no shell interpolation,
- replacement objects disabled,
- no textconv,
- binary content skipped,
- sensitive/hidden results never returned,
- bounded line text and match count,
- repository path normalization, not filesystem path resolution,
- raw child-process output counted while streaming,
- stop/terminate the Git process once the raw-output cap is reached.

If the match limit is reached, return collected safe matches with:

```text
truncated: true
truncation_reason: "match_limit"
```

If the raw-output cap is reached first, return only fully parsed safe matches collected before the cap with:

```text
truncated: true
truncation_reason: "output_limit"
```

An extremely long single output line MUST NOT be accumulated without bound; raw bytes are counted before line buffering.

## 13. `git_compare`

### Input

```ts
{
  workspace?: string;
  base_ref: string;
  target_ref: string;
  path?: string;
  offset?: number;
  max_bytes?: number;
  expected_base_commit?: string;   // required when offset > 0
  expected_target_commit?: string; // required when offset > 0
}
```

No `worktree`.

If either expected commit is supplied, both are required.

### Semantics

Resolve both refs once to immutable commits with replacement-object lookup disabled, then compute:

```text
merge-base(base, target)
        ↓
diff merge-base → target
```

This intentionally answers:

```text
what changes did target introduce relative to base?
```

It is not raw tip-to-tip snapshot difference.

If there is no merge base, fail explicitly rather than silently changing semantics.

For `offset > 0`, both expected commits are mandatory.

Missing/partial preconditions fail with:

```text
CONTINUATION_PRECONDITION_REQUIRED
```

A moved base or target ref fails with:

```text
REF_CHANGED
```

### Output

Mirror existing bounded diff pagination and include:

- `comparison: "merge_base_to_target"`,
- `base_ref`,
- `target_ref`,
- `base_commit`,
- `target_commit`,
- `merge_base`,
- byte pagination fields,
- unified `diff`.

## 14. Repository-path and content policy

Snapshot paths are Git tree paths, not local filesystem paths.

Do not create a fake `Workspace` rooted at a ref.

Add a small repository-path normalizer that:

- rejects NUL,
- normalizes separators to `/`,
- rejects absolute paths,
- rejects traversal components,
- returns a normalized repository-relative path.

Normalization alone is not authorization. Every normalized caller path passed to Git MUST use explicit literal path semantics (for example `:(literal)` or an equivalently safe primitive) and a proper `--` delimiter. A filename beginning with Git pathspec magic such as `:(...)` MUST remain a literal filename.

If `git_search.glob` is retained, define it as C2C filename-glob semantics and translate/filter it under one controlled mode. Never pass caller glob text as unrestricted Git pathspec syntax.

Apply the **authorized current main workspace's** C2C ignore policy.

A `.c2cignore` stored on the target branch MUST NOT weaken the authorization policy controlling that same read.

Preserve current policy semantics:

- explicit committed file read: deny sensitive paths,
- directory listing: hide sensitive and noise paths,
- snapshot search: hide sensitive and noise paths,
- compare: exclude a file entirely if either relevant path is sensitive.

A committed `.env`, key or credential file must not become readable merely because it exists on another branch.

## 15. Git execution hardening

All operations use centralized `runGit()` semantics and its sanitized environment.

Extend centralized environment sanitization as needed so inherited Git pathspec-mode variables cannot change caller-path interpretation. At minimum account for:

```text
GIT_LITERAL_PATHSPECS
GIT_GLOB_PATHSPECS
GIT_NOGLOB_PATHSPECS
GIT_ICASE_PATHSPECS
```

No shell execution.

### 15.1 Central snapshot Git boundary

CHANGE-005 SHOULD use one focused snapshot runner/helper rather than duplicating safety flags at each callsite.

That boundary MUST:

- reuse the same repository/environment sanitization as `runGit()`,
- disable replacement objects,
- preserve literal path semantics,
- enforce bounded stdout/stderr behavior appropriate to the operation,
- remain a fixed Git-command adapter, not a generic execution facility.

### 15.2 External diff / text conversion

Repository config and attributes are untrusted data.

Snapshot comparison MUST disable repo-configured execution paths:

```text
--no-ext-diff
--no-textconv
```

Apply equivalent hardening to existing `git_diff` if it is not already guaranteed there.

A read tool must not become command execution through Git diff drivers or text conversion.

### 15.3 No explicit or implicit network/object mutation

No CHANGE-005 tool may explicitly execute `fetch`, `pull`, `ls-remote`, or another network operation.

That prohibition is insufficient because partial/promisor repositories may lazily fetch a missing object during an ordinary object read.

Before any snapshot object read or ancestry operation, determine whether the effective repository is partial/promisor-backed. At minimum detect effective partial/promisor configuration such as:

```text
extensions.partialClone
remote.<name>.promisor = true
```

If partial/promisor behavior is present or cannot be classified safely, fail closed with:

```text
PROMISOR_REPOSITORY_UNSUPPORTED
```

Do this **before** reading a potentially missing object.

CHANGE-005 targets Git 2.34.1 compatibility and MUST NOT depend on `--no-lazy-fetch`.

Acceptance requires proving that a missing-object partial-clone fixture:

- does not invoke transport/helper activity through the CHANGE-005 read path,
- does not add object/pack files,
- returns the sanitized unsupported-repository error.

Remote-tracking refs remain local cached state.

### 15.4 Replacement objects

All snapshot object and ancestry operations run with replacement lookup disabled:

```text
--no-replace-objects
```

or an equivalently forced `GIT_NO_REPLACE_OBJECTS` setting.

`refs/replace/*` state must therefore be irrelevant to `git_browse`, `git_search`, merge-base computation and `git_compare`.

### 15.5 Public limits and overflow behavior

Reuse existing C2C bounds where they already fit. Do not add a configuration framework.

| Operation | Default | Hard maximum / bound | Overflow behavior |
| --- | ---: | ---: | --- |
| `list_branches` page | 200 refs | 1,000 refs | validate/clamp `limit`; one look-ahead ref for `has_more` |
| `git_browse` directory page | 200 entries | 1,000 entries | one look-ahead entry for `has_more`; no total-count scan |
| `git_browse` text window | 400 lines | 2,000 lines | page/truncate using read-file-style fields |
| `git_browse` returned text | — | 256 KiB UTF-8 content/call | paginate complete lines; a single line over the cap fails `FILE_TOO_LARGE`; continuation uses `expected_commit` |
| `git_browse` blob object | — | 1 MiB | fail `FILE_TOO_LARGE` before content read |
| `git_search` matches | 50 | 200 | `truncated: true`, reason `match_limit` |
| `git_search` returned match text | — | 500 characters/match | truncate displayed text |
| `git_search` raw child output | — | 2 MiB | terminate process; return complete safe matches, reason `output_limit` |
| `git_compare` page | 64 KiB | 256 KiB | byte pagination |
| `git_compare` aggregate diff | — | 64 MiB | fail `DIFF_TOO_LARGE`; never silent partial success |

The raw search-output counter MUST operate on stream chunks, not only newline-delimited records, so one extreme line cannot bypass the bound.

The generic existing 64 MiB `runGit()` buffer remains a final process safety ceiling, not the primary browse/search contract.

## 16. Internal implementation shape

Add:

```text
src/workspace/git-snapshot.ts
```

Suggested ownership:

```text
resolveRepositoryOwner()              // reuses resolveLocalWorktree(kind === "main")
assertSnapshotRepositorySupported()   // fail closed on partial/promisor repos
listBranches()
resolveBranchRef()
normalizeRepositoryPath()
browseSnapshot()
searchSnapshot()
compareSnapshots()
```

Keep in `src/workspace/git.ts`:

```text
runGit()
sanitized Git environment
gitInfo()
gitStatus()
existing working-tree gitDiff()
```

Use one focused snapshot Git runner/helper for `--no-replace-objects`, bounded output and fixed-command safety.

Do not introduce a `RevisionTarget` framework, repository-provider abstraction, branch cache, snapshot registry, checkout manager, new session model or lazy-fetch compatibility layer without demonstrated need.

## 17. MCP integration

Register the four tools only in installation-broker mode.

Each tool:

- requires `git.repository.read`,
- has `readOnlyHint: true`,
- carries the existing untrusted-workspace warning,
- uses the registered main workspace as the authorization anchor.

The broker's scoped read-tool count increases by four.

Update exact tool-list assertions and canonical documentation.

## 18. Cross-tool guidance

The original failure was partly semantic: absence from `list_worktrees` was incorrectly treated as evidence that a branch did not exist.

Add a concise broker instruction equivalent to:

```text
list_worktrees reports checked-out linked worktrees, not repository branches.
For other branches use list_branches and git_browse, git_search, or git_compare.
```

This is UX guidance only. Authorization remains code-enforced.

## 19. Legacy compatibility

The legacy bridge:

- remains exact-root-only,
- retains its existing tool surface,
- does not expose the four repository-ref tools,
- does not gain `git.repository.read` behavior,
- does not accept branch/ref selectors on existing tools.

Do not expand the legacy OAuth boundary.

## 20. Documentation synchronization

Update canonical SPEC-001 in the same change.

At minimum document:

1. registered main additionally authorizes bounded repository-ref reads,
2. explicit linked registration does not authorize repository refs,
3. repository refs are dynamic read targets and are not persisted,
4. branch inspection requires no worktree creation,
5. ref tools are broker-only,
6. arbitrary revision syntax, history traversal and mutation remain non-goals.

Also update:

```text
docs/architecture.md
docs/security.md
docs/multi-workspace.md
docs/local-e2e.md
```

and any Skill/connector docs that enumerate the MCP read surface.

Do not broaden SPEC-001 beyond CHANGE-005.

## 21. Verification plan

### 21.1 Core regression

Create a temporary repository with `main` plus an unchecked-out `codex/change-005-fixture` branch containing a unique marker.

Verify `list_worktrees` does not need to contain that branch, while `list_branches`, `git_browse`, `git_search`, and `git_compare` all operate on it successfully.

### 21.2 Authorization

Verify:

- registered main succeeds,
- linked-worktree-only registration is rejected,
- old-scope token receives `INSUFFICIENT_SCOPE`,
- refreshing an old refresh token does not add `git.repository.read`,
- newly issued broker default-read token contains `git.repository.read`,
- broker OAuth discovery advertises `git.repository.read`,
- legacy OAuth discovery/default grants do not include `git.repository.read`,
- legacy bridge exposes none of the four tools.

### 21.3 Ref validation

Reject generic revspecs, raw caller OIDs, tags, stash and other excluded namespaces.

Accept exact allowed local and remote-tracking branch refs and omit symbolic remote `HEAD`.

### 21.4 Snapshot and pagination stability

Within one request, move the branch after exact ref resolution. The operation must continue using the originally resolved immutable commit OID.

Across calls verify:

- browse `offset > 0` without `expected_commit` → `CONTINUATION_PRECONDITION_REQUIRED`,
- browse `start_line > 1` without `expected_commit` → same error,
- compare `offset > 0` with either/both expected commits omitted → same error,
- valid continuation preconditions succeed,
- moved referenced branch between pages → `REF_CHANGED`.

### 21.5 Replacement-object regression

Create commits A and B with distinct marker content. Keep a branch pointing to A and install `git replace A B`.

Verify:

- branch discovery still reports A's OID,
- browse/search use A's original content,
- compare ancestry/diff uses the original object graph,
- adding/removing/changing `refs/replace/*` does not alter results for the same branch OID.

### 21.6 Partial/promisor lazy-fetch regression

Create a Git 2.34.1-compatible partial/promisor fixture with at least one intentionally missing blob.

Before the CHANGE-005 read, capture object/pack-store state and configure an observable transport/helper sentinel where practical.

Then call a repository snapshot operation that would otherwise need the missing object.

Verify:

- request fails `PROMISOR_REPOSITORY_UNSUPPORTED`,
- no transport/helper is invoked through the CHANGE-005 read path,
- object/pack-store state is unchanged.

The test must prove rejection occurs before missing-object materialization.

### 21.7 Sensitive policy

Commit sensitive fixtures on the non-checked-out branch and verify browse/search/compare do not expose them. The authorized workspace's `.c2cignore` remains controlling policy.

### 21.8 Object types

Cover normal file, executable file, directory, symlink without following, gitlink without traversal, and binary file without returning bytes.

### 21.9 Diff/textconv hardening

Configure a diff/textconv driver with an observable side effect and verify repository comparison plus existing diff reads do not execute it.

### 21.10 Literal pathspec hardening

Verify pathspec-looking filenames remain literal and inherited Git pathspec-mode environment variables do not change semantics.

### 21.11 Output-limit contract

Verify:

- blob exactly at and just above 1 MiB,
- browse line/byte pagination,
- browse a blob containing a single 300 KiB line (below the 1 MiB blob cap): fail `FILE_TOO_LARGE` without partial content or a continuation cursor,
- browse single-line content exactly at 256 KiB succeeds; one byte above fails, including multibyte UTF-8 fixtures to verify byte rather than character counting,
- browse a next line that fits alone but exceeds the remaining page budget: return preceding complete lines, then resume at that next line without loss, duplication or an empty non-progressing page; count returned newline separators toward the cap,
- search match-limit truncation,
- search raw-output-limit truncation,
- one extremely long grep output line cannot exceed the 2 MiB raw cap,
- compare above 64 MiB fails `DIFF_TOO_LARGE`,
- no overflow case silently reports complete success.

### 21.12 Connector/OAuth rollout smoke

Update explicit local PoC/live authorization scope lists.

Perform one broker-level authorization smoke proving a fresh/re-authorized connector obtains `git.repository.read` and can call at least `list_branches`.

Also prove a pre-change-style token remains usable for existing tools but receives `INSUFFICIENT_SCOPE` for repository-ref tools.

Document that existing paired connectors may require reauthorization.

### 21.13 Quality gates

At minimum:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Retain Git 2.34.1 compatibility.

## 22. Acceptance criteria

### AC-005-1 — Unchecked-out branch discovery works

A local branch with no linked worktree is returned by `list_branches`.

### AC-005-2 — Worktree and branch concepts stay distinct

`list_worktrees` semantics remain unchanged. Absence there is not treated as branch absence.

### AC-005-3 — Unchecked-out committed content is inspectable

`git_browse` reads committed tree/text content without checkout or worktree creation.

### AC-005-4 — Unchecked-out committed content is searchable

`git_search` finds committed content without filesystem mutation.

### AC-005-5 — Review comparison works

`git_compare(base, target)` returns merge-base-relative target changes with bounded pagination.

### AC-005-6 — No explicit or implicit mutation/network

No CHANGE-005 tool modifies Git/filesystem state or performs explicit network access.

Partial/promisor repositories fail closed before an object read can trigger lazy fetch or object-store mutation.

### AC-005-7 — Main-owner boundary is preserved

Only registered main worktrees authorize repository refs. Linked-worktree-only registration does not.

Repository owner validation reuses the existing `resolveLocalWorktree()` `kind: "main"` contract.

### AC-005-8 — Existing tokens are not silently upgraded

Previously issued tokens without `git.repository.read` cannot use CHANGE-005 tools until reauthorization, and refresh rotation preserves the old scope set.

### AC-005-9 — No arbitrary revision language or pathspec escape

Generic revspecs, tags, history selectors and raw caller object ids are rejected.

Caller paths cannot activate Git pathspec magic or inherited pathspec modes.

### AC-005-10 — Snapshot identity is replacement-independent

All snapshot/object/ancestry reads disable Git replacement objects.

Changing `refs/replace/*` cannot change browse/search/compare content for the same resolved branch OID.

### AC-005-11 — Pagination is coherent

One request uses one immutable resolved commit.

Continuation ranges/pages require the documented commit preconditions. Missing preconditions fail; moved refs fail `REF_CHANGED`.

### AC-005-12 — Sensitive policy is preserved

Snapshot browse/search/compare cannot expose paths denied by existing C2C policy.

### AC-005-13 — Symlinks and gitlinks cannot escape the model

Symlinks are data, not followed paths. Gitlinks are metadata, not traversed repositories.

### AC-005-14 — Git config cannot turn reads into execution

External diff/textconv execution is disabled for C2C diff/compare reads.

### AC-005-15 — Public resource limits are deterministic

Browse/search/compare enforce the documented hard limits and explicit error/truncation behavior, including an extremely long search line. Browse never exceeds 256 KiB of UTF-8 content or splits a line: an individually oversized requested line fails `FILE_TOO_LARGE`, while ordinary page boundaries preserve progress and complete-line continuation.

### AC-005-16 — Legacy compatibility is preserved

The legacy bridge retains its current exact-root surface and behavior.

### AC-005-17 — OAuth surfaces remain truthful

The installation broker advertises/default-grants `git.repository.read`; the legacy bridge does not. Old refresh tokens cannot acquire the new scope through rotation.

### AC-005-18 — No persistent model expansion

No branch registry, snapshot cache, session schema, checkout lifecycle or state migration is introduced.

### AC-005-19 — Canonical docs match implementation

SPEC-001 and related architecture/security/tool-surface docs are synchronized in the same change.

### AC-005-20 — Verification passes

Focused API/security tests, lazy-fetch and replacement-object regressions, connector/OAuth smoke, full tests, typecheck, build and diff checks pass.

## 23. Rollback

CHANGE-005 introduces no Git/workspace-state migration.

Rollback removes the four repository-read tools and new authorization path.

Tokens issued with `git.repository.read` may retain that inert scope string until expiry or reauthorization; rollback code must not treat it as additional authority.

No branch, worktree, object or project file is modified by rollback.

## 24. Implementation principle

Keep repository inspection a direct immutable Git read:

```text
registered main owner
        ↓
reject unsupported partial/promisor repository
        ↓
exact allowed branch ref
        ↓
resolve once to immutable commit OID
        ↓
Git object/ancestry reads with replacement objects disabled
        ↓
existing C2C policy + bounded MCP response
```

Continuation requests prove they still refer to the same resolved commits.

Do not solve a read problem by creating mutable filesystem state, and do not allow Git's implicit object machinery to create that state on C2C's behalf.
