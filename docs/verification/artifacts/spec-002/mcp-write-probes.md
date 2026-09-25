# SPEC-002 MCP write-capability probes

Status: Complete for Phase 0 — the real ChatGPT Plus host results are recorded: Probe A is blocked for native confirmation in this host configuration and Probe B is supported for disposable proposal state. Disposable probes were removed after evidence capture.

Date: 2026-09-24
Branch: `codex/spec-002-approved-local-patch-writes`
Local baseline: `04371692fe5377d24beb0502c5c328af923f18d2`
Host: ChatGPT Plus connector `Chat_to_Codex_Test_v2`; connector metadata showed 12 functions without expanded names/schemas.

## Probe A — direct destructive write

- Tool: `probe_destructive_write`
- Annotation: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`
- Gate: installation broker `enableMcpWriteProbes: true` or `C2C_ENABLE_MCP_WRITE_PROBES=1`; absent by default and absent from the legacy bridge.
- Local effect: increments a disposable broker-state counter only; it never receives a workspace path and does not mutate a project.
- Local discovery/invocation: passed in `tests/mcp-write-probes.test.ts`.
- Local authorization denial: passed; a token without `workspace.write` receives `INSUFFICIENT_SCOPE`.
- ChatGPT Plus discovery/invocation: direct name-based invocation succeeded exactly once; the collapsed 12-function metadata did not expose the name in its visible summary.
- Host result: `{"probe":"A","status":"executed","destructiveExecutions":1}`.
- Host state effect: the disposable Probe A counter executed once; no workspace selector or project path was supplied.
- Native confirmation/deny behavior: no confirmation card or deny control was presented before the result; the call executed immediately. Deny could not be selected.
- Scope/re-pair behavior: the server accepted the call under its enforced `workspace.write` scope; the host consent/re-pair UI was not separately observed.
- Remembered-approval behavior: not distinguishable because no confirmation card was presented.
- Final decision: `BLOCKED` for native host-confirmed direct-write compatibility.

## Probe B — non-destructive proposal write

- Tool: `probe_proposal_write`
- Annotation: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`
- Gate: same explicit broker-only Phase-0 gate as Probe A.
- Local effect: appends one disposable pending proposal record to broker state only; it never mutates a project.
- Local discovery/invocation: passed in `tests/mcp-write-probes.test.ts`.
- Local authorization denial: covered by the shared probe scope contract.
- ChatGPT Plus discovery/invocation: direct name-based invocation succeeded exactly once; the collapsed 12-function metadata did not expose the name in its visible summary.
- Host result: `{"probe":"B","status":"pending","requestId":"probe_236c404f4315a3e5b71ae1e5"}`.
- Host state effect: one disposable pending proposal record was returned; no workspace selector or project path was supplied.
- Host confirmation behavior: no confirmation was required or presented for the non-destructive annotation.
- Scope/re-pair behavior: the server accepted the call under its enforced `workspace.write` scope; the host consent/re-pair UI was not separately observed.
- Remembered-approval behavior: not applicable/ not tested; Probe B has no destructive confirmation requirement.
- Final decision: `SUPPORTED` for disposable non-destructive proposal invocation.

## Capability matrix

The observed capability row is `BLOCKED / SUPPORTED`, so the authoritative §17.4 matrix selects `propose_patch` with local `c2c approve`; direct host-confirmed `apply_patch` is not eligible from this Probe A result. Phase-0 closeout must remove the disposable probe surface and verify that it is absent from default/production discovery.

## Phase-0 closeout

- Disposable probe handlers, broker gate, and focused probe test were removed after host evidence capture.
- Final validation: passed 4/4 in `docs/verification/artifacts/spec-002/p0-final/summary.json` — typecheck, build, full tests, and probe-surface absence.
