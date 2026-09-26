# CHANGE-003: Use Alternate Screen for C2C Manager

- **Status:** Completed
- **Date:** 2026-09-26
- **Scope:** `chat-to-codex`
- **Related:** `SPEC-003 — C2C Manager MVP`
- **Primary area:** Manager terminal presentation and cleanup

## 1. Summary

`c2c manager` will use the terminal alternate screen while the Manager is active.

Today the Manager renders into the terminal's normal screen buffer, so previous shell commands and output remain visible above the TUI. The Manager already behaves like a full-screen interactive application: it owns keyboard input, refreshes continuously, responds to resize, and has an explicit bounded exit lifecycle.

After this change:

1. the existing TTY guards pass;
2. the Manager enters the alternate screen;
3. Ink renders normally inside that screen;
4. `q`, Ctrl+C, SIGTERM, normal completion, and handled failures leave the alternate screen through the existing cleanup path;
5. terminal restoration is attempted even if Manager teardown itself fails;
6. cleanup failures do not replace a pre-existing Manager failure;
7. the terminal returns to its normal screen buffer using the terminal emulator's standard alternate-screen semantics.

This is a post-SPEC-003 UX refinement. It does not reopen SPEC-003, start Phase 2, or change Manager actions/state semantics.

## 2. Decision

Use the standard terminal alternate-screen control sequences directly in the Manager lifecycle.

Conceptually:

```text
enter: ESC [? 1049 h
leave: ESC [? 1049 l
```

No new dependency, configuration option, terminal abstraction, or state machine is justified for this change.

The lifecycle owner remains `runManager()` in:

```text
src/manager/index.tsx
```

Alternate-screen entry happens only after the existing stdin/stdout TTY guard succeeds and immediately before Ink render ownership begins.

Alternate-screen exit belongs only to the final cleanup path. Cleanup must be structured so that:

- Manager teardown cannot prevent an alternate-screen restoration attempt;
- a failed restoration write cannot prevent SIGTERM listener removal;
- restoration is best-effort if stdout is no longer writable;
- cleanup failures do not replace a pre-existing Manager failure.

Failure priority is explicit:

1. if Manager render/startup/runtime already failed, that original Manager failure is propagated after cleanup;
2. otherwise, if Manager teardown fails, the teardown failure is propagated;
3. alternate-screen restoration is best-effort and must not replace either of the failures above.

This priority applies even when Manager execution, teardown, and restoration fail during the same exit path.

## 3. Implementation shape

Prefer the smallest implementation that fits the current code.

Do not use a plain nested-`finally` example that accidentally allows a cleanup exception to replace the original Manager failure. Capture the relevant failures locally and rethrow only after all cleanup attempts finish.

Illustrative shape:

```ts
const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

let alternateScreenActive = false;
let managerFailure: { error: unknown } | null = null;
let teardownFailure: { error: unknown } | null = null;

try {
  process.stdout.write(ENTER_ALT_SCREEN);
  alternateScreenActive = true;

  app = render(...);
  controller.start();
  await ...;
} catch (error) {
  managerFailure = { error };
} finally {
  try {
    requestExit();
  } catch (error) {
    teardownFailure = { error };
  }

  try {
    if (
      alternateScreenActive &&
      process.stdout.writable &&
      !process.stdout.destroyed
    ) {
      process.stdout.write(LEAVE_ALT_SCREEN);
    }
  } catch {
    // Best-effort terminal restoration. Never replace Manager/teardown failure.
  } finally {
    alternateScreenActive = false;
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (managerFailure) throw managerFailure.error;
if (teardownFailure) throw teardownFailure.error;
```

Exact code may differ. The wrapper objects above are illustrative and only avoid treating a thrown `undefined` value as "no failure"; use any equally simple local representation.

Keep these properties:

- one lifecycle owner;
- enter only after TTY validation;
- leave only from the final cleanup path;
- Manager execution failure has higher propagation priority than cleanup failures;
- teardown failure is propagated only when no Manager failure already exists;
- restoration is attempted regardless of teardown outcome;
- restoration failure does not mask Manager or teardown failure;
- SIGTERM listener removal still runs after restoration attempt;
- no backend mutation;
- no duplicate alternate-screen cleanup in individual `q`, Ctrl+C, or SIGTERM handlers;
- no new runtime dependency.

The existing `requestExit()` remains responsible for closing the controller and unmounting Ink. This CHANGE should not restructure the existing exit model unless implementation reveals a concrete bug.

