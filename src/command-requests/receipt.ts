import { utf8Tail } from "./output.js";
import { CommandRequestError, WINDOW_MS, type CommandRecord } from "./types.js";

/** Public identity and timestamps. No local absolute root or child PID escapes. */
export function commandCreationReceipt(record: CommandRecord) {
  return {
    request_id: record.id, status: record.status, workspace_id: record.workspaceId,
    ...(record.worktreeId ? { worktree_id: record.worktreeId } : {}),
    expires_at: record.expiresAt, approval_command: `c2c approve ${record.id}`,
  };
}
export function commandReceipt(record: CommandRecord, maxOutputBytes = 8192) {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > 65536) {
    throw new CommandRequestError("COMMAND_INVALID", "max_output_bytes must be an integer from 0 to 65536.");
  }
  return projectCommandReceipt(record, maxOutputBytes);
}
/** Local explicit --output may inspect the full retained streams. */
export function localCommandReceipt(record: CommandRecord, output: boolean) {
  return projectCommandReceipt(record, output ? 256 * 1024 : 0);
}
function projectCommandReceipt(record: CommandRecord, maxBytes: number) {
  const stdout = record.result ? utf8Tail(record.result.stdout, maxBytes) : undefined;
  const stderr = record.result ? utf8Tail(record.result.stderr, maxBytes) : undefined;
  return {
    request_id: record.id, status: record.status, workspace_id: record.workspaceId,
    ...(record.worktreeId ? { worktree_id: record.worktreeId } : {}),
    argv: [...record.argv], cwd: record.cwd, reason: record.reason,
    created_at: record.createdAt, expires_at: record.expiresAt,
    ...(record.startedAt ? { started_at: record.startedAt } : {}),
    ...(record.resolvedAt ? { resolved_at: record.resolvedAt,
      result_available_until: new Date(Date.parse(record.resolvedAt) + WINDOW_MS).toISOString() } : {}),
    ...(record.resolutionCode ? { resolution_code: record.resolutionCode } : {}),
    ...(record.result ? {
      exit_code: record.result.exitCode, signal: record.result.signal,
      stdout: stdout!.text, stderr: stderr!.text,
      stdout_truncated: record.result.stdoutTruncated, stderr_truncated: record.result.stderrTruncated,
      stdout_response_truncated: stdout!.truncated, stderr_response_truncated: stderr!.truncated,
      output_incomplete: record.result.outputIncomplete,
      ...(record.result.termination ? { termination: record.result.termination } : {}),
    } : {}),
  };
}
export type CommandReceipt = ReturnType<typeof commandReceipt>;
