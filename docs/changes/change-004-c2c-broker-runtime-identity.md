# CHANGE-004: Expose Broker Runtime Identity in `workspace_info`

- **Status:** Completed
- **Date:** 2026-09-26
- **Scope:** `chat-to-codex`
- **Related:** `SPEC-001 — Worktree-Aware Workspace Access`
- **Primary area:** installation-broker MCP `workspace_info` runtime diagnostics
- **Review evidence:** `docs/verification/artifacts/change-004/quality-gate/review-01.json`

## 1. Summary

Installation-broker `workspace_info` will expose the identity of the C2C broker process serving the MCP request.

Today the broker already publishes its product version through `/health` and `/admin/info`, and local installation status can detect a Manager/Broker version mismatch. The MCP `workspace_info` response does not expose equivalent broker runtime identity to ChatGPT.

As a result, a planning or review session can inspect the selected workspace but cannot directly tell whether:

- an older C2C broker process is still serving requests after the installed/source C2C code changed; or
- the connector is attached to a different named C2C profile than expected.

This change adds a small installation-scoped `broker` object to `workspace_info` when the MCP server is running in installation-broker mode.

`broker.revision` is source-provenance metadata, not an executable fingerprint. When C2C is launched or installed through an existing compiled `dist`, a fresh build from the same checkout is a prerequisite for using the revision as evidence that the compiled code corresponds to that checkout.

No new MCP tool, HTTP endpoint, build pipeline, or source fingerprint is introduced.

## 2. Decision

Extend installation-broker `workspace_info` with:

```ts
broker: {
  version: string;
  revision: string | null;
  profile: string | null;
}
```

Example:

```json
{
  "workspaceId": "chat-to-codex-aa044b94",
  "workspaceName": "chat-to-codex",
  "rootAlias": "workspace:/",
  "broker": {
    "version": "0.2.0",
    "revision": "2f97726",
    "profile": "test"
  },
  "git": {
    "isRepo": true,
    "branch": "main",
    "commit": "2f97726",
    "dirty": false
  }
}
```

The new object is additive.

Existing workspace/worktree identity, project detection, Git information, and containment semantics remain unchanged.

The legacy per-project bridge also uses `createMcpServer()`, but it is not an installation broker. Its existing `workspace_info` response remains unchanged and does not need a `broker` object.

`workspace_info` remains the normal first workspace-specific MCP call. No separate `broker_info` call is required.

## 3. Broker field semantics

### 3.1 `version`

`broker.version` is the existing C2C `VERSION` value of the running broker process.

Do not introduce a second version source.

### 3.2 `profile`

`broker.profile` identifies the named C2C profile under which the running broker process started.

Semantics match the existing installation-status model:

```text
named profile -> trimmed profile name
no named profile -> null
```

For example:

```json
{ "profile": "test" }
```

or:

```json
{ "profile": null }
```

`null` represents the default/unnamed installation context.

An explicit `C2C_STATE_DIR` without a named `C2C_PROFILE` does not invent a profile name.

Do not expose the state-directory filesystem path as a substitute for profile identity.

### 3.3 `revision`

`broker.revision` is a best-effort Git revision representing the captured C2C source provenance associated with the running broker.

The value is diagnostic runtime identity. It is not:

- a compatibility protocol;
- a hash of the executable JavaScript;
- proof that `dist` was freshly built; or
- a fingerprint of dirty working-tree content.

When the revision cannot be established reliably:

```json
{ "revision": null }
```

is valid.

Failure to determine the revision must not prevent broker startup or make `workspace_info` fail.

The representation should stay consistent with the repository's existing short Git revision presentation unless implementation has a concrete reason to use the full object ID.

### 3.4 Fresh-build prerequisite for compiled execution

`bin/c2c.js` prefers an existing compiled `dist/cli/index.js`. `c2c install` copies the existing `dist` and does not rebuild it.

Therefore, whenever revision provenance is expected to describe the checkout that produced compiled execution, the compiled output must be freshly built from that same checkout before launch or install.

The required source/install workflow is:

```text
pnpm build
node bin/c2c.js install
```

Likewise, a source-checkout launch through `bin/c2c.js` that will use existing `dist` must be preceded by `pnpm build` when `broker.revision` is being relied on as source provenance.

This is a workflow prerequisite, not a new runtime enforcement mechanism. CHANGE-004 does not add automatic rebuilds, timestamps, executable hashing, or stale-`dist` detection.