## 4. User-visible behavior

### 4.1 While Manager is active

Previous normal-screen shell content is not visible behind the TUI.

The Manager owns the active viewport and continues to support the existing wide/narrow responsive layout.

### 4.2 On exit

Exiting with `q`, Ctrl+C, or SIGTERM leaves the alternate screen and restores the terminal's normal screen buffer according to standard terminal-emulator behavior.

Do not promise byte-for-byte scrollback restoration across all terminal emulators; the contract is standard alternate-screen semantics plus a usable restored terminal.

### 4.3 Non-TTY invocation

A non-TTY invocation fails through the existing CLI guard and emits no alternate-screen control sequence.

## 5. Scope boundaries

This CHANGE does not alter:

- installation status semantics;
- health checks;
- refresh cadence or refresh serialization;
- action policy;
- broker start/restart/recover/stop behavior;
- Pair or connector confirmation semantics;
- workspace selection;
- Phase 2 workspace/worktree detail;
- normal non-Manager CLI commands.

Do not add:

- `--no-alternate-screen`;
- an environment toggle;
- a terminal abstraction layer;
- a new terminal-control package;
- a new Ink test framework;
- shell clearing as a substitute for alternate-screen usage.

## 6. Failure behavior

If failure occurs before alternate-screen entry, no alternate-screen cleanup is needed.

If failure occurs after entry, cleanup must preserve three independent obligations:

1. attempt existing Manager teardown;
2. attempt alternate-screen restoration even if teardown throws;
3. remove the SIGTERM listener after the restoration attempt.

Cleanup execution order and failure propagation order are separate concerns. Nested cleanup guarantees that later cleanup is attempted; explicit failure capture guarantees which error ultimately propagates.

Failure propagation order is:

```text
Manager failure > teardown failure > successful return
```

Alternate-screen restoration failure is best-effort and is not promoted above either Manager or teardown failure.

Therefore:

- Manager fails + teardown succeeds -> propagate Manager failure;
- Manager fails + teardown fails -> still propagate Manager failure;
- Manager fails + teardown/restoration both fail -> still propagate Manager failure;
- Manager succeeds + teardown fails -> propagate teardown failure;
- restoration write fails while stdout is unusable -> do not replace a Manager or teardown failure.

Handled failures after entry must still propagate after cleanup. The alternate-screen lifecycle must not convert a failed Manager startup/render into apparent success.

Hard termination such as SIGKILL is outside the cleanup guarantee.

No speculative backend signaling or recovery behavior should be added for terminal cleanup.

## 7. Validation

Keep validation proportional to the change.

### 7.1 Focused automated checks

Run:

- existing `tests/cli-manager.test.ts`;
- a focused Manager entry-lifecycle test using existing Vitest mocking;
- existing Manager-focused tests affected by the entry lifecycle;
- TypeScript no-emit typecheck;
- build;
- `git diff --check`.

The non-TTY CLI test must verify that rejected non-TTY execution does not emit the alternate-screen enter sequence.

Add a focused Vitest lifecycle test without production test hooks or a terminal-testing framework. Mock the existing Ink/controller dependencies around `runManager()` and verify at least:

1. alternate-screen entry is written before Ink rendering begins;
2. a forced render/startup failure after entry emits the leave sequence exactly once;
3. the original Manager failure propagates after cleanup;
4. a forced teardown failure still attempts the leave sequence;
5. when Manager execution and teardown fail in the same run, the original Manager failure remains the propagated error;
6. when Manager execution, teardown, and restoration all fail in the same run, restoration is attempted and the original Manager failure still remains the propagated error;
7. when Manager execution succeeds but teardown fails, the teardown failure propagates;
8. SIGTERM listener removal is still attempted after teardown/restoration failure.

Keep these tests local to lifecycle ordering, cleanup attempts, and error precedence. Do not build an Ink snapshot suite or add production-only test hooks.

Run the full suite only if the implementation expands beyond the Manager entry lifecycle or touches shared process/CLI behavior.

### 7.2 Real terminal acceptance

Use a safe/disposable C2C state where practical.

Visual restoration must be checked in an actual terminal emulator; interpreted tmux panes are acceptable evidence, while raw PTY bytes alone are insufficient. A PTY capture proves control-sequence emission; interpreted screen state proves what the user sees after the terminal emulator consumes those sequences.

Verify:

