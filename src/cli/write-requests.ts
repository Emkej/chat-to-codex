import type { Command } from "commander";
import { ensureBroker } from "../broker/daemon.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { resolveContainingLocalTarget, type LocalTargetRegistration } from "../workspace/local-target.js";
import type { WriteRequestDetails } from "../write-requests/service.js";
import type { WriteRequestReceipt } from "../write-requests/types.js";
import { CommandRequestCliError, commandRequestAction, describeCommand, listPendingCommands, printCommandAction } from "./command-requests.js";
import { escapeTerminalText, terminalSafeJson } from "../terminal/escape.js";

interface CliWriteRequest {
  request_id: string;
  status: string;
  workspace_id: string;
  worktree_id?: string;
  files: Array<{ path: string; action: string; additions: number; deletions: number }>;
  created_at: string;
  expires_at?: string;
  resolved_at?: string;
  resolution_code?: string;
  patch?: string;
}

export class WriteRequestCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly candidates: readonly WriteRequestReceipt[] = [],
    public readonly status?: number
  ) {
    super(message);
    this.name = "WriteRequestCliError";
  }
}

export function toCliWriteRequest(record: WriteRequestDetails, includePatch = false): CliWriteRequest {
  return {
    request_id: record.id,
    status: record.status,
    workspace_id: record.workspaceId,
    ...(record.worktreeId ? { worktree_id: record.worktreeId } : {}),
    files: record.files.map((file) => ({
      path: file.path,
      action: file.operation,
      additions: file.additions,
      deletions: file.deletions,
    })),
    created_at: record.createdAt,
    ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
    ...(record.resolvedAt ? { resolved_at: record.resolvedAt } : {}),
    ...(record.resolutionCode ? { resolution_code: record.resolutionCode } : {}),
    ...(includePatch && record.patch !== undefined ? { patch: record.patch } : {}),
  };
}

export function selectOnePendingRequest(records: readonly WriteRequestReceipt[]): WriteRequestReceipt {
  if (records.length === 0) {
    throw new WriteRequestCliError("WRITE_REQUEST_NOT_FOUND", "No pending write request exists for the current target.");
  }
  if (records.length > 1) {
    throw new WriteRequestCliError(
      "WRITE_REQUEST_AMBIGUOUS",
      `More than one pending request exists for the current target: ${records.map((record) => record.id).join(", ")}. Specify a request id.`,
      records
    );
  }
  return records[0];
}

async function relevantPendingRequests(existingRuntime?: RuntimeState) {
  const runtime = existingRuntime ?? (await ensureBroker());
  const { workspaces } = await adminFetch<{ workspaces: LocalTargetRegistration[] }>(runtime, "GET", "/admin/workspaces");
  const target = resolveContainingLocalTarget(process.cwd(), workspaces);
  if (target.kind === "unregistered" || !target.registration) {
    throw new WriteRequestCliError("WORKSPACE_UNAVAILABLE", "Current directory is not inside a registered workspace or valid linked worktree.");
  }
  const query = new URLSearchParams({
    workspaceId: target.registration.id,
    worktreeId: target.worktreeId ?? "",
    status: "pending",
    limit: "100",
  });
  const { requests } = await writeRequestAdminFetch<{ requests: WriteRequestReceipt[] }>(
    runtime,
    "GET",
    `/admin/write-requests?${query.toString()}`
  );
  return { runtime, requests, target: { workspaceId: target.registration.id, ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}) } };
}

async function readRequest(runtime: Awaited<ReturnType<typeof ensureBroker>>, id: string, includePatch: boolean) {
  const query = includePatch ? "?includePatch=true" : "";
  return writeRequestAdminFetch<WriteRequestDetails>(runtime, "GET", `/admin/write-requests/${encodeURIComponent(id)}${query}`);
}