If the prerequisite is violated, `broker.revision` may report checkout revision B while the launcher is executing compiled output produced earlier at revision A. That case is an accepted limitation documented in §5.

## 4. Revision source and lifetime

The revision identifies C2C itself, not the workspace selected by the MCP request.

It must not be resolved from:

- `process.cwd()`;
- the selected workspace root;
- the selected worktree root; or
- the selected workspace's Git repository.

This matters because the broker child currently inherits the caller's working directory. A broker started while the shell is inside another project must not report that project's `HEAD` as the C2C broker revision.

Revision resolution belongs in one focused runtime-identity module with small installer and broker hooks. Do not grow the already broad CLI command module with revision-origin logic.

### 4.1 Minimal resolution order

For the C2C application root from which the running CLI/broker code was loaded:

1. if that application root is a verified C2C Git checkout/worktree, use its Git revision;
2. otherwise, if valid installed-app revision metadata exists at that application root, use that value;
3. otherwise return `null`.

The installed metadata is one revision value only. No manifest framework is required.

### 4.2 Verified source/dev Git origin

Source/dev revision lookup must be rooted explicitly at the C2C application root.

Use the existing sanitized Git execution behavior rather than raw inherited Git process state. In particular, repository-location overrides such as:

```text
GIT_DIR
GIT_WORK_TREE
GIT_COMMON_DIR
GIT_INDEX_FILE
GIT_OBJECT_DIRECTORY
GIT_OBJECT_DIRECTORY_RELATIVE
GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_QUARANTINE_PATH
```

must not redirect revision discovery.

The existing `runGit()` behavior in `src/workspace/git.ts` already sanitizes these repository-location overrides and may be reused by the focused runtime-identity module.

An explicit Git working directory alone is not sufficient because Git may walk upward and discover an unrelated enclosing repository.

Before accepting a source revision:

1. resolve Git's `--show-toplevel` from the C2C application root using sanitized Git execution;
2. canonicalize both the discovered top-level path and the C2C application root;
3. require them to identify the same root;
4. only then read the revision;
5. otherwise return `null`.

This preserves C2C linked-worktree support: for a valid linked worktree, Git's top-level is that linked-worktree application root.

It also rejects a copied/non-Git C2C app located beneath an unrelated parent repository.

### 4.3 Installed app

`c2c install` creates a self-contained application copy under `C2C_HOME/app` and does not copy `.git`.

Before copying the application, the install flow resolves the source revision using the verified-origin rules above. After the application copy succeeds, it persists that revision as one small installed-app metadata value when available.

A subsequently started installed broker reads that persisted value from its own application root and captures it once.

If source revision resolution returns `null`, the install still succeeds and no revision is invented.

The exact metadata filename is an implementation detail. Keep it to one value; do not introduce a general build/install manifest.

### 4.4 Process lifetime

The resolved revision is captured once for the broker process and remains unchanged for that process lifetime.

This is required to detect the stale-process case:

```text
broker starts with captured C2C revision abc1234
C2C installation/source advances to def5678
old broker remains running
```

The running broker must continue to report:

```text
abc1234
```

It must not re-read current installed metadata or repository `HEAD` during each `workspace_info` call and incorrectly report:

```text
def5678
```

The exact internal helper and metadata filename are not part of the public MCP contract.

## 5. Intentional limitations

CHANGE-004 accepts two explicit limitations.

### 5.1 Dirty source contents are not fingerprinted

If a broker starts while C2C is at Git revision `abc1234` with uncommitted changes, `broker.revision` may still report:

```text
abc1234
```

Subsequent uncommitted source changes do not require a different runtime identity.

### 5.2 Stale compiled `dist` is not detected

If compiled output was built at revision A, the checkout later advances to B, and the operator launches or installs without the fresh-build prerequisite from §3.4, the broker may execute compiled code from A while reporting B as source provenance.

CHANGE-004 does not attempt to detect or repair that condition.

Do not add:

- source-tree hashes;
- dirty-tree fingerprints;
- executable hashes;
- build IDs;
- compatibility IDs;
- build timestamps;
- automatic rebuilds;
- content hashing;
- file watchers; or
- runtime source-change detection.

If stronger executable provenance becomes a demonstrated requirement later, it belongs in a separate change.

## 6. Implementation shape

Prefer one focused module, for example:

```text
src/broker/runtime-identity.ts
```

