import type { RuntimeState } from "../bridge/runtime.js";
import type { CommandReceipt } from "../command-requests/receipt.js";
import { COMMAND_ID } from "../command-requests/types.js";
import { escapeTerminalText, terminalSafeJson } from "../terminal/escape.js";

export class CommandRequestCliError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message); this.name = "CommandRequestCliError";
  }
}
async function commandFetch<T>(runtime: RuntimeState, method: "GET" | "POST", route: string, approvalId?: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const cancel = () => controller.abort();
  if (approvalId) { process.once("SIGINT", cancel); process.once("SIGTERM", cancel); }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/admin/command-requests${route}`, {
      method, headers: { authorization: `Bearer ${runtime.adminToken}` }, signal: controller.signal,
    });
    const body = await response.json().catch((error: unknown) => { if (response.ok) throw error; return {}; }) as { error?: string; message?: string };
    if (!response.ok) throw new CommandRequestCliError(body.error ?? "ADMIN_REQUEST_FAILED", body.message ?? "Command operation failed.", response.status);
    return body as T;
  } catch (error) {
    if (error instanceof CommandRequestCliError) throw error;
    if (approvalId) throw new CommandRequestCliError("COMMAND_APPROVAL_UNKNOWN",
      `Unknown approval outcome for ${approvalId}. Do not retry automatically. Inspect c2c pending ${approvalId} to reconcile.`);
    throw new CommandRequestCliError("ADMIN_REQUEST_FAILED", "Command request could not be inspected.");
  } finally {
    clearTimeout(timer);
    if (approvalId) { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
}
export async function listPendingCommands(runtime: RuntimeState, target: { workspaceId: string; worktreeId?: string }): Promise<CommandReceipt[]> {
  const query = new URLSearchParams({ workspaceId: target.workspaceId, worktreeId: target.worktreeId ?? "" });
  try { return (await commandFetch<{ requests: CommandReceipt[] }>(runtime, "GET", `?${query}`)).requests; }
  catch (error) {
    // A broker without command capability still supports its existing patch CLI.
    if (error instanceof CommandRequestCliError && error.status === 404) return [];
    throw error;
  }
}
export async function commandRequestAction(
  runtime: RuntimeState, id: string, action: "detail" | "approve" | "reject", output = false
): Promise<CommandReceipt> {
  if (!COMMAND_ID.test(id)) throw new CommandRequestCliError("COMMAND_REQUEST_NOT_FOUND", "Command request was not found.");
  const record = await commandFetch<CommandReceipt>(runtime, action === "detail" ? "GET" : "POST",
    `/${encodeURIComponent(id)}${action === "detail" ? (output ? "?output=true" : "") : `/${action}`}`,
    action === "approve" ? id : undefined);
  if (!record || typeof record !== "object" || record.request_id !== id || !Array.isArray(record.argv) || typeof record.cwd !== "string" ||
    !["pending", "running", "completed", "failed", "interrupted", "rejected", "expired"].includes(record.status) ||
    (action === "approve" && record.status === "running" && !record.started_at)) {
    if (action === "approve") throw new CommandRequestCliError("COMMAND_APPROVAL_UNKNOWN", `Unknown approval outcome for ${id}. Inspect c2c pending ${id}; do not retry automatically.`);
    throw new CommandRequestCliError("ADMIN_REQUEST_FAILED", "Command receipt was invalid.");
  }
  return record;
}
export function describeCommand(record: CommandReceipt, detail = false, output = false): void {
  const say = (value: string) => process.stdout.write(value + "\n");
  const safe = escapeTerminalText;
  const target = record.worktree_id ? `${record.workspace_id}/${record.worktree_id}` : record.workspace_id;
  say(`${safe(record.request_id)}  command  ${safe(record.status)}  ${safe(target)}`);
  say(`  cwd: ${safe(record.cwd)}`);
  if (!detail) {
    const preview = safe(JSON.stringify(record.argv));
    say(`  argv: ${preview.length > 240 ? preview.slice(0, 240) + "… (inspect id for full argv)" : preview}`);
    return;
  }
  record.argv.forEach((arg, index) => say(`  argv[${index}]: ${safe(JSON.stringify(arg))}`));
  say(`  reason: ${safe(record.reason)}`);
  say(`  created: ${safe(record.created_at)}; expires: ${safe(record.expires_at)}`);
  if (record.started_at) say(`  started: ${safe(record.started_at)}`);
  if (record.resolved_at) say(`  resolved: ${safe(record.resolved_at)}; available until: ${safe(record.result_available_until!)}`);
  if (record.resolution_code) say(`  resolution: ${safe(record.resolution_code)}`);
  if (record.exit_code !== undefined) say(`  exit: ${record.exit_code}; signal: ${safe(record.signal ?? "none")}; output_incomplete: ${record.output_incomplete}`);
  if (record.termination) say(`  termination: ${safe(record.termination)}`);
  if (output && record.stdout !== undefined) {
    say(`  stdout (retained tail; truncated: ${record.stdout_truncated}):\n${safe(record.stdout, true)}`);
    say(`  stderr (retained tail; truncated: ${record.stderr_truncated}):\n${safe(record.stderr ?? "", true)}`);
  }
}
export function printCommandAction(record: CommandReceipt, action: "approve" | "reject", json: boolean): void {
  if (json) process.stdout.write(terminalSafeJson({ ok: true, request: record }) + "\n");
  else if (action === "approve" && record.status === "running" && record.started_at) process.stdout.write(`Started ${record.request_id}; inspect c2c pending ${record.request_id} for the result.\n`);
  else describeCommand(record, true);
  if (record.status === "failed" || record.status === "interrupted") process.exitCode = 1;
}
