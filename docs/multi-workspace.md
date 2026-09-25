# Multi-workspace broker architecture

One Claude connector (Claude Free allows exactly one) must serve every Codex
project on this machine. This document is the implementation plan and the
record of the decisions behind it.

## Decision

The authorization principal is the **C2C installation**, no longer an
individual workspace.

```
Claude
 │  OAuth once (installation-bound token)
 ▼
C2C Workspace Broker  ── one stable MCP URL (Cloudflare Named Tunnel)
 │
 ├── Workspace Registry   workspace_id → canonical_root (local only)
 │   └── Derived targets  worktree_id → validated linked root (live Git view)
 ├── Session Registry     session_id → workspace_id (local only)
 ├── Write Request Service (broker-owned, local state)
 └── scoped MCP reads, pending patch proposals, and receipt reads
```

Security hierarchy:

```
OAuth authorization  = C2C installation
Codex boundary       = workspace/session capability
Filesystem boundary  = explicit registered root plus validated derived worktree
```

Target hierarchy:

```text
installation
└── registered workspace
    └── optional derived worktree target
```

Claude authorization boundary is the installation. The individual workspace
is a local Codex capability/session boundary. The remote MCP client has no
direct file or execution tool. When explicitly authorized with
`workspace.write`, it may submit a narrow patch proposal; the proposal changes
only local C2C pending state. The local `c2c approve` command is required for
workspace mutation.

SPEC-002 V1 write requests are supported only on Linux/WSL. Windows support is
deferred to future separately validated work; macOS is out of scope unless
separately proposed.

## Request routing (the concurrency decision)

An incoming MCP request must select a workspace without a global "active
workspace" (multiple Codex sessions can be open at once) and without
client-supplied session identity (Claude.ai connectors cannot send custom
headers and the broker is stateless Streamable HTTP).

**Decision: an opaque `workspace` argument on every scoped tool**, resolved
strictly against the local Workspace Registry:

- opaque: `flow-1a2b3c4d` — slug + 8 hex of sha256(canonical root)
- resolvable only against locally registered workspaces
- never convertible into arbitrary filesystem access (every path operation
  canonicalizes and confines beneath the resolved root, as today)
- missing/unknown/unregistered workspace id → fail closed (no default)
- an optional opaque `worktree` selector is resolved only beneath a registered
  main worktree; paths are never accepted from the client
- patch proposals and remote receipt reads use the same resolved
  `workspaceId` plus optional `worktreeId`; receipts are filtered to that
  concrete target and never contain raw patch bodies or absolute paths

`list_workspaces()` enumerates registered workspace ids and
`list_worktrees(workspace)` enumerates current derived ids beneath an eligible
registered main. The broker returns names, branches, and commits, but roots
never leave the machine.

Rejected alternatives:

- *custom header / mcp-session-id routing*: Claude.ai cannot set headers on
  a custom connector.
- *broker-side conversation binding*: there is no stable client-side
  conversation identity to bind to.
- *single global active workspace*: breaks concurrent sessions and lets a
  poisoned conversation retarget reads.

## Domain model

- **Installation identity** — stable `installation.json` in the state dir:
  `{ installationId, schemaVersion, createdAt }`. The OAuth principal.
- **WorkspaceRegistry** (`workspaces/registry.json`) —
  `{ id, displayName, canonicalRoot, registeredAt, updatedAt }`.
  Registration happens locally via Codex/C2C only; Claude cannot register
  roots. Idempotent per canonical root (deterministic id).
- **SessionRegistry** (`workspaces/sessions.json`) —
  `{ sessionId, workspaceId, startedAt, expiresAt, pid? }` with TTL and
  heartbeat. Local liveness/revocation semantics for Codex activity; not a
  Claude-presented credential. Sessions may only be created for registered
  workspaces and die with them.
- **Derived worktree target** — a live Git worktree record addressed by an
  opaque deterministic id. It has no durable registry entry and inherits the
  parent workspace id.

## Not exposed to Claude

- filesystem roots (absolute or relative)
- session ids
- registration/activation mutation (`register_workspace`, `set_workspace`,
  `execute_in_workspace` …). If a Claude-side workspace *switch* is ever
  wanted, it must be a request requiring local approval — deliberately not
  built now.
- direct file mutation and shell execution. The only shipped patch path is
  `propose_patch` → pending local receipt → explicit `c2c approve`; Probe A
  blocked the native `apply_patch` tool for this host. See the [capability
  evidence](verification/artifacts/spec-002/mcp-write-probes.md).

