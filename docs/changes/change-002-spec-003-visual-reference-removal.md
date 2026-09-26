# CHANGE-002: Resolve the Missing SPEC-003 Visual Reference

- **Status:** Completed
- **Date:** 2026-09-26
- **Scope:** `chat-to-codex`
- **Related:** `SPEC-003 — C2C Manager MVP`
- **Primary area:** the non-normative `docs/html/c2c-manager-tui-mockup.html` reference

## 1. Decision

The exact approved TUI mockup is not available in the current checkout, the
only registered Git worktree, reachable Git history/object listings, or
unreachable Git commit/tree objects. No replacement visual was fabricated.

This change intentionally removes the unavailable non-normative visual
reference from the SPEC-003 delivery requirement. Under AC-003-29, visual
acceptance therefore relies on the authoritative SPEC's layout and interaction
requirements.

## 2. Evidence

- `docs/html/c2c-manager-tui-mockup.html` is absent from the current checkout.
- A repository file search found no copy outside protected generated `work/`
  data.
- `git worktree list --porcelain` reports only the current worktree.
- `git log --all --full-history -- docs/html/c2c-manager-tui-mockup.html` and
  `git rev-list --objects --all` contain no authoritative mockup path.
- The unreachable commit/tree object scan also found no matching path.

## 3. Acceptance resolution

AC-003-29 is resolved by the documented-removal branch of its own acceptance
criterion: visual acceptance uses the authoritative SPEC, including its
wide/narrow layout and interaction requirements. The current SPEC remains
unchanged.

The existing P0/P1 implementation and validation are unchanged. Phase 2
workspace/worktree detail remains optional and was not started.

## 4. Scope boundary

This CHANGE does not:

- edit the user-authored SPEC;
- add a replacement mockup or screenshot;
- add Manager features; or
- start Phase 2.

Closeout evidence is retained in:

- `docs/verification/artifacts/spec-003/quality-gate/recheck-03.json`;
- `docs/verification/artifacts/spec-003/closeout/summary.json`; and
- `docs/verification/artifacts/spec-003/p1-manager-overview/summary.json`.
