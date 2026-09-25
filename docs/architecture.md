# Architecture

```
             ┌───────────────────────────┐
             │       Claude Web          │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Conversation
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │ C2C Installation Broker │
             │ MCP: scoped reads,      │
             │ proposals, receipts     │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             │  Write-request service │
             └──────────┬──────────┘
                        │ scoped reads / locally approved patch
                        ▼
             ┌─────────────────────┐
             │ Registered Workspace│
             │ + optional worktree │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **Bring your AI chat sessions to Codex.** The bridge never re-implements a coding harness.
- **Conversation = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: Claude pulls files/diffs/search results itself.
- **No generic writer or executor**: `propose_patch` can create a pending
  request when Probe B is supported; the local `c2c approve` path performs the
  workspace write through the shared policy.
- **The registered workspace is the durable security boundary**: the broker may
  select a validated derived worktree beneath a registered Git main worktree.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | Broker McpServer with 10 scoped read tools, `propose_patch`, and two read-only receipt tools; the legacy bridge remains at 9 read-only tools. Stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `write-requests/` | Exact unified-text patch preparation, protected-path/precondition checks, broker lifecycle serialization, staging/rollback, and terminal receipt persistence |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records written by `c2c record`, read by `execution_summary` / `test_status` |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: remote MCP client → tunnel (https) → broker `/mcp` → bearer
middleware (401/403) → stateless StreamableHTTP transport → broker target
resolver (`workspace` + optional opaque `worktree`) → workspace layer (path
containment → ignore rules → pagination) → JSON result.

**Broker target model**:

```text
registered workspace
        ↓
optional validated derived worktree
        ↓
existing Workspace/read/search/Git primitives
```

The registry id and optional worktree id are the only remote selectors. Git
worktree paths and repository identity remain local to the broker.

**Approved patch lifecycle**: `propose_patch` requires explicit
`workspace.write`, resolves the same workspace/worktree target, and persists
one pending receipt without changing project files. Local `c2c approve` or
`c2c reject` uses the loopback token-protected admin API and the same
broker-owned write service. The installation broker acquires exclusive
write-state ownership before serving; its lifecycle mutex serializes C2C
proposals, approvals, and rejections. The service revalidates writes; the
legacy `src/bridge/server.ts` remains read-only. External filesystem writers
are outside this lock boundary.

SPEC-002 V1 write ownership is supported only on Linux/WSL, where the broker
uses `flock`. Other platforms fail closed with `WRITE_OWNER_UNAVAILABLE`;
Windows support is deferred to future separately validated work, and macOS is
out of scope unless separately proposed.

When write ownership is unavailable, the broker omits the SPEC-002 write
service, MCP write tools, and write-request admin router; its existing
read-only MCP surface can still start. This does not extend V1 write support.

The Probe A/B result selects the shipped MCP surface. A blocked / B supported
ships proposal plus local approval, not native `apply_patch` or manual import.
See the [capability evidence](verification/artifacts/spec-002/mcp-write-probes.md).

| Probe A | Probe B | MCP/write surface |
| --- | --- | --- |
| supported | supported | Reads, host-confirmed direct patch write, and proposal |
| supported | blocked | Reads and host-confirmed direct patch write; manual local import fallback |
| blocked | supported | Reads, proposal, and local broker approval (current outcome) |
| blocked | blocked | Existing read-only MCP surface |

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's Claude connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the Claude connector.
