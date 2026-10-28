# CHANGE-013: Patch Authoring, Diagnostics, and Create-Path Ergonomics

- **Status:** Partial — implementation and task-scoped validation complete; one unrelated full-suite failure remains
- **Date:** 2026-10-28
- **Project:** `chat-to-codex`
- **Baseline:** `main` at `2a01d1b` (clean on 2026-10-28; recheck before implementation)
- **Authority:** [SPEC-002](../specs/spec-002-approved-local-patch-writes.md), [SPEC-001](../specs/spec-001-worktree-aware-workspace-access-consolidated.md)
- **Related:** [CHANGE-010](change-010-pending-patch-difftool-review.md) (deferred), [CHANGE-012](change-012-mcp-read-efficiency-and-capability-diagnostics.md) (independent)
- **Scope:** Easier exact-text proposals, actionable patch errors, better proposal/CLI feedback, and new-file creation under missing parent directories.

## 1. Goal and guardrails

Reduce failed proposals and routine approval friction **without a second write engine**.

This change contains four selected improvements:

1. `propose_text_edits`: exact text replacement without model-generated unified diff.
2. Bounded, safe diagnostics for failed patch/text-edit proposals.
3. Clearer MCP receipts and local pending-request display.
4. Support `propose_patch` file creation when intermediate directories are absent.

**Keep unchanged:** `workspace.write` authorization; opaque workspace/worktree selection; the existing `preparePatch` security and exact-match rules; one-hour pending TTL; explicit local approval; stale protection; receipts; existing file apply/rollback; post-approval independent verification. A proposal does not modify project files.

**Out of scope:** CHANGE-010 difftool review, deletion/rename/move, arbitrary write or shell tools, regex/replace-all/fuzzy edits, auto-rebase, auto-approval, a new request lifecycle, a general-purpose diff/edit framework, a new UI, or an unrelated SPEC-002 refactor.

## 2. Verified baseline

- `src/mcp/server.ts`: `propose_patch`, `list_write_requests`, and `get_write_request` exist. Proposal results include ID/status/file counts/expiry, but no target selector.
- `src/write-requests/patch.ts`: create/update unified text diffs only; 1 MiB patch/source/result, 50 files, exact hunk positions, protected-path and symlink checks. A context mismatch returns a generic `PATCH_DOES_NOT_APPLY` message.
- `src/write-requests/service.ts`: pending requests persist the **unified patch text**; approval re-runs `preparePatch` and checks stored preconditions. `src/write-requests/apply.ts` performs staging and rollback.
- Create operations currently require an existing parent directory (`WRITE_PARENT_MISSING`). Staging temp files assumes that parent already exists.
- `src/cli/write-requests.ts`: `pending [id] --diff`, `approve [id]`, `reject [id]`, `--json`, and cwd-based unique-request selection already exist. Human output omits `+/-` counts and action hints.

The solution must reuse these paths rather than introducing parallel state or filesystem semantics.

## 3. Exact-text proposals (`propose_text_edits`)

### 3.1 MCP input

```json
{
  "workspace": "<opaque workspace ID>",
  "worktree": "<optional opaque worktree ID>",
  "edits": [
    {
      "path": "docs/example.md",
      "old_text": "Old wording",
      "new_text": "New wording"
    }
  ]
}
```

- 1–50 edits per request; updates to existing **regular UTF-8 text files** only. Existing patch/source/result size limits apply, as does the 50-distinct-file limit.
- `old_text` must be non-empty and occur **exactly once** in the file content at that point in the ordered sequence. Zero or multiple matches fail the whole proposal; never guess which match to replace.
- Multiple edits in one file apply in input order, then produce **one final update per file**. No partial request is persisted. `new_text: ""` is allowed; deleting the entire file is not.
- Each path uses existing workspace/worktree and protected/sensitive-path checks. Preserve UTF-8 BOM and bytes outside edited spans. For uniformly CRLF files, interpret LF line breaks in edit inputs as logical line breaks and preserve CRLF; for mixed line endings, require an unambiguous exact transformation or reject. Preserve no-final-newline behavior. Reject invalid UTF-8/binary input and unchanged final content.

