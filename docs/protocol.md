# C2C Agent Protocol

Control plane: The Claude conversation (tiny structured messages typed into Claude Web).
Data plane: MCP (Claude pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

`list_worktrees` reports checked-out linked worktrees only; it does not enumerate
repository branches. When the broker token has `git.repository.read`, use
`list_branches` and exact-ref `git_browse`, `git_search`, or `git_compare` for
bounded reads from other committed branches. These repository snapshot tools
are broker-only and require a registered main worktree.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks Claude to inspect + plan |
| PLAN | Claude | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | Claude | (implicit) Claude is inspecting via MCP |
| DONE | Claude | Success criteria met |
| BLOCKED | Claude | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → Claude)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Chat to Codex MCP.
Create an implementation plan for Codex.
```

### PLAN (Claude → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → Claude)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
so Claude can read it via the `execution_summary` / `test_status` tools.

### DONE / BLOCKED (Claude → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new Claude conversation)

Use one long-lived C2C conversation per concrete workspace target where
practical: a registered main workspace or a selected linked worktree. The
durable `workspaceId` identifies the parent registration and an optional
`worktreeId` identifies the concrete target. Codex switches to a new chat only
when the user asks for it or the old chat has grown long enough to lag. Right
after the boot prompt, Codex sends a HANDOFF so the new chat can continue
seamlessly — a brief, never a data dump (the new chat re-reads code via MCP):

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current concrete workspace target through the
"Chat to Codex" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. When a task runs in a linked worktree, preserve both the parent
    `workspaceId` and opaque `worktreeId`; never request or transmit a
    filesystem path.
```

## Approved patch lifecycle and verification

When the selected host path supports proposal writes, ChatGPT may call
`propose_patch` with the existing opaque `workspace` and optional `worktree`
selectors. This requires explicitly authorized `workspace.write` and creates
a pending local C2C request; the MCP call does not change project files. The
user can inspect it with `c2c pending [request-id] --diff`, then run
`c2c approve [request-id]` or `c2c reject [request-id]`. With no request id,
the CLI uses the concrete target containing its current directory and fails on
ambiguous selection rather than choosing across workspaces.

```text
APPLIED != VERIFIED != DONE
```

After approval, ChatGPT must use `list_write_requests` or `get_write_request`
to recover the receipt, then use `read_file` and, when useful, `git_diff` to
inspect every affected result against the intended change. A receipt hash is
evidence of written bytes, not proof of semantic correctness. Only report DONE
after that independent review. If review finds a mistake, submit a corrective
proposal through the same approval path; never apply an additional unapproved
mutation.

This host's recorded gate is Probe A `BLOCKED` / Probe B `SUPPORTED`, so
proposal plus local approval is the current path. See the [probe evidence](verification/artifacts/spec-002/mcp-write-probes.md).

This SPEC-002 V1 write path is supported only on Linux/WSL. Windows support is
deferred to separately validated future work; macOS is out of scope unless
separately proposed.

## Approved command lifecycle and verification

Ordinary execution and recovery remain owned by Codex. The Linux/WSL broker
adds one exception: a remote client with freshly authorized, explicit
`workspace.command` may submit `request_command` with argv, relative cwd and
reason, then inspect that exact id with `get_command_request`. Preserve opaque
workspace/worktree selectors; omission requires exactly one registration.
Creation returns pending state plus `c2c approve cr_...`; it executes nothing.
The user reviews mixed `c2c pending` or full indexed `c2c pending cr_...` detail,
then explicitly runs `c2c approve cr_...` or `c2c reject cr_...`. No-id verbs
select patches only. The remote client must never approve on the user's behalf.

Approval is not sandboxing: approved code runs with local user permissions and
broker-derived environment, can affect files outside cwd, and may disclose local
data in output. There is no general rollback or automatic retry. Existing/default
tokens cannot create or read command requests; perform fresh OAuth authorization
using the existing reauthorization guidance in `skill/SKILL.md`. Do not revoke
all installation tokens merely to upgrade one connector's scope.

`running` alone can be a durable pre-spawn claim; only `started_at` confirms
startup. Approval returns promptly after confirmed spawn, not command completion.
Read the terminal receipt before claiming success: `completed` with exit code 0
and `output_incomplete=false` can support successful command execution; exit 1
is a completed failing test, and `failed`/`interrupted` never proves a passed
test. Natural EOF/close determines completion. Use semantic test evidence too.
Inspect `resolution_code` and independent retained/response truncation markers.
Default output is 8192 bytes per stream; request a bounded expansion up to 65536
only when needed, without automatic repeated reads. Local `--output` explicitly
shows retained tails; `--diff` remains patch-only.

Lost/cancelled/timed-out approval transport has an unknown outcome. Reconcile
with `c2c pending cr_...` or `get_command_request`; never repeat the POST or
automatically submit a replacement. Timeout/restart never auto-respawns. A new
attempt requires a new request and new local approval.

Terminal reads become unavailable sixty minutes after resolution. Files are
cleaned lazily during startup and named lifecycle mutations; an idle/stopped
broker provides no on-disk deletion deadline. Restart cleanup is leader-only;
descendants may survive, and there is a spawn-to-identity-persistence crash window.
