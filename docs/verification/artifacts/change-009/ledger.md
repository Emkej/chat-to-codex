# CHANGE-009 execution ledger

Owner outcome: request_command → explicit local approval → one execution attempt → get_command_request, preserving SPEC-002.

Authority: docs/specs/spec-004-approved-local-command-execution.md and docs/changes/change-009-approved-local-command-requests.md. Implementation authorized by the owner on 2026-10-08, superseding draft-only authorization text. Planning evidence is not runtime validation.

Execution: Linux/WSL; /home/emkej/projects/chat-to-codex-change-009; codex/change-009-approved-commands; baseline fb28ac79e7f03b1753167e0278fa4178aa1f6cb5.
Ownership manifest: work/change-009/task-ownership.json. Tracker: python3 /home/emkej/.codex/workflows/scripts/track_dirty_paths.py. Clean baseline captured before authoritative-document transfer. Original checkout and unrelated dirty paths excluded.

Metrics: continuation runs 0; observed compactions 0; failed validation attempts 0; owner decision round-trips 0.

| Slice | Status | Success and validation |
| --- | --- | --- |
| Environment | Completed | Frozen dependency installation; offline attempt failed on missing policy metadata, online frozen installation passed without manifest/lockfile changes. |
| S1 Domain/runner | Completed | Strict atomic store; observational availability; single running claim; exact argv; bounded capture/cleanup; pidfd-safe recovery; focused domain and regression tests/typecheck passed; independent review clear after fixes. See s1.json. |
| S2 Authorization/broker | Completed | Explicit scope/consent, target ownership, local admin and MCP integration/security tests passed; SDK malformed-input error mapping corrected after independent review. See s2.json. |
| S3 CLI | In progress | Explicit cr_ routing, mixed discovery, escaped exact argv/output, unknown transport outcomes; focused CLI tests. |
| S4 Docs/acceptance | Planned | Canonical docs/skill; affected regressions, full tests, typecheck, build, diff check and disposable broker acceptance. |

Final gate: review each slice, retain focused evidence, commit coherent validated slices locally. No installation update, push, PR or merge.
