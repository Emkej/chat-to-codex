# Security Model

## Trust boundaries

```
OAuth authorization  →  C2C installation (one Claude connector)
Local capability     →  workspace / Codex session
Filesystem boundary  →  explicit registered root plus validated derived worktrees
```

1. **Installation** is the Claude authorization boundary. One OAuth relationship
   covers every registered Codex workspace on this machine.
2. **Workspace** is the local Codex capability boundary. Sessions track liveness;
   registry ids are opaque to the remote MCP client and map only to explicitly
   registered roots. A registered Git main worktree may additionally expose
   current, validated linked worktrees through opaque `worktreeId` values.
3. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Tool descriptions carry explicit warnings and never grant
   capabilities based on file content.
4. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between the connector client and the broker.

### Legacy per-project bridge (compatibility)

Older C2C builds bound OAuth tokens to a single `workspace_id` with one bridge
per project. That model remains available via `c2c start` / `c2c serve` during
migration. New installations should use the installation-level broker (`c2c
setup`, `c2c broker start`).

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong installation) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` / `c2c broker` revoke |
| Invented workspace id | Registry lookup fails closed; Claude cannot nominate arbitrary filesystem roots |
| Invented or stale worktree id | The broker re-enumerates the registered main worktree and fails closed; it never falls back to the main root |
| Linked-worktree overreach | A linked worktree cannot own or enumerate peers; explicit linked registration remains exact-root-only |
| Git repository redirection | Centralized Git reads remove inherited repository-location overrides such as `GIT_DIR`, `GIT_WORK_TREE`, and object-directory variables |
| Workspace traversal | `realpath` canonicalization; containment check against the canonical root; case-insensitive comparison on macOS/Windows |
| Symlink escape | Canonicalization resolves symlinks before the containment check |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes; git_diff paginates with hard caps; search caps matches and file sizes |
| Tunnel exposure | Broker binds loopback only; public surface is HTTPS via the tunnel with OAuth on `/mcp`; `/health` through the tunnel returns only service/version/status (installation identity is loopback-only) |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + proxy-forwarded requests rejected; unauthenticated probes get 404; session/workspace admin endpoints are not reachable through the Claude MCP tunnel |
| Stale session / revoked workspace | Session heartbeats fail closed on unknown ids; workspace removal stops new sessions; MCP reads fail closed for revoked ids |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings |
| Prompt injection via repo | Tool descriptions state content is untrusted data; there is no direct file or command tool. `propose_patch` can only create a pending request; a local `c2c approve` is required before a workspace write. |

## Token & scope design

Scopes include `workspace.read`, `workspace.search`, `git.read`,
`execution.read`, `offline_access`, and the explicitly requested
`workspace.write`. The write scope is supported but is never part of default or
implicit grants; only `propose_patch` requires it. Receipt tools require
`workspace.read`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. Installation-level
tokens authorize the broker; workspace access resolves through the local
registry and, when requested, the registered main worktree's current
Git-derived targets at request time. Worktree paths remain local-only.

## Unified patch writes (SPEC-002 V1)

SPEC-002 V1 write requests are supported only when the broker runs on Linux/WSL.
The broker holds the installation writer with Linux `flock`; other platforms
fail closed with `WRITE_OWNER_UNAVAILABLE`. Windows support is deferred to
future separately validated work, and macOS is out of scope unless separately
proposed. Neither platform's validation is a V1 completion condition.

If write ownership is unavailable, the broker leaves the SPEC-002 write
service, MCP write tools, and write-request admin router absent while retaining
the existing read-only MCP surface.

The observed ChatGPT host result is Probe A `BLOCKED` and Probe B `SUPPORTED`.
The shipped path is `propose_patch` plus local `c2c approve`; native
`apply_patch` and the conditional manual clipboard/file/stdin import are not
shipped. See the [capability probe evidence](verification/artifacts/spec-002/mcp-write-probes.md).

`propose_patch` accepts only a unified text patch for create/update operations
within the selected workspace or worktree. It prepares and validates the full
patch, then stores a pending C2C request; it does not mutate project files.
The local broker re-resolves the target and rechecks security and content
preconditions when `c2c approve` runs. Broker requests share one exclusive
installation writer and serialized write lifecycle.

The shared boundary rejects workspace `.git` and `.c2c` control paths,
`.c2c.json`, `.c2cignore`, sensitive paths, symlink escapes,
delete/rename/move, binary and mode-only changes. It also protects the
canonical C2C installation state directory and C2C home roots. A patch is
limited to 1 MiB, 50 files, and 1 MiB per source/result file; updates require
the exact original-byte SHA-256 precondition. No shell or command execution is
available. These checks serialize C2C writes and detect stale targets; they do
not control arbitrary external filesystem writers.

After an applied receipt, ChatGPT must independently re-read affected files
and inspect the relevant diff before reporting success. A receipt or matching
hash alone does not establish semantic correctness.

## Storage

State lives under the C2C state directory (`~/.c2c/state` after systemwide
install, or the OS app-data convention), directories 0700, files 0600. Named
tunnel metadata lives there too — never in the project. Only SHA-256 hashes of
tokens are persisted.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere.

## Direct capabilities Claude does not have

Claude cannot directly write/delete files, run shell commands, commit, register
workspaces, select arbitrary filesystem roots, nominate worktree paths, or
create Codex sessions. The broker exposes no general-purpose file writer or
command tool. An explicitly authorized client may submit a narrow unified-text
proposal; only the local C2C approval path applies it. A client may select only
an opaque registered workspace id and optional opaque derived worktree id
validated by the broker.
