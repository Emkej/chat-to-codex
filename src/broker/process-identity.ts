import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LinuxProcessIdentity {
  pid: number;
  startTimeTicks: string;
}

export type LinuxProcessIdentityRead =
  | { kind: "present"; identity: LinuxProcessIdentity }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export type LinuxProcessIdentityComparison =
  | { kind: "matching" }
  | { kind: "absent" }
  | { kind: "different"; actual: LinuxProcessIdentity }
  | { kind: "unknown"; reason: string };

export type LinuxProcessSignalResult = "signaled" | "absent" | "different";

export function compareLinuxProcessIdentity(
  expected: LinuxProcessIdentity,
  procRoot = "/proc"
): LinuxProcessIdentityComparison {
  const current = readLinuxProcessIdentity(expected.pid, procRoot);
  if (current.kind !== "present") return current;
  if (current.identity.startTimeTicks === expected.startTimeTicks) return { kind: "matching" };
  return { kind: "different", actual: current.identity };
}

/**
 * Parse /proc/<pid>/stat without splitting the parenthesized comm field.
 * The comm field may contain whitespace and closing parentheses, so the final
 * closing parenthesis marks the boundary before fields 3 through 52.
 */
export function parseLinuxProcessStat(stat: string, expectedPid: number): LinuxProcessIdentity | null {
  const prefix = /^(\d+) \(/.exec(stat);
  const close = stat.lastIndexOf(")");
  if (!prefix || Number(prefix[1]) !== expectedPid || close < prefix[0].length - 1) return null;

  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // The tail starts at field 3 (state), making starttime (field 22) index 19.
  const startTimeTicks = fields[19];
  if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) return null;
  return { pid: expectedPid, startTimeTicks };
}

export function readLinuxProcessIdentity(pid: number, procRoot = "/proc"): LinuxProcessIdentityRead {
  if (process.platform !== "linux") {
    return { kind: "unknown", reason: "Linux /proc process identity is unavailable on this platform" };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: "unknown", reason: "The recorded broker PID is invalid" };
  }

  try {
    if (!fs.statSync(procRoot).isDirectory()) {
      return { kind: "unknown", reason: `${procRoot} is not a procfs directory` };
    }
  } catch (error) {
    return { kind: "unknown", reason: `Cannot inspect procfs: ${errorMessage(error)}` };
  }

  let stat: string;
  try {
    stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unknown", reason: `Cannot read process identity: ${errorMessage(error)}` };
  }

  const identity = parseLinuxProcessStat(stat, pid);
  return identity
    ? { kind: "present", identity }
    : { kind: "unknown", reason: "The Linux process stat record could not be parsed" };
}

/**
 * Send SIGTERM through a pidfd so PID reuse between the final identity check
 * and the signal syscall cannot target a different process. The identity is
 * checked after pidfd_open; pidfd_send_signal then remains bound to that task.
 */
export async function signalLinuxProcessIdentity(
  expected: LinuxProcessIdentity,
  signal?: AbortSignal,
  timeoutMs = 1_500
): Promise<LinuxProcessSignalResult> {
  if (process.platform !== "linux") throw new Error("Safe broker signaling requires Linux pidfd support");
  if (signal?.aborted) throw signal.reason ?? new Error("Process signal was cancelled");

  const script = [
    "import os, signal, sys",
    "pid = int(sys.argv[1])",
    "expected = sys.argv[2]",
    "if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):",
    "    sys.exit(13)",
    "try:",
    "    pidfd = os.pidfd_open(pid, 0)",
    "except ProcessLookupError:",
    "    sys.exit(11)",
    "try:",
    "    with open(f'/proc/{pid}/stat', 'r', encoding='ascii') as stat_file:",
    "        stat = stat_file.read()",
    "    close = stat.rfind(')')",
    "    fields = stat[close + 1:].split() if close >= 0 else []",
    "    actual = fields[19] if len(fields) > 19 else ''",
    "    if not actual.isdigit():",
    "        sys.exit(14)",
    "    if actual != expected:",
    "        sys.exit(12)",
    "    signal.pidfd_send_signal(pidfd, signal.SIGTERM)",
    "except ProcessLookupError:",
    "    sys.exit(11)",
    "finally:",
    "    os.close(pidfd)",
  ].join("\n");

  try {
    await execFileAsync("python3", ["-c", script, String(expected.pid), expected.startTimeTicks], {
      timeout: timeoutMs,
      signal,
      encoding: "utf8",
    });
    return "signaled";
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const code = String((error as NodeJS.ErrnoException).code ?? "");
    if (code === "11") return "absent";
    if (code === "12") return "different";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PID-bound SIGTERM was unavailable: ${detail}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