It owns revision resolution/persistence and broker runtime identity. The CLI install flow and broker startup should remain thin callers.

Conceptually:

```ts
type BrokerRuntimeIdentity = {
  version: string;
  revision: string | null;
  profile: string | null;
};
```

The focused module may expose small operations conceptually equivalent to:

```ts
resolveC2cRevision(appRoot): string | null
persistInstalledRevision(installedAppRoot, revision): void
captureBrokerRuntimeIdentity(appRoot): BrokerRuntimeIdentity
```

Exact names are not normative.

`resolveC2cRevision()` follows §4:

- verified C2C Git checkout/worktree using sanitized Git execution;
- otherwise installed revision metadata;
- otherwise `null`.

`startBroker()` captures one immutable identity:

```ts
const brokerIdentity = captureBrokerRuntimeIdentity(appRoot);
```

and installation-broker MCP server creation receives that same value:

```ts
createMcpServer({
  registry,
  sessions,
  brokerIdentity,
  ...
});
```

`workspace_info` includes `broker` only when that installation-broker identity exists.

Conceptually:

```ts
return ok({
  workspaceId: ...,
  workspaceName: ...,
  ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
  ...(ctx.brokerIdentity ? { broker: ctx.brokerIdentity } : {}),
  rootAlias: "workspace:/",
  ...project,
  git: ...,
});
```

The install command's responsibility is limited to:

1. resolve the source revision through the focused module;
2. perform the existing app copy;
3. persist the one revision value into the copied app when available.

Keep these properties:

- installation-broker runtime identity is captured once rather than recalculated per MCP request;
- source/dev lookup is rooted at the C2C application root, never caller `cwd`;
- inherited Git repository-location overrides cannot redirect discovery;
- unrelated enclosing repositories are rejected;
- C2C linked worktrees remain valid revision sources;
- installed-app revision survives the source-to-`C2C_HOME/app` copy when source revision is available;
- revision lookup is best-effort;
- failed revision lookup produces `null`;
- no workspace path, C2C source path, or installation path is exposed;
- broker identity is installation/process scoped and therefore does not change when a different workspace or worktree is selected;
- legacy per-project MCP behavior remains unchanged;
- existing workspace resolution and Git inspection remain unchanged.

Do not introduce a general runtime-metadata framework or broaden `src/cli/index.ts` with revision-resolution internals.

## 7. Existing surfaces

The existing broker surfaces remain valid:

```text
GET /health
GET /admin/info
```

Their current `version` behavior does not need to change to satisfy this CHANGE.

The existing MCP handshake also continues to advertise the MCP server name/version normally.

CHANGE-004 exists because those surfaces do not make the running installation-broker identity reliably available to the ChatGPT planning/review workflow through the normal workspace tool response.

No new HTTP route is required.

## 8. Scope boundaries

This CHANGE does not alter:

- workspace registration;
- workspace or worktree identity;
- Git target resolution;
- filesystem containment;
- MCP authorization scopes;
- broker start/restart/stop semantics;
- health-check semantics;
- tunnel behavior;
- pairing or OAuth behavior;
- Manager status semantics;
- write requests;
- execution records;
- legacy per-project bridge behavior; or
- existing `git_status` behavior.

Do not add:

- a `broker_info` MCP tool;
- `startedAt` to `workspace_info`;
- PID or port information;
- tunnel information;
- authorization or pairing state;
- token/session counts;
- Git `upstream`, `ahead`, or `behind` fields;
- an API/protocol compatibility version;
- automatic broker restart;
- automatic source-update detection;
- automatic build enforcement;
- dirty-source or executable fingerprinting; or
- a new runtime dependency.

`SPEC-001` remains unchanged. This is an additive post-SPEC refinement of installation-broker `workspace_info`.

## 9. Validation

Keep validation proportional to the change while covering the revision-origin failure cases and the installed-app path.

### 9.1 Focused automated checks

Add focused coverage proving that installation-broker `workspace_info`:

1. returns `broker.version` from the existing C2C version source;
2. returns the active named profile when present;
3. returns `profile: null` for the default/unnamed profile;
4. returns a captured C2C revision when available;
5. returns `revision: null` without failing when revision discovery is unavailable;
6. returns the same broker identity regardless of which registered workspace is selected;
7. returns the same broker identity when a derived worktree is selected;
8. preserves all existing workspace/worktree response semantics; and
9. does not add `broker` to the legacy per-project bridge response.

