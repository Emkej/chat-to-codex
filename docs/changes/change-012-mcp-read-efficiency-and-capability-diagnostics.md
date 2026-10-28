# CHANGE-012: MCP Read Efficiency, Search Completeness, and Capability Diagnostics

- **Status:** Draft — review pass complete; pending implementation
- **Date:** 2026-10-28
- **Scope:** `chat-to-codex` installation broker MCP surface; existing workspace/worktree readers and repository snapshot readers
- **Baseline:** local `main` at `00b83ee` (clean working tree; verified 2026-10-28)
- **Authority:** [SPEC-001](../specs/spec-001-worktree-aware-workspace-access-consolidated.md), [SPEC-002](../specs/spec-002-approved-local-patch-writes.md), [SPEC-004](../specs/spec-004-approved-local-command-execution.md), [multi-workspace architecture](../multi-workspace.md)
- **Primary areas:** `src/workspace/search.ts`, `src/workspace/manager.ts`, `src/workspace/git.ts`, `src/workspace/git-snapshot.ts`, `src/mcp/server.ts`, broker command tool registration, MCP tests and documentation

## 1. Outcome

Make ChatGPT's C2C inspection both **trustworthy and efficient**: complete or explicitly limited search results, bounded multi-file reads, lightweight Git change summaries, optionally bounded Git history, and observable tool/scope availability. Do not add a competing index, generic shell executor, or new authorization model.

**One change document, phased implementation.** Phase 0 correctness issues block claims of readiness. Phase 1 improves the common review workflow. Phase 2 adds narrower diagnostics/history without blocking earlier phases.

## 2. Classification and priority

| Phase | Item | Priority | Type |
| --- | --- | --- | --- |
| 0 | Diagnose unexpected empty `read_file` / `git_browse` content in ChatGPT | P0 | Investigation; fix only the proven faulty layer |
| 0 | Correct `search_workspace` silent per-file truncation | P0 | Correctness defect |
| 1 | Paginate/search context/filenames in `search_workspace` | P1 | Existing tool extension |
| 1 | `view: summary` for `git_diff` and `git_compare` | P1 | Existing tool extension |
| 1 | `read_files` bulk reads | P1 | One new tool, existing read implementation |
| 1 | Verify exposure of existing `request_command` / `get_command_request` | P1 | Integration/permissions diagnosis; no new execution feature |
| 2 | Bounded `git_history` | P2 | One new read-only tool |
| 2 | Capability/authorization diagnostics in `workspace_info` | P2 | Existing tool extension |

Delivery order within Phase 1 may change after measuring the actual ChatGPT tool overhead. Do not delay correctness fixes for batch reads.

## 3. Verified baseline and unresolved observations

1. `search_workspace` accepts `query`, `path`, `glob`, `limit` and `regex` but no offset, context or filenames-only option. `src/workspace/search.ts` invokes ripgrep with `--max-count 20`, which limits matches **per file** before the service's global limit is evaluated. A live pattern that matched more lines returned 20 hits with `truncated: false`. Therefore the current `truncated` field can report a complete result incorrectly. The Node fallback also has different termination behavior and needs parity tests.
2. `read_file` already delegates to `Workspace.readFile`, with line windows, byte bounds, binary denial, restricted paths and symlink protections. `git_diff` and `git_compare` already have **byte-offset pagination**; `git_status` already gives staged/unstaged/untracked path summaries. Build upon these operations, not parallel implementations.
3. In the ChatGPT connector session, successful `read_file` and `git_browse` calls against existing files surfaced as `{}` while directory listing, searches and branch comparison returned normal data. **The responsible layer is not established.** Reproduce against the broker directly and via ChatGPT; inspect serialized tool result and connector exposure before modifying C2C reader logic. An apparently empty wrapper must not be treated as proof that file content is empty.
4. `src/mcp/command-tools.ts` registers `request_command` and `get_command_request`; `src/mcp/server.ts` registers them only when broker registry and command service are present. Linux broker initialization is conditional; `workspace.command` is an additional, non-default scope. The ChatGPT session exposes 17 tools and omits these two. This proves an availability gap, **not** its cause.
5. Repository snapshot inspection already requires exact local or remote-tracking Git refs and existing repository authorization. No need for checkout or `git fetch`.
6. **Authorization is not a single read scope:** `read_file`/`workspace_info` use `workspace.read`; `search_workspace` uses `workspace.search`; `git_diff` uses `git.read`; `git_compare` and branch snapshot tools use `git.repository.read`. Command requests require `workspace.command`. Preserve these distinct checks in every new/extended handler.

## 4. Phase 0 — correctness first

