# ChatGPT integration

ChatGPT can use the C2C installation broker as a remote MCP Plugin for planning,
repository inspection, and review while Codex remains the execution owner.

This document is the operational source of truth for ChatGPT-specific setup,
OAuth scope upgrades, MCP tool discovery, branch inspection, and recovery.

## Architecture

ChatGPT connects to the C2C installation broker through its public HTTPS `/mcp`
endpoint.

One broker can serve multiple registered workspaces. Workspace selection uses
opaque workspace IDs returned by `list_workspaces`; filesystem paths are never
sent through the connector.

Repository branches and Git worktrees are separate concepts:

- `list_worktrees` reports checked-out linked Git worktrees covered by a
  registered main workspace.
- `list_branches` reports exact local and remote-tracking branch refs.
- `git_browse`, `git_search`, and `git_compare` inspect committed branch
  snapshots without checkout, fetch, or filesystem mutation.

The repository-ref tools require the `git.repository.read` OAuth scope.

## Initial setup

Use ChatGPT in a web browser when creating or repairing a custom Plugin.

1. Start or verify the installation broker:

   ```bash
   c2c broker status
   ```

   For an isolated profile such as the development/test broker:

   ```bash
   c2c --profile test broker status
   ```

   The `c2ct` wrapper is equivalent for the persistent `test` profile where it
   is installed.

2. Copy the broker's public connector URL, including the `/mcp` suffix.

3. In ChatGPT enable Developer mode and open the Plugins page.

4. Create a new Plugin:

   - Name: choose a stable name such as `Chat to Codex` or
     `Chat to Codex Test`.
   - Connection: `Server URL`.
   - Server URL: the broker's public `/mcp` URL.
   - Authentication: `OAuth`.
   - Advanced OAuth client ID: leave empty so ChatGPT uses dynamic client
     registration.

5. Click **Authenticate**.

6. When the C2C authorization page is open, generate a fresh pairing code:

   ```bash
   c2c pair
   ```

   or for the test profile:

   ```bash
   c2c --profile test pair
   ```

7. Enter the pairing code and complete authorization.

8. Ask ChatGPT to call `list_workspaces` and confirm the expected installation
   responds.

Pairing codes are single-use and short-lived. Generate them at the moment the
authorization page requires one.

## Repository branch inspection

A branch does not need a linked worktree to be reviewed.

For an implementation branch such as:

```text
refs/heads/codex/change-067-reference-integrity
```

the normal review flow is:

1. `list_branches` — confirm the exact ref and commit.
2. `git_compare` — compare the integration branch to the target branch.
3. `git_browse` — read exact files from the committed target snapshot.
4. `git_search` — search the committed target snapshot when needed.

Do not infer branch absence from `list_worktrees`.

`list_worktrees` answers:

```text
Which linked worktrees are currently checked out?
```

`list_branches` answers:

```text
Which repository branch refs exist?
```

For review of a committed branch, prefer the repository-ref tools instead of
creating or switching a worktree only to make the branch readable.

## C2C upgrade model

Use the smallest recovery action that matches the change.

| Change | Required action |
| --- | --- |
| Broker implementation changed, existing MCP surface and scopes unchanged | Restart the broker. |
| New MCP tools were added | Restart the broker and refresh ChatGPT Plugin/tool discovery. Use a new conversation only if the current conversation still exposes the old tool surface. |
| A new OAuth scope was added | Perform a fresh OAuth authorization. Refreshing an old token is insufficient. |
| ChatGPT reconnect keeps the previous OAuth scope request | Remove and recreate only that ChatGPT Plugin entry using the same current MCP URL, then perform fresh OAuth authorization. |
| Public MCP URL changed | Remove and recreate the Plugin using the new URL. |
| Named-tunnel URL did not change | Do not recreate the Plugin merely because the broker restarted. |

Restarting the broker does not modify scopes on already-issued tokens.

Refreshing an OAuth token does not modify its recorded scope set.

MCP tool discovery and OAuth authorization are separate concerns and must be
diagnosed separately.

## OAuth scope upgrades

C2C does not silently expand privileges on existing tokens.

The installation broker includes `git.repository.read` in its default read
scopes for fresh broker authorizations.

Existing access and refresh tokens retain the scope set they were originally
issued with. Refresh-token rotation deliberately reissues the same recorded
scope set.

Therefore an older token cannot acquire `git.repository.read` through normal
token refresh.

Typical failure:

```text
INSUFFICIENT_SCOPE
This operation requires the 'git.repository.read' scope.
```

This result has a specific meaning:

- the MCP tool exists;
- the request reached the broker;
- the OAuth token is valid enough to authenticate;
- the token does not contain the required repository-read scope.

It is not evidence that:

- the branch is missing;
- the workspace is wrong;
- a Git worktree must be created;
- the repository-ref tool is broken.

### Expected repository-read consent

A fresh broker OAuth authorization should include the consent item:

```text
Read Git branches and committed repository snapshots
```

That label corresponds to:

```text
git.repository.read
```

If that permission is absent from a fresh authorization flow, stop and inspect
the client OAuth request or broker version rather than repeatedly retrying the
Git tool.

## Known-good ChatGPT repository-scope upgrade runbook

Use this procedure when C2C adds a repository capability or another OAuth scope
and an existing ChatGPT Plugin was authorized before that scope existed.

### 1. Verify the intended broker

For the default installation:

```bash
c2c broker status
```

For the test installation:

```bash
c2c --profile test broker status
```

If the broker binary or MCP implementation was upgraded, restart it:

```bash
c2c --profile test broker stop
c2c --profile test broker start
```

Confirm that the expected broker is running before changing ChatGPT
configuration.

### 2. Distinguish missing tool from missing scope

Ask ChatGPT to use the newly added tool.

For repository inspection, use:

```text
list_branches
```

There are two materially different outcomes.

#### Tool is not available

The client still has stale MCP tool discovery or is connected to an older
broker.

Verify the broker revision and refresh the Plugin/tool discovery. If the
current conversation still exposes the old tool schema, start a new
conversation and test again.

Do not change OAuth state until the tool itself is visible.

#### Tool exists but returns `INSUFFICIENT_SCOPE`

Tool discovery is already working.

The remaining problem is OAuth authorization.

Do not troubleshoot Git worktrees or branch existence at this point.

### 3. Do not rely on token refresh

An old refresh token cannot acquire a newly added scope.

C2C intentionally preserves the original scope set during refresh-token
rotation.

Waiting for token refresh or access-token expiry will not fix
`git.repository.read`.

### 4. Fresh-authorize the ChatGPT Plugin

If ChatGPT offers a genuine fresh authentication flow for the existing Plugin,
it can be tried once.

The acceptance criterion is not that the UI says "connected". The authorization
page must explicitly show:

```text
Read Git branches and committed repository snapshots
```

If reconnect completes but the repository tool still returns
`INSUFFICIENT_SCOPE`, do not repeat reconnect.

The locally verified ChatGPT recovery path is to recreate only the affected
Plugin entry.

### 5. Recreate only the affected ChatGPT Plugin entry

Do not delete the C2C installation, registered workspaces, Git branch, or
worktree.

In ChatGPT:

1. Remove the affected custom Plugin entry, for example
   `Chat to Codex Test`.
2. Create it again.
3. Use the same current broker `/mcp` URL if the URL has not changed.
4. Set Authentication to OAuth.
5. Leave the advanced OAuth client ID empty so ChatGPT performs dynamic client
   registration.
6. Click **Authenticate**.

When the C2C authorization page is open, generate a fresh pairing code:

```bash
c2c --profile test pair
```

or for the default profile:

```bash
c2c pair
```

Confirm that the authorization page contains:

```text
Read Git branches and committed repository snapshots
```

Enter the pairing code and complete authorization.

Keep the ChatGPT browser tab active until the OAuth flow has completed.

### 6. Verify the actual capability

Authentication success alone is not sufficient verification.

Call the capability that required the new scope.

For repository access:

```text
list_branches(workspace=<registered main workspace>)
```

Recovery is complete only when that call succeeds.

If reviewing a known branch, also confirm that the exact ref is returned.

Example:

```text
refs/heads/codex/change-067-reference-integrity
```

Only after this check should normal branch review continue.

## `unpair` is a broad fallback

Do not use `c2c unpair` as the default repository-scope upgrade procedure.

Top-level:

```bash
c2c unpair
```

and profile-specific:

```bash
c2c --profile test unpair
```

revoke all OAuth tokens in that C2C installation/profile.

This can affect multiple remote MCP clients sharing the same broker
installation.

Use `unpair` only when intentionally invalidating all authorization state for
that profile.

For a normal ChatGPT scope upgrade, prefer fresh authorization or recreation
of only the affected ChatGPT Plugin entry.

## Plugin recreation vs. C2C installation recreation

Removing a ChatGPT Plugin entry does not remove:

- the local C2C installation;
- registered C2C workspaces;
- Git branches;
- Git worktrees;
- the broker configuration;
- the named tunnel configuration.