Add focused revision-source coverage proving that:

1. revision discovery is rooted at the C2C application root rather than caller `cwd`;
2. inherited `GIT_DIR` / `GIT_WORK_TREE` and the other repository-location overrides cannot redirect discovery to another repository;
3. a non-Git application directory located inside an unrelated enclosing Git repository returns `null` rather than the enclosing repository's revision;
4. a valid C2C linked-worktree application root remains accepted and returns that worktree's revision;
5. installed-app metadata can preserve and recover a source revision without `.git`;
6. invalid/missing installed revision metadata degrades to `null`; and
7. a running broker retains its captured revision even if the underlying source or installed metadata changes afterward.

Reuse the existing sanitized `runGit()` behavior where practical rather than duplicating the repository-location override list.

Prefer a small production helper with naturally testable path inputs over production-only test hooks.

Relevant existing coverage includes:

```text
tests/broker.test.ts
tests/mcp-worktrees.test.ts
tests/mcp-integration.test.ts
tests/git.test.ts
tests/local-e2e-broker.test.ts
```

Only add a dedicated runtime-identity test file if that keeps these origin cases more cohesive than forcing them into unrelated suites.

Run:

```text
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

### 9.2 Installed-app + connected-connector smoke check

This check intentionally touches the shared installed application.

Profiles isolate runtime state, not application copies. `c2ct` uses the `test` profile, but `c2c install` still replaces the application under the selected `C2C_HOME`, refreshes its `c2c`/`c2ct` launchers, updates the systemwide launcher links where permitted, and refreshes the global Codex skill.

Before starting:

1. identify and record the exact `C2C_HOME` used by the connected test connector;
2. do not rely on profile isolation to protect the existing installed app;
3. preserve enough of the current installation to restore it if validation fails, including the previous application copy and global skill, and record current launcher-link targets where they may change.

Run the install only from a freshly built checkout:

```text
pnpm build
C2C_HOME="<intended-home>" node bin/c2c.js install
```

After install, use the **installed** `c2ct` entry point for test-profile lifecycle operations rather than the source checkout launcher:

```text
C2C_HOME="<intended-home>" "<intended-home>/bin/c2ct" broker stop
C2C_HOME="<intended-home>" "<intended-home>/bin/c2ct" broker start
```

Use the same recorded absolute `<intended-home>` for installation and every lifecycle command. The installed launcher path selects the application code; the explicit `C2C_HOME` selects its runtime-state home.

Use the existing test-profile tunnel configuration so the connected test connector continues to address the intended test installation.

Then call the connected C2C test connector's `workspace_info` for `chat-to-codex`.

Verify that the response visibly contains:

```json
{
  "broker": {
    "version": "...",
    "revision": "...",
    "profile": "test"
  }
}
```

Verify that:

- `broker.revision` matches the C2C source revision captured by the fresh build/install;
- `broker.profile` is `test`; and
- the connected tool remains able to inspect the intended `chat-to-codex` workspace.

If install, restart, or connector verification fails after the shared application was replaced, restore the preserved previous application/skill/launcher state before leaving the validation environment, then restart the test-profile broker from that restored installation. Pass the same explicit `C2C_HOME="<intended-home>"` to every rollback lifecycle command as well.

No project-workspace mutation is required for this smoke check.

## 10. Acceptance criteria

### AC-CHANGE-004-1 — Version visibility

Installation-broker `workspace_info` includes:

```text
broker.version
```

using the existing C2C version source.

### AC-CHANGE-004-2 — Profile visibility

Installation-broker `workspace_info` includes:

```text
broker.profile
```

with the named profile when present and `null` for the default/unnamed profile.

### AC-CHANGE-004-3 — Runtime revision visibility

Installation-broker `workspace_info` includes:

```text
broker.revision
```

containing the best-effort captured C2C source revision associated with the running broker, or `null` when unavailable.

Revision-discovery failure does not fail broker startup or the MCP request.

### AC-CHANGE-004-4 — Compiled provenance prerequisite

When C2C is launched or installed through existing compiled `dist`, a fresh build from the same checkout is the documented prerequisite for treating `broker.revision` as provenance for that compiled execution.

CHANGE-004 does not automatically rebuild or detect stale `dist`.

### AC-CHANGE-004-5 — Correct revision origin

The reported broker revision identifies C2C itself.

It is not derived from caller `cwd`, the selected workspace, the selected worktree, inherited Git repository-location overrides, or an unrelated enclosing repository.

Source Git discovery accepts a revision only after the canonical discovered Git top-level matches the canonical C2C application root.

A valid C2C linked-worktree application root remains supported.

### AC-CHANGE-004-6 — Installed revision preservation

When `c2c install` runs after a fresh build from a verified C2C checkout/worktree whose revision can be determined, the installed app preserves one revision value so a subsequently started installed broker can report it even though the installed app does not contain `.git`.

If source revision cannot be verified, install still succeeds and the installed revision is unavailable rather than guessed.

No general build manifest is required.

### AC-CHANGE-004-7 — Process identity stability

The broker revision is captured for the running process and does not change merely because C2C source or installed metadata changes after that broker process starts.

`workspace_info` must not resolve current C2C revision independently on every request.

### AC-CHANGE-004-8 — Installation-scoped metadata

Broker identity does not depend on the selected workspace or worktree.

Selecting another workspace/worktree changes workspace-specific fields normally but not:

```text
broker.version
broker.revision
broker.profile
```

for the same running broker process.

### AC-CHANGE-004-9 — Legacy bridge unchanged

The legacy per-project bridge remains compatible with its existing `workspace_info` contract and does not need to expose a `broker` object.

### AC-CHANGE-004-10 — No existing contract regression

Existing installation-broker `workspace_info` identity, project detection, Git information, opaque workspace IDs, worktree handling, and containment behavior remain unchanged.

### AC-CHANGE-004-11 — No unnecessary surface

The implementation adds no new MCP tool, HTTP endpoint, runtime dependency, compatibility-version mechanism, automatic rebuild, dirty/executable fingerprint, or automatic restart behavior.

Revision resolution/persistence remains a focused responsibility rather than expanding the CLI into another metadata subsystem.

## 11. Completion boundary

CHANGE-004 is complete when:

- installation-broker `workspace_info` exposes `broker.version`, `broker.revision`, and `broker.profile`;
- the legacy per-project bridge remains unchanged;
- the compiled fresh-build provenance prerequisite and stale-`dist` limitation are explicit;
- source/dev revision discovery sanitizes repository-location overrides;
- source/dev revision discovery verifies canonical Git top-level ownership and rejects unrelated enclosing repositories;
- valid C2C linked-worktree application roots remain supported;
- installed-app revision metadata survives `c2c install` when source revision is available;
- source/dev revision discovery is explicitly rooted at C2C and cannot accidentally identify the caller workspace;
- broker revision is immutable for one running broker process;
- unavailable/unverified revision discovery degrades to `null`;
- profile semantics match the existing named/default installation model;
- the metadata remains installation scoped across workspace/worktree selection;
- existing `workspace_info` behavior remains intact;
- focused regression coverage includes the inherited-Git-override and unrelated-enclosing-repository cases;
- the full test suite, typecheck, build, and `git diff --check` pass;
- the smoke validation records the intended `C2C_HOME` and preserves a rollback path for the shared installed app;
- an installed test-profile broker is restarted through the installed `c2ct` entry point;
- a connected ChatGPT `workspace_info` smoke check confirms the new broker metadata is visible through the real connector; and
- no diagnostics or abstraction beyond the three agreed fields, one focused identity module, and one installed revision metadata value are introduced.

## 12. Work tracking

- **Owner outcome:** Make stale or wrong-profile C2C installation brokers immediately observable to the ChatGPT planning/review workflow through the existing first-call `workspace_info` surface.
- **Review-01 disposition:** Both Important findings and the optional smoke-check clarification are incorporated into this revision. Implementation and validation are complete.
- **Suggested slices:**
  - `S1-runtime-identity` (Completed): Add the focused revision/identity module, preserve one installed revision value, capture immutable broker runtime identity, expose it through installation-broker `workspace_info`, and add focused origin/contract tests.
  - `S2-validation` (Completed): Run repository quality gates, perform the shared-install-safe fresh-build/install/restart procedure through installed `c2ct`, verify the connected ChatGPT test connector, restore the previous installation on failure, and close the CHANGE.
- **Completion evidence:** `docs/verification/artifacts/change-004/s1-runtime-identity/summary.json`, `docs/verification/artifacts/change-004/s2-validation/quality-gates.json`, and `docs/verification/artifacts/change-004/s2-validation/installed-smoke.json`.