### 4.1 Diagnose empty read results

- Use a disposable, non-sensitive fixture containing a short known ASCII marker and a second larger fixture. Compare broker MCP responses for `read_file` and `git_browse` with the same requests made from ChatGPT.
- Record the transport/tool-list version, broker `version`/`revision`/`profile`, requested worktree and exact success/error envelope. Distinguish server serialization, gateway/connector transformation, tool-result filtering and client display.
- If the bug is in C2C, fix it at the narrowest layer; retain existing response fields, pagination and error codes. If external, document a reproducible trace and the necessary connector action rather than inventing a code fix.
- Acceptance requires **usable content**, not merely HTTP/MCP success. Never print real secrets while debugging.

### 4.2 Correct search completeness

- Remove or redesign the hidden `rg --max-count 20` cap. All limits that can omit *eligible* matches must produce an explicit indication, not `truncated: false`. Retain the existing 2 MiB ripgrep per-file eligibility limit as a documented search boundary; do not imply larger files have been searched. Check whether the Node fallback has the same eligibility policy.
- Define `matchCount` as **matches returned on this page**, not total matches in the workspace. Do not imply an exact global total unless counted.
- Determine whether a further eligible matching result exists by reading at least one extra match beyond the requested page where feasible. Distinguish `has_more: true` (a next page is known) from `truncated: true` with `truncation_reason: "scan_limit"` (completeness is unknown); do not invent a usable `next_offset` when a resource cap stops the scan. Never signal completeness if it cannot be established.
- Match global bounds, path filtering, symlink/secret blocking and basic output semantics in both ripgrep and Node-fallback paths. Cover files with more than 20 matching lines and matches distributed across many files.
- Keep a bounded search; do **not** replace the removed per-file cap with unbounded buffering.

## 5. Phase 1 — search API

Extend `search_workspace` compatibly:

```ts
{
  workspace?: string;
  worktree?: string;
  query: string;
  path?: string;
  glob?: string;
  regex?: boolean;           // existing; false by default
  limit?: number;            // existing; max 200
  offset?: number;           // new; default 0; matched-line or distinct-file offset by mode
  context_lines?: number;    // new; default 0, bounded 0..3
  files_only?: boolean;      // new; default false
}
```

- Default response remains compatible: `matches`, `matchCount`, `truncated`, `engine`. Add `has_more`, `next_offset` and, if needed, `truncation_reason`. `files_only=true` returns bounded **distinct workspace-relative paths**, not matched lines; pagination counts files in this mode. Include enough mode metadata to avoid ambiguity.
- Sort by normalized workspace-relative path, then line number; in ripgrep use deterministic path traversal (`--sort path` or equivalent), and align Node fallback. Return stable pages for an unchanged tree with the same query/options. No stateful indexing or search-session persistence.
- `offset` is best-effort for a **moving working tree**: repeated requests are coherent when relevant files do not change; edits between pages may change ordering/content. Document this rather than promising snapshot isolation. If worktree mutation is detected cheaply, signal it; otherwise do not invent consistency guarantees.
- Context rows are grouped with their owning match and deduplicated where appropriate. Cap **combined response bytes**; count this expansion against budget, and preserve match locations. Offset/limit count matches (not context lines). If expanding context exhausts the budget, signal the partial context rather than silently omitting it. `files_only` avoids content output and is preferred for discovery.
- Keep regex/literal semantics, globs and workspace selection unchanged. Reject invalid offset/limits cleanly; bound cumulative scan cost, not only returned bytes. Do not return a false `has_more: false` when an offset/scan cap prevents proving completeness. Use one bounded scan rather than repeated searches per skipped match.

## 6. Phase 1 — Git change summaries

Add `view?: "full" | "summary"` to **both** `git_diff` and `git_compare`; default to `full` so existing callers and existing byte-offset pagination remain unchanged.

- In `summary`, return changed files with change type (add/modify/delete/rename where Git reports it), old/new paths when relevant, and insertion/deletion counts from `--numstat` where available. Treat binary counts as `null`, not zero. Use Git-safe NUL-delimited parsing; preserve filenames containing whitespace or line breaks.
- Return bounded results (e.g. up to 100 files per page) with `has_more` and `next_summary_offset`; use a **separate** `summary_offset` input, leaving `offset` explicitly byte-oriented in `full` mode. Reject a *nonzero* offset for the wrong view (existing callers may send `offset: 0`); never silently reinterpret byte offsets as file offsets. Cap the total summary output and Git computation.
- Honor the existing `mode` (`unstaged` / `staged` / `head`) for `git_diff`, and the existing **merge-base-to-target** semantics plus exact refs/commit expectations for `git_compare`. Do not silently switch to tip-to-tip comparison. Derive status and statistics from the same comparison options and use the existing path allowlist/sensitive-path filtering (including **both** rename paths); do not produce a raw, unsanitized `--numstat` inventory.
- `git_diff` does not include untracked files; state this clearly. `git_status` remains the source for untracked filenames; no implicit reading of their contents. A changing working tree can produce different status and numstat observations between Git calls; do not claim atomic snapshot semantics for workspace diffs.
- Keep the existing path filtering, Git/environment isolation, repository/worktree ownership and output limits. No checkout, fetch, or repository mutation.