## Tool surface (target)

- Broker: `list_workspaces` and `list_worktrees` plus the eight scoped readers
  (10 read tools), `propose_patch` (one pending-request tool), and
  `list_write_requests` / `get_write_request` (two read-only receipt tools).
- Legacy bridge: the existing nine read-only tools remain exact-root-only; it
  does not expose `list_worktrees` or any write-request tool.
- `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary` — unchanged
  semantics plus an optional opaque `worktree` selector in broker mode.
  Missing/unknown workspace or worktree context fails closed.
  `test_status`/`execution_summary` remain recorded-results readers; they
  never execute anything.

## OAuth migration

OLD token payload binds `workspace_id`. TARGET binds
`installation_id` (+ principal + scopes); workspace authorization resolves
through the registry/capability layer at request time.

Requirements preserved: DCR, PKCE, token validation, revocation, one-time
pairing. A token authorizes exactly one installation; it cannot reach
another installation's broker.

Migration is schema-detected and non-destructive: legacy workspace-keyed
auth files are readable, upgraded explicitly into installation identity,
and left in place for rollback. No silent rewrite.

## Stable endpoint

The persistent connector requires a stable URL, so the default endpoint
becomes a Cloudflare **Named Tunnel** in front of the always-on broker.
Quick Tunnel remains available for development/diagnostics/testing. Setup
presents the choice progressively and must not get worse for users without
a domain.

## Slices

1. **Domain model + tests** — done (`installation.json`, registry, sessions).
2. **Registry-backed broker MCP resolution** — done (opaque `workspace` arg).
3. **Session lifecycle in CLI** — done (`c2c use`, `c2c use --end`, heartbeats).
4. **MCP integration** — done (`tests/broker.test.ts`, `tests/mcp-integration.test.ts`).
5. **OAuth installation migration** — done (`c2c broker migrate-auth`, broker OAuth tests).
6. **CLI lifecycle + stable connector UX** — done (`c2c setup --mode`, `broker tunnel`).
7. **E2E multi-project validation + docs** — automated in broker tests; human Claude Web validation remains manual (see `docs/local-e2e.md`).
8. **Worktree-aware broker access** — broker target selection, local CLI reuse,
   Git hardening, and legacy compatibility are covered by SPEC-001 tests.

## Threat model answers

| # | Case | Behavior |
| --- | --- | --- |
| 1 | Repo content tells Claude to switch workspaces and read secrets | Claude may select any *registered* workspace id — registry scope is the boundary; unregistered/revoked ids fail closed. No path nomination exists. |
| 2 | `read_file(workspace, "../../../etc/passwd")` | Path canonicalization + confinement per resolved root, unchanged — `PATH_OUTSIDE_WORKSPACE`. |
| 3 | Claude invents a workspace id | Registry lookup fails → error. |
| 4 | Valid id from "another session" | Ids address workspaces, not sessions; reads and receipts stay scoped to the selected target. A proposal creates only local pending state and requires local approval before mutation. Session ids are never Claude-facing. |
| 5 | Two Codex sessions simultaneously | Independent session records; no shared mutable workspace pointer. |
| 6 | Registered workspace deleted/moved | Root no longer resolves → operations fail closed; registration can be repaired locally. |
| 7 | OAuth token survives broker restart | By design (persisted store) — it authorizes the installation, scoped tools still confine reads. |
| 8 | Session expires, OAuth valid | Sessions gate local Codex capabilities/status, not the installation token; workspace stays readable only if registered. |
| 9 | Workspace revoked locally | `remove(id)` → id no longer resolves → fail closed. |
| 10 | Legacy workspace-bound OAuth state after upgrade | Schema-detected, read non-destructively, explicit upgrade; legacy files kept for rollback. |
| 11 | Claude reconnects with same connector | Same installation identity; no re-pairing. |
| 12 | Tunnel endpoint changes | With named tunnel it should not; if it does, re-add connector (existing repair flow). |
| 13 | Named tunnel offline | Broker unreachable → Claude fails; local Codex unaffected. |
| 14 | Tool called without/with invalid workspace context | Fail closed with an error listing nothing but the instruction to use `list_workspaces`. |
| 15 | Registered main has linked worktrees | `list_worktrees` returns opaque current ids; scoped readers may select one and preserve the parent workspace id. |
| 16 | Linked worktree is explicitly registered | Exact registration wins; it remains exact-root-only and does not gain peer enumeration. |
| 17 | Worktree is moved, deleted, prunable, or stale | Re-discovery rejects the target; no fallback to the main root. |
