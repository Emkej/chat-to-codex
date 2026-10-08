import type { LinuxProcessIdentity } from "../broker/process-identity.js";

export const COMMAND_SCOPE = "workspace.command";
export const WINDOW_MS = 60 * 60 * 1000;
export const OUTPUT_BYTES = 256 * 1024;
export const COMMAND_ID = /^cr_[a-f0-9]{24}$/;
export type CommandStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "rejected" | "expired";
export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputIncomplete: boolean;
  termination?: "group" | "leader" | "absent" | "different" | "unavailable";
}
export interface CommandRecord {
  id: string;
  kind: "command";
  status: CommandStatus;
  workspaceId: string;
  worktreeId?: string;
  argv: string[];
  cwd: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  resolvedAt?: string;
  resolutionCode?: string;
  leader?: LinuxProcessIdentity;
  result?: CommandResult;
}
export class CommandRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CommandRequestError";
  }
}
export function invalid(): never {
  throw new CommandRequestError("COMMAND_INVALID", "Invalid command request.");
}
export function validateInput(argv: unknown, cwd: unknown, reason: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !argv[0] || argv.reduce((n, arg: string) => n + Buffer.byteLength(arg), 0) > 32768 ||
    typeof cwd !== "string" || !cwd || cwd.includes("\0") ||
    typeof reason !== "string" || !reason || [...reason].length > 500 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(reason)) invalid();
}
export function terminal(record: CommandRecord): boolean {
  return record.status !== "pending" && record.status !== "running";
}
export function emptyResult(outputIncomplete = false): CommandResult {
  return { exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, outputIncomplete };
}