## 7. Phase 1 — bounded `read_files`

One thin MCP endpoint over existing `Workspace.readFile`, accepting the same opaque workspace and worktree selectors:

```ts
{
  workspace?: string;
  worktree?: string;
  files: Array<{
    path: string;
    start_line?: number;
    end_line?: number;
  }>;
  max_total_bytes?: number;
}
```

- Restrict to **1–10 items**; cap total returned **serialized response** (initial target: **256 KiB**, including metadata/error strings), plus existing per-file line/byte boundaries. Do not expose absolute paths or return unbounded errors. Output records must preserve request ordering, path, line range, truncation/continuation metadata and a clear per-file error status. Invalid selectors or a malformed top-level request fail as a whole; individual file read failures are per-item.
- Reuse current path resolution and sensitive-file exclusions for **every** item. One denied file must not bypass security checks for any other item. Return a bounded error for it; other valid items may succeed independently.
- Define deterministic budget allocation (input order), and signal when later files are skipped or truncated by the shared cap. Avoid silently dropping files or presenting a partial read as complete.
- No new file cache, index or alternate source-of-truth. `read_file` remains available and unchanged.

## 8. Phase 1 — existing command tools availability

The approved command feature is **already specified and implemented** in [SPEC-004](../specs/spec-004-approved-local-command-execution.md) and [CHANGE-009](change-009-approved-local-command-requests.md). This change covers **visibility and diagnosis only**:

1. Verify Linux broker command-state initialization and actual live `tools/list`; compare against the connector's advertised tools and `workspace_info` identity. **Tool registration is gated by broker services, not by the caller's OAuth scope check in the tool handler.** Do not assume a missing scope explains a tool absent from `tools/list`.
2. Separately verify OAuth client grant includes `workspace.command` for invocation; existing grants must not acquire it implicitly. Apply the documented fresh authorization/reconnection procedure if needed, then re-check discovery **and** a permission-denied invocation test.
3. If needed, fix actual broker/connector tool advertisement or refresh semantics. Do **not** expose commands in legacy/non-Linux modes where the command service is unavailable; do not bypass required scope checks.
4. Smoke-test only a harmless command **after explicit local approval**, and read the request receipt. Do not auto-approve, execute arbitrary commands on discovery, or change command lifecycle.

## 9. Phase 2 — bounded `git_history`

Introduce a read-only `git_history` operation consistent with branch snapshot tools:

```ts
{
  workspace?: string;
  ref: string;                  // exact local or remote-tracking ref
  path?: string;                // repository-relative filter
  limit?: number;               // default 20, max 100
  offset?: number;              // default 0
  expected_commit?: string;     // pin ref identity across pages
}
```

- Return commit SHA, timestamp, author display name, subject and bounded path/revision metadata; no full patch bodies and no arbitrary filesystem access. Keep output compact and deterministic. Do not leak author email addresses or unfiltered sensitive-path names. Treat commit messages as untrusted, length-bounded text.
- Validate refs with the **existing snapshot ref resolver** and `git.repository.read` permission. Use safe argv with `--` path separation, path validation and the existing Git-safe environment. No fetch, checkout or mutation.
- Include the resolved ref commit on every page; require matching `expected_commit` on subsequent pages to reject a changed branch. Read history from the pinned commit and define traversal/order explicitly; do not promise rename-following semantics. Bound work done for large offsets and respect sensitive-path restrictions even when no path filter is provided.
- This tool helps investigate regressions; avoid committing to `git blame`, `git show` or unrestricted history queries in this change.

## 10. Phase 2 — `workspace_info` diagnostics

Extend the existing response **additively**, retaining broker identity and project/git metadata:

- Include capability diagnostics for the active broker with distinct fields for **registered on this MCP server**, **authorized for this caller**, and **unavailable reason** (`service_uninitialized`, `platform_unsupported`, `scope_missing`, etc.). A missing scope must not be described as an unregistered tool. `connector_refresh_required` must not be inferred from broker state alone; external connector visibility must be verified separately.
- Report a sanitized view of scopes granted to **the current caller**, when the server can determine them, and scopes required for capability groups. Never expose bearer tokens, credential metadata or other clients' grants.
- Avoid duplicating a second hardcoded tool registry: derive capabilities from registration/gating definitions wherever practical. A small authoritative capability map is acceptable if necessary.
- In this change, diagnostics should explain the missing command tools. A separate `c2c broker tools` CLI is **not required**.

## 11. Compatibility and security

- All additions must be backward compatible: existing tool names, default output structure, path restrictions, worktree semantics, repo comparison semantics, scopes and approval flows remain valid.
- Preserve each exact existing authorization boundary: `read_files` → `workspace.read`; `search_workspace` → `workspace.search`; `git_diff` (both views) → `git.read`; `git_compare` (both views) and `git_history` → `git.repository.read`; command tools → `workspace.command`. `workspace_info` continues to require `workspace.read`. No new broad privileges or scope substitutions.
- Enforce output and resource bounds at the data source, including context expansion, summary pages, per-file read batching, and history. A tool success must not imply a complete result when it is partial.
- Respect ignored/noisy/sensitive paths and symlink escape prevention on all code paths. Untrusted repository text must not become executable instructions.
- No shell-command execution via any new read tool; no remote code execution, automatic testing, or automatic local approvals.

## 12. Testing and validation

Implement focused automated tests plus one broker-to-ChatGPT smoke check after connector refresh. Do not require full end-to-end suites for every small iteration; run the relevant suites and TypeScript checks for affected surfaces.

| ID | Acceptance criterion |
| --- | --- |
| A1 | `read_file` and `git_browse` content is verified at both broker MCP and ChatGPT connector layers; root cause of `{}` is documented or fixed at the responsible layer. |
| A2 | A single file with 21+ matching lines does not return `truncated: false` when additional results are omitted. |
| A3 | Searches crossing global limits page deterministically without duplicate or missing results when the workspace is unchanged. |
| A4 | `files_only` returns unique paths; context expansion is correctly bounded; ripgrep and fallback meet the same external contract. |
| A5 | Both Git summary modes return status and accurate text/binary counts, including rename cases, without changing `full` pagination or merge-base behavior. |
| A6 | `read_files` honors item count, shared byte budget, ordering, individual errors and existing secret/symlink denial. |
| A7 | For an initialized Linux broker, compare raw MCP `tools/list` against connector discovery separately from invocation scope checks. Authorized requests still require explicit local approval; missing-scope calls fail without creating pending state. Diagnose any external exposure blocker. |
| A8 | `git_history` is bounded, read-only, filters sensitive paths even without a path argument, excludes author emails, and rejects ref drift across pages. |
| A9 | `workspace_info` distinguishes registered tools from caller authorization without claiming unverified connector visibility or disclosing tokens/unrelated clients. |
| A10 | Existing readers, diff tools, write approvals and non-Linux/legacy behavior pass regression checks. |

## 13. Implementation sequence

1. Reproduce and isolate read-content delivery anomalies; fix the responsible layer (if within C2C).
2. Fix search correctness with regression tests. **Do not defer this behind feature work.**
3. Verify command-tool registration/discovery and caller grants early, to catch tool-surface refresh problems **before** adding further MCP tools; do not relax the approval boundary.
4. Add search pagination/context/`files_only`, then Git summaries, then `read_files` with focused tests.
5. Add bounded Git history and capability diagnostics; their implementation may follow later without blocking the Phase 0/1 release.
6. Update `docs/chatgpt.md`, `docs/protocol.md`, `docs/security.md`, relevant architecture/troubleshooting docs, and `skill/SKILL.md` where tool selection or permissions change. Regenerate/reload connector tool metadata only by the documented method and verify the **live** tool surface.

## 14. Non-goals

- No new storage/index/search daemon, persistent cursor backend or global repository cache.
- No replacement of existing `read_file`, `git_diff`, `git_compare`, `git_status`, patch approval or command approval.
- No unrestricted execution, arbitrary Git commands, `git blame`, `git show` patch streams or automatic fetches.
- No change to OAuth defaults or automatic grant of `workspace.command`.
- No mandatory `c2c broker tools` command or other CLI redesign.

## 15. Definition of done

Phase 0 is complete only when search cannot falsely imply completeness **within its declared eligibility boundaries** and the observed empty-read symptom has a proven explanation (with any in-scope fix). Phase 1 is complete when the new/extended contracts work against a live broker and the ChatGPT-facing surface, not only unit tests. Phase 2 can be completed separately under this same change document. Record verification evidence and any external connector dependency before marking the overall change complete.