When the public `/mcp` URL is unchanged, recreating the ChatGPT Plugin is a
client-side OAuth/tool-discovery repair only.

Do not run a full C2C setup again merely to refresh a ChatGPT OAuth grant.

## Tool missing vs. insufficient scope

These failures have different owners and different fixes.

| Symptom | Interpretation | Next action |
| --- | --- | --- |
| `list_branches` is not available to ChatGPT | Stale MCP tool discovery or older broker | Verify broker, refresh Plugin/tool discovery, use a new conversation if necessary |
| `list_branches` exists but returns `INSUFFICIENT_SCOPE` | OAuth token lacks `git.repository.read` | Fresh OAuth authorization; recreate the affected Plugin entry if reconnect preserves old scopes |
| `list_branches` succeeds but target branch is absent | Branch ref is not visible in the registered main repository | Inspect repository/branch state locally |
| `list_worktrees` is empty but `list_branches` contains the branch | Normal; the branch is not checked out as a linked worktree | Use repository-ref tools |
| MCP endpoint no longer resolves after a Quick Tunnel change | Plugin points at an obsolete URL | Recreate the Plugin with the current URL |
| Named tunnel is healthy and URL is unchanged | Connector endpoint remains valid | Do not recreate only because the broker restarted |

## Quick decision tree

```text
Need to inspect a branch
        |
        v
Does list_branches exist?
        |
   +----+----+
   |         |
  no        yes
   |         |
   |         v
   |   Call list_branches
   |         |
   |    +----+------------------+
   |    |                       |
   | succeeds             INSUFFICIENT_SCOPE
   |    |                       |
   |    v                       v
   | inspect branch       fresh OAuth required
   |                            |
   |                    does reconnect fix it?
   |                            |
   |                      +-----+-----+
   |                      |           |
   |                     yes         no
   |                      |           |
   |                      v           v
   |                    verify    recreate only
   |                  capability   Plugin entry
   |                                  |
   |                                  v
   |                            fresh OAuth/DCR
   |                                  |
   +------------------------------> verify with
                                   list_branches
```

## Verified CHANGE-005 rollout behavior

Observed during the local CHANGE-005 rollout on 2026-10-04:

1. The Chat to Codex Test broker was upgraded to revision `97d9076`.
2. The refreshed ChatGPT MCP surface exposed:
   - `list_branches`;
   - `git_browse`;
   - `git_search`;
   - `git_compare`.
3. The existing OAuth authorization still caused:

   ```text
   INSUFFICIENT_SCOPE
   This operation requires the 'git.repository.read' scope.
   ```

4. This proved that tool discovery was working while OAuth scope state was
   stale.
5. Reconnecting the existing ChatGPT Plugin did not upgrade the effective
   repository scope.
6. The `Chat to Codex Test` Plugin entry was removed and recreated against the
   same broker `/mcp` URL.
7. A fresh OAuth/Dynamic Client Registration flow was completed.
8. The fresh authorization included repository-read access.
9. `list_branches` then succeeded.
10. It returned:

    ```text
    refs/heads/codex/change-067-reference-integrity
    ```

    at:

    ```text
    7b6197d66e307f059852f2be5b0b9de63546ec17
    ```

The verified distinction is:

```text
tool missing
    -> broker/tool-discovery problem

tool exists + INSUFFICIENT_SCOPE
    -> OAuth scope problem

branch absent only from list_worktrees
    -> use list_branches; branches and worktrees are different inventories
```

## Operator checklist

When a future C2C repository-review capability stops working:

```text
1. Verify the intended broker/profile is running.
2. Verify the required MCP tool is visible.
3. If the tool is missing:
   - verify broker revision;
   - refresh Plugin/tool discovery;
   - use a new conversation if the old conversation still exposes stale tools.
4. If the tool exists, call it.
5. If it returns INSUFFICIENT_SCOPE:
   - do not debug worktrees;
   - do not wait for refresh-token rotation;
   - perform fresh OAuth authorization.
6. If ChatGPT reconnect still preserves the old scope:
   - remove only the affected Plugin entry;
   - recreate it against the same current /mcp URL;
   - leave OAuth client ID empty;
   - authenticate again.
7. Generate a fresh C2C pairing code only when the authorization page is open.
8. Confirm the consent page contains the newly required permission.
9. Verify recovery with the real MCP capability, for example list_branches.
10. Only then continue normal repository review.
```

The final acceptance criterion is a successful call to the capability that
required the new scope, not merely a successful-looking connection state.