### 3.2 One canonical implementation path

**Convert ordered text edits into one compact, standard unified diff, then call the existing `createManualRequest` / `preparePatch` pipeline.** The stored request is the same unified-patch format as today.

1. Resolve the selected concrete target and read/validate each distinct source file through existing bounded, protected file access.
2. Apply literal replacements in memory (including uniqueness checks), producing intended final bytes.
3. Generate only the changed-line hunks with correct line numbers and standard newline markers; do **not** emit an entire large file as context for a small edit. Prefer a small established diff-generation utility over writing a general diff algorithm. Do not add a second patch applier.
4. Run the generated patch through **the existing** `preparePatch`, and assert that every prepared result matches the intended bytes. Reject the proposal if exact representation or current size limits cannot be satisfied.
5. Persist with the existing request service. Approval re-prepares the persisted patch, unchanged. `c2c pending <id> --diff` works without a new preview format.

A change to source content between edit generation and canonical preparation must fail safely; no automatic retry/merge. **Do not add a new persisted request kind, discriminator, edit JSON storage, or alternate approval path.**

## 4. Actionable proposal errors

Keep existing top-level error codes and `message`; add a small **optional** `details` object only where the failing location is known and safe to reveal.

```json
{
  "error": "PATCH_DOES_NOT_APPLY",
  "message": "Patch context does not match the selected file.",
  "details": {
    "path": "docs/example.md",
    "hunk_index": 2,
    "old_line": 84,
    "reason": "CONTEXT_MISMATCH"
  }
}
```

- For a unified patch: validated relative `path`, 1-based `hunk_index`, declared `old_line`, and a fixed `reason` when determinable.
- For text edits: validated relative `path`, 1-based `edit_index`, and `reason: "NO_MATCH" | "AMBIGUOUS_MATCH"` using existing `PATCH_DOES_NOT_APPLY` as the top-level code.
- Before authorization or path validation, return the existing generic error **without a path**. Never include actual source/context text, absolute paths, sensitive content, underlying exceptions, or unbounded strings.
- Extend only the necessary `WriteRequestError`/MCP error mapping. No new top-level error-code family, persisted diagnostic records, diagnostic query tool, or changes to terminal receipt status. Approval-time stale handling stays as-is.

## 5. Better feedback without new workflow

### 5.1 MCP proposal receipt

Keep existing fields and add `workspace_id`, plus `worktree_id` when selected. This makes the target explicit, especially when multiple worktrees are connected.

```json
{
  "request_id": "wr_<opaque>",
  "status": "pending",
  "workspace_id": "<opaque workspace ID>",
  "worktree_id": "<optional opaque worktree ID>",
  "files": [{ "path": "docs/example.md", "action": "update", "additions": 1, "deletions": 1 }],
  "expires_at": "<timestamp>"
}
```

The assistant can construct `c2c pending <id> --diff` and `c2c approve <id>` (or `c2ct` in the test profile) from this ID. **Do not store or generate redundant `commands` fields on the server or add a CLI/profile discovery mechanism.** No remote approval method.

### 5.2 Human CLI display

For `c2c pending`, show per-file `+additions/-deletions` and expiry. For **one** pending patch request, print the already-supported explicit review/approve/reject commands, using the actually invoked `c2c`/`c2ct` executable. When several requests are listed, avoid repeating three command hints per request; show IDs and file counts instead.

Keep the existing `--json` shape, implicit unique-request selection, and explicit ID behavior. No interactive confirmation, wizard, new CLI verb, or batch approval.

## 6. Create files when parent directories are missing

Support missing ancestors **only for unified-diff `create` operations**. Existing-file updates still require their target and parent; no independent directory request is added.

### 6.1 Preparation (no mutations)

- Validate the canonical workspace/worktree, normal relative path, existing ancestor components, protected roots, and symlinks. Reject a non-directory ancestor or any path that would escape the selected workspace.
- Detect target-path conflicts across the whole patch (e.g., creating both `docs/foo` as a file and `docs/foo/bar.md` as its child). Multiple files may share a new directory.
- Keep existing file-absence preconditions and hashes. **Do not persist a directory plan, directory hashes, or a new record schema.** At approval, revalidate current ancestors and targets; an externally created ordinary parent directory may be accepted if still safe.

