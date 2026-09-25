# Local E2E validation — Claude Web ⇄ C2C broker

Recorded 2026-08-30 on macOS (arm64), Node v26, cloudflared 2026.8.2.
Re-verified 2026-08-31 at commit `bd06466` (multi-workspace slices 1–7 complete).
SPEC-002 host capability result rechecked 2026-09-24; see the [probe evidence](verification/artifacts/spec-002/mcp-write-probes.md).

The earlier macOS record covers the pre-SPEC-002 local E2E flow. SPEC-002 V1
write requests are supported and validated on Linux/WSL only; Windows support
is deferred, macOS is out of scope, and neither platform's validation gates V1
completion.

Run the automated checklist:

```bash
pnpm test:e2e
```

This executes `tests/local-e2e-broker.test.ts` — OAuth (DCR + PKCE + pairing), two
workspaces, `list_workspaces`, scoped reads, session status, and sensitive-file
denial — without a tunnel or Claude Web login.

**Automated protocol result: YES.** A remote MCP client can connect through
the installation broker, complete OAuth (DCR + PKCE + one-time pairing), use
scoped reads and receipts, and submit a pending patch proposal only with
explicit `workspace.write`. Proposal creates C2C pending state without changing
project files; local `c2c approve` is required before the broker applies it.
There is no native direct `apply_patch` path or command-execution tool.

**Claude Web UI clicks: not machine-verified.** The scripted connector client
(`scripts/poc-client.mjs` and Vitest MCP integration tests) exercise the same
protocol Claude performs; clicking through Claude's own connector UI still
requires a human login.

## Live installation (`~/.c2c`)

After `c2c install`, exercise the running broker (loopback by default):

```bash
pnpm build && node bin/c2c.js install
c2c broker stop && c2c broker start
pnpm test:e2e:live
```

Optional public tunnel check:

```bash
C2C_E2E_URL=https://your-host.example.com pnpm test:e2e:live
```


## Broker-first procedure (current)

1. **Prerequisites**: Node.js ≥ 20, git, `cloudflared`.
2. From the first project: `c2c setup --mode quick` (or `c2c setup --mode named --zone <domain>`; or `c2c broker start` + `c2c use` +
   `c2c broker pair` when splitting steps). This starts the installation
   broker, establishes a public HTTPS endpoint (Quick Tunnel by default), registers
   the workspace, and prints the stable `/mcp` URL plus a pairing code when the
   installation is not yet authorized.
3. **In Claude Web**: Customize → Connectors → Add custom connector → paste the
   `/mcp` URL → complete OAuth → enter the pairing code on the C2C page.
4. Enable the connector and call `list_workspaces`, then scoped tools with the
   opaque `workspace` argument (e.g. `workspace_info`).
5. **Add another project or linked worktree**: `cd` to it and run `c2c use`
   (or start Codex with the skill). A linked worktree covered by a registered
   main returns the parent `workspaceId` plus an opaque `worktreeId`; it does
   not create a duplicate registration. No new connector, OAuth, or pairing
   is required.
6. **Codex cycle**: Codex mutates locally, records via
   `c2c record --task <id> --iteration <n> --tests …`, then Claude inspects
   through `git_status`, `git_diff`, `test_status`, and `execution_summary`.
   When using the approved patch path below, Claude must inspect the resulting
   files after local approval before reporting DONE.

## SPEC-002 approved patch path

The recorded host result is Probe A `BLOCKED` / Probe B `SUPPORTED`. The
current path is:

1. ChatGPT calls `propose_patch` with the same opaque `workspace` and optional
   `worktree` as read tools; the call requires explicitly authorized
   `workspace.write` and creates only a pending request.
2. The user may inspect `c2c pending --diff`, then approves with
   `c2c approve [request-id]` or rejects with `c2c reject [request-id]`.
   Implicit selection uses the concrete target containing cwd and fails safely
   when multiple requests match.
3. After an applied receipt, ChatGPT calls `list_write_requests` or
   `get_write_request`, independently reads each changed file, and inspects
   `git_diff` when useful. `APPLIED` is not `VERIFIED` or `DONE`; hashes alone
   are not semantic verification.
4. If a precondition is stale, the broker persists a terminal stale/expired
   receipt and does not apply the patch. A correction requires another
   proposal and local approval.

The clipboard/file/stdin `c2c patch` import is conditional on Probe B being
blocked, so it is not part of this supported host configuration. Native
`apply_patch` is conditional on Probe A being supported and is not shipped for
this result.

## What automated tests validate

- **OAuth**: DCR, PKCE S256, pairing limits, refresh rotation, RFC 7009
  revocation, unauthenticated `/mcp` → 401 with `WWW-Authenticate`.
- **MCP surface**: ten scoped broker readers, one `propose_patch` tool
  (`readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`),
  and two read-only receipt tools. Proposal requires `workspace.write`; the
  read-only receipt tools require `workspace.read`. The legacy bridge remains
  at nine read-only tools and exposes none of these three write-request tools.
  Native `apply_patch` is absent for the recorded Probe A result.
- **Multi-workspace**: cross-workspace isolation, invented ids fail closed,
  revoked workspaces fail closed, live sessions reflected in `list_workspaces`.
- **Worktrees**: registered main + linked discovery, opaque target selection,
  parent workspace identity preservation, stale/moved/prunable target rejection,
  selected-root traversal confinement, and no path leakage.
- **Boundaries**: `.env` → `ACCESS_DENIED_SENSITIVE_FILE`; path escapes →
  `PATH_OUTSIDE_WORKSPACE`; broker binds loopback only; admin API rejects
  proxy-forwarded requests; `test_status` / `execution_summary` read recorded
  JSONL only.
- **Sessions**: admin session endpoints are loopback + admin-token only; heartbeats
  cannot create authorization for arbitrary roots (Vitest domain + broker tests).
- **Approved patch lifecycle**: broker proposal authorization, no project
  mutation before approval, workspace/worktree-scoped receipt privacy, local
  approve/reject/expiry/stale behavior, and concurrent lifecycle serialization
  are covered by `tests/mcp-write-requests.test.ts`,
  `tests/write-request-admin.test.ts`, `tests/write-request-cli.test.ts`, and
  `tests/write-requests.test.ts`.

## Legacy per-project bridge

`c2c start` / `c2c serve` still run a per-workspace bridge for compatibility.
The historical Quick Tunnel + nine-tool flow documented before the broker
migration is covered by `tests/mcp-integration.test.ts` against that bridge;
the legacy bridge remains exact-root-only.
New installations should prefer `c2c setup`.

## Setup friction found (and fixed)

- **Flaky loopback health probe → duplicate daemon split-brain** (#8): probe
  retry + duplicate-daemon guard.
- **Quick Tunnel URL churn**: `c2c doctor --fix` can re-establish the endpoint;
  named tunnels (`c2c broker tunnel choose --mode named --zone <domain>`) are recommended for a
  stable connector URL.

## Remaining notes

- `doctor --json` canonical field is `connectorRepair`; `chatgptRepair` is a
  deprecated alias (see [migration.md](migration.md)).
- Run `c2c` commands from the project root or pass `-w <path>`.