async function writeRequestAdminFetch<T>(
  runtime: Awaited<ReturnType<typeof ensureBroker>>,
  method: "GET" | "POST",
  route: string,
  body?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.adminToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => ({}))) as { error?: string; code?: string; message?: string };
    if (!response.ok) {
      throw new WriteRequestCliError(
        parsed.error ?? parsed.code ?? "ADMIN_REQUEST_FAILED",
        parsed.message ?? `Admin request failed (${response.status})`,
        [],
        response.status
      );
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function say(message: string): void {
  process.stdout.write(message + "\n");
}

function describeRequest(record: CliWriteRequest): void {
  const target = record.worktree_id ? `${record.workspace_id}/${record.worktree_id}` : record.workspace_id;
  say(`${record.request_id}  ${record.status}  ${target}  ${record.files.length} file(s)`);
  for (const file of record.files) say(`  ${file.action} ${file.path}`);
}

function reportError(error: unknown, json: boolean): void {
  const code =
    error instanceof WriteRequestCliError || error instanceof CommandRequestCliError
      ? error.code
      : "ADMIN_REQUEST_FAILED";
  const status = error instanceof WriteRequestCliError || error instanceof CommandRequestCliError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const candidates = error instanceof WriteRequestCliError ? error.candidates : [];
  if (json) {
    say(
      terminalSafeJson({
        ok: false,
        error: code,
        ...(status !== undefined ? { status } : {}),
        message,
        ...(candidates.length > 0 ? { candidates: candidates.map((record) => toCliWriteRequest(record)) } : {}),
      })
    );
  } else {
    say(`✗ ${error instanceof CommandRequestCliError ? escapeTerminalText(message) : message}`);
    if (candidates.length > 0) {
      for (const candidate of candidates) say(`  ${candidate.id} (${candidate.files.length} file(s))`);
    }
  }
  process.exitCode = 1;
}

export function registerWriteRequestCommands(program: Command): void {
  program
    .command("pending")
    .description("List pending patch/command requests for the current target or inspect one explicit id")
    .argument("[request-id]")
    .option("--diff", "show the pending unified-text patch")
    .option("--output", "show retained command output for an explicit cr_ id")
    .option("--json", "machine-readable output", false)
    .action(async (requestId: string | undefined, options: { diff?: boolean; output?: boolean; json: boolean }) => {
      try {
        if (options.output && !requestId?.startsWith("cr_")) throw new CommandRequestCliError("COMMAND_INVALID", "--output requires an explicit cr_ request id.");
        if (requestId?.startsWith("cr_")) {
          if (options.diff) throw new CommandRequestCliError("COMMAND_INVALID", "--diff is available only for patch requests.");
          const detail = await commandRequestAction(await ensureBroker(), requestId, "detail", options.output);
          if (options.json) say(terminalSafeJson({ ok: true, requests: [detail] }));
          else describeCommand(detail, true, options.output);
          return;
        }
        if (requestId) {
          const runtime = await ensureBroker();
          const detail = await readRequest(runtime, requestId, Boolean(options.diff));
          const item = toCliWriteRequest(detail, Boolean(options.diff));
          if (options.json) say(JSON.stringify({ ok: true, requests: [item] }));
          else {
            describeRequest(item);
            if (options.diff && item.patch !== undefined) say(item.patch);
            else if (options.diff) say("Patch content is unavailable for this terminal request.");
          }
          return;
        }

        const { runtime, requests, target } = await relevantPendingRequests();
        if (options.diff && requests.length > 1) selectOnePendingRequest(requests);
        const commands = await listPendingCommands(runtime, target);
        const items = options.diff
          ? await Promise.all(requests.map(async (request) => toCliWriteRequest(await readRequest(runtime, request.id, true), true)))
          : requests.map((request) => toCliWriteRequest(request));
        if (options.json) {
          say(terminalSafeJson({ ok: true, requests: [...items, ...commands] }));
          return;
        }
        if (items.length === 0 && commands.length === 0) {
          say("No pending write requests for the current target.");
          return;
        }
        for (const item of items) {
          describeRequest(item);
          if (options.diff && item.patch !== undefined) say(item.patch);
        }
        for (const command of commands) describeCommand(command);
      } catch (error) {
        reportError(error, options.json);
      }
    });

  program
    .command("approve")
    .description("Approve one request; commands require an explicit cr_ id")
    .argument("[request-id]")
    .option("--json", "machine-readable output", false)
    .action(async (requestId: string | undefined, options: { json: boolean }) => {
      try {
        if (requestId?.startsWith("cr_")) {
          printCommandAction(await commandRequestAction(await ensureBroker(), requestId, "approve"), "approve", options.json);
          return;
        }
        let selectedId = requestId;
        let runtime: Awaited<ReturnType<typeof ensureBroker>>;
        if (selectedId) {
          runtime = await ensureBroker();
        } else {
          const selection = await relevantPendingRequests();
          runtime = selection.runtime;
          selectedId = selectOnePendingRequest(selection.requests).id;
        }
        if (!selectedId) throw new WriteRequestCliError("WRITE_REQUEST_NOT_FOUND", "No request id was selected.");
        const receipt = await writeRequestAdminFetch<WriteRequestReceipt>(
          runtime,
          "POST",
          `/admin/write-requests/${encodeURIComponent(selectedId)}/approve`
        );
        const item = toCliWriteRequest(receipt);
        if (options.json) say(JSON.stringify({ ok: true, request: item }));
        else say(`✓ Applied ${receipt.id}`);
      } catch (error) {
        reportError(error, options.json);
      }
    });

  program
    .command("reject")
    .description("Reject one request; commands require an explicit cr_ id")
    .argument("[request-id]")
    .option("--json", "machine-readable output", false)
    .action(async (requestId: string | undefined, options: { json: boolean }) => {
      try {
        if (requestId?.startsWith("cr_")) {
          printCommandAction(await commandRequestAction(await ensureBroker(), requestId, "reject"), "reject", options.json);
          return;
        }
        let selectedId = requestId;
        let runtime: Awaited<ReturnType<typeof ensureBroker>>;
        if (selectedId) {
          runtime = await ensureBroker();
        } else {
          const selection = await relevantPendingRequests();
          runtime = selection.runtime;
          selectedId = selectOnePendingRequest(selection.requests).id;
        }
        if (!selectedId) throw new WriteRequestCliError("WRITE_REQUEST_NOT_FOUND", "No request id was selected.");
        const receipt = await writeRequestAdminFetch<WriteRequestReceipt>(
          runtime,
          "POST",
          `/admin/write-requests/${encodeURIComponent(selectedId)}/reject`
        );
        const item = toCliWriteRequest(receipt);
        if (options.json) say(JSON.stringify({ ok: true, request: item }));
        else say(`✓ Rejected ${receipt.id}`);
      } catch (error) {
        reportError(error, options.json);
      }
    });
}