### 6.2 Extend the existing apply transaction

1. Re-prepare and validate the entire patch at approval, as today.
2. Stage all results **before making project changes**. When the create target's parent is missing, place its temp file in the nearest validated existing ancestor on the same filesystem; do not stage outside the workspace. Keep current update staging.
3. Create absent directory components one at a time, parent-to-child, rechecking each existing ancestor and recording **only directories this transaction created**, in memory. No `mkdir({ recursive: true })` on an untrusted full path. Do not modify existing directory permissions.
4. Before each file commit, revalidate ancestry and create-target absence. Preserve the existing staging-integrity and file-hash checks. Unexpected symlinks/collisions or cross-device commits fail closed.
5. On failure (including receipt persistence failure), use the existing file rollback and then remove transaction-created directories in reverse order **only when empty**. Do not remove pre-existing directories or other actors' content. If safe rollback/cleanup cannot complete, retain the existing unresolved-rollback fail-closed behavior.
6. On success, keep created directories and clean all temp files. No separate directory lifecycle, journal, cleanup daemon, or crash-recovery framework.

**Security gate:** The current Node/path-based implementation is not inherently race-free against hostile concurrent symlink swaps. An `lstat` followed by `mkdir` or `link` is not a complete guarantee. The implementation must not claim stronger containment than it can establish. Test deterministic ancestor/symlink changes and reject unsafe cases. If this feature cannot preserve the existing C2C path-security boundary with a bounded implementation, **defer §6 only**; do not add a privileged helper or weaken security to force delivery. S1/S2 remain independently useful.

## 7. Delivery order

| Stage | Work | Priority |
| --- | --- | --- |
| S1 | Safe error details and clearer MCP/CLI outputs | High / low effort |
| S2 | `propose_text_edits` as a thin converter to existing unified patch | High |
| S3 | Missing parent directories within existing create transaction | Medium; security-gated |
| S4 | Targeted docs, tests and live MCP exposure check | Required per stage |

S1 and S2 do not depend on S3. Keep [CHANGE-010](change-010-pending-patch-difftool-review.md) and deletion out of this change. Implement only the stage actually approved for execution; no speculative framework work.

## 8. Acceptance checks (proportional)

1. Existing `propose_patch` and pending approval remain compatible; pending records generated before this change survive broker restart.
2. `propose_text_edits`: one edit, multiple files, ordered same-file edits, and accurate `pending --diff`; one request and one explicit approval; generated bytes verified against intended bytes.
3. Exact-match failures (zero/multiple), no-op, invalid UTF-8/binary, size limits, protected paths, CRLF/BOM/no-final-newline are covered without source leakage or partial requests.
4. Diagnostics preserve existing error codes and expose only authorized, bounded path/hunk/edit metadata. Generic error responses remain compatible.
5. MCP receipts identify exact workspace/worktree; CLI output shows counts/expiry and concise commands, preserving `--json` and ambiguous-request behavior.
6. Nested create: one and multiple shared-parent files; proposed request makes no directories; successful approval creates the correct files; conflicting paths and parent collisions fail safely.
7. Failed staging, interrupted commit, stale target, injected symlink/ancestor changes, and receipt persistence failure exercise file + empty-directory rollback; unresolved restoration fails closed. No claim of universal race freedom.
8. Focused unit/integration tests for touched modules, `pnpm typecheck`, `pnpm build`, and relevant regression tests; one disposable live connector verification for the new tool. Independently re-read applied files; receipt `applied` alone is insufficient.

## 9. Review decision

**Reviewed for KISS, low friction, and scope.** This revision removes alternative persistence architecture, redundant MCP command strings, and durable directory tracking. It retains one standard patch representation and one approval/rollback lifecycle.

**Implementation authorization:** The task owner authorized implementation after
this document was committed to `main`. S3 passed deterministic ancestor and
rollback security checks; the implementation makes no claim of universal
hostile-race freedom. The unrelated full-suite failure is recorded in the
CHANGE-013 verification ledger and does not affect the task-owned tests.