1. recognizable normal-screen shell content exists before launch;
2. launching `c2c manager` switches to a clean alternate screen;
3. old shell content is not visible while the Manager is active;
4. `q` exits cleanly and returns to the normal screen;
5. Ctrl+C does the same;
6. SIGTERM does the same within the existing bounded exit policy;
7. wide/narrow rendering still works;
8. the terminal remains usable after each exit.

Record focused acceptance evidence under the existing verification-artifact tree, for example:

```text
docs/verification/artifacts/change-003/summary.json
```

Record at least:

- terminal emulator name;
- terminal dimensions used;
- exit method tested (`q`, Ctrl+C, SIGTERM);
- whether the previous normal screen returned visibly;
- whether the terminal accepted a subsequent command normally;
- any PTY byte-capture evidence used for sequence ordering.

Do not invoke Manager operational actions against live state merely to validate alternate-screen behavior.

## 8. Acceptance criteria

### AC-CHANGE-003-1 — Alternate-screen entry

An interactive `c2c manager` launch enters the terminal alternate screen before Ink renders the active Manager UI.

### AC-CHANGE-003-2 — Normal cleanup

Exiting with `q` leaves the alternate screen and returns to the terminal's normal screen buffer.

### AC-CHANGE-003-3 — Signal cleanup

Ctrl+C and SIGTERM leave the alternate screen through the existing Manager cleanup lifecycle.

### AC-CHANGE-003-4 — Failure cleanup and error precedence

A handled failure after alternate-screen entry attempts restoration before the failure propagates.

If Manager execution has already failed, that Manager failure remains the propagated error even when teardown and/or restoration also fail.

If Manager execution did not fail but teardown fails, the teardown failure propagates after restoration and listener cleanup are attempted.

Focused automated coverage verifies post-entry startup/render failure, teardown failure, and combined Manager + teardown/restoration failure paths.

### AC-CHANGE-003-5 — Non-TTY safety

A non-TTY invocation fails before alternate-screen entry and emits no alternate-screen control sequence.

### AC-CHANGE-003-6 — No operational behavior change

Alternate-screen handling does not mutate C2C state or change Manager refresh/action/lifecycle semantics.

## 9. Completion boundary

CHANGE-003 is complete when:

- the implementation remains local to the Manager entry lifecycle unless a concrete issue requires otherwise;
- teardown, restoration, and SIGTERM listener cleanup are independently attempted;
- original Manager failure has explicit propagation priority over teardown/restoration failures;
- teardown failure propagates when no Manager failure exists;
- focused failure-path tests verify post-entry failure propagation, cleanup attempts, and combined-failure precedence;
- focused tests, typecheck, build, and diff checks pass;
- terminal-emulator checks pass for `q`, Ctrl+C, and SIGTERM;
- acceptance evidence records the terminal emulator, dimensions, exit methods, visible normal-screen restoration, and post-exit terminal usability;
- the terminal returns to a usable normal screen after exit;
- no new dependency, configuration surface, production test hook, or unrelated abstraction is introduced.

SPEC-003 remains completed and unchanged.

## 10. Work tracking

- **Owner outcome:** Use standard terminal alternate-screen semantics in `runManager()` so Manager entry, exit, and failure cleanup restore a usable terminal without changing C2C operational behavior.
- **Dirty-path manifest:** `docs/verification/artifacts/change-003/task-ownership.json`
- **Work state:** `docs/verification/artifacts/change-003/work-state.json`
- **Execution environment:** WSL/Linux
- **Repository/worktree:** `/home/emkej/projects/chat-to-codex`
- **Branch/HEAD at intake:** `main` / `5b888130af8f0377452f2ab2baf57d6dcb8efbef`
- **Slices:**
  - `S1-lifecycle`: Implement alternate-screen entry/cleanup and focused failure-precedence tests in the Manager entry lifecycle. **Completed.**
  - `S2-terminal-acceptance`: Run focused and required quality gates, then verify q, Ctrl+C, SIGTERM, narrow/wide PTY behavior, visible normal-screen restoration, and post-exit terminal usability; retain evidence under `docs/verification/artifacts/change-003/`. **Completed.**
  - `S3-closeout`: Review the isolated diff, reconcile ownership, update this change status, and run the final validation/closeout gate. **Completed.**
- **Closeout:** Existing tmux 3.2a interpreted-screen evidence is accepted as terminal acceptance: q, Ctrl+C, SIGTERM, 80x24 narrow, and 120x24 wide runs restored the normal screen and accepted follow-up commands.
