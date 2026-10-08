import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readLinuxProcessIdentity, signalLinuxOwnedProcessGroup, type LinuxProcessIdentity } from "../broker/process-identity.js";
import { OutputTail } from "./output.js";
import { OUTPUT_BYTES, emptyResult, type CommandResult } from "./types.js";

export const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
export interface RunnerOutcome {
  status: "completed" | "failed" | "interrupted";
  resolutionCode?: string;
  result: CommandResult;
}
export interface CommandRun {
  started: Promise<{ startedAt: string; leader?: LinuxProcessIdentity } | null>;
  done: Promise<RunnerOutcome>;
  interrupt(code: string): Promise<void>;
}
export interface RunnerOptions {
  /** Internal test seams only; never exposed through command input. */
  timeoutMs?: number;
  spawnProcess?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  terminate?: typeof signalLinuxOwnedProcessGroup;
}

/** One exact invocation. Completion and interruption compete once on the JS event loop. */
export function runCommand(argv: string[], cwd: string, options: RunnerOptions = {}): CommandRun {
  let accept!: (value: { startedAt: string; leader?: LinuxProcessIdentity } | null) => void;
  let resolve!: (value: RunnerOutcome) => void;
  const started = new Promise<{ startedAt: string; leader?: LinuxProcessIdentity } | null>((r) => { accept = r; });
  const done = new Promise<RunnerOutcome>((r) => { resolve = r; });
  const out = new OutputTail(OUTPUT_BYTES), err = new OutputTail(OUTPUT_BYTES);
  let child: ChildProcess | undefined;
  let leader: LinuxProcessIdentity | undefined;
  let spawned = false, finished = false, interruption: string | undefined;
  let stdoutEnded = false, stderrEnded = false, closed = false, captureError = false;
  let exitCode: number | null = null, exitSignal: string | null = null;
  let stopping: Promise<void> | undefined;
  const deadline = setTimeout(() => { void interrupt("COMMAND_TIMEOUT"); }, options.timeoutMs ?? EXECUTION_TIMEOUT_MS);

  function finish(status: RunnerOutcome["status"], code?: string, termination?: CommandResult["termination"]): void {
    if (finished) return;
    finished = true;
    if (!spawned) accept(null);
    clearTimeout(deadline);
    const result = !spawned ? emptyResult() : {
      exitCode, signal: exitSignal, stdout: out.take(), stderr: err.take(),
      stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
      outputIncomplete: captureError || !stdoutEnded || !stderrEnded,
      ...(termination ? { termination } : {}),
    };
    // Forced local closure never waits for a descendant holding inherited pipes.
    for (const stream of [child?.stdout, child?.stderr]) {
      for (const event of ["data", "end", "error", "close"]) stream?.removeAllListeners(event);
      stream?.on("error", () => undefined);
      stream?.destroy();
    }
    for (const event of ["spawn", "exit", "close", "error"]) child?.removeAllListeners(event);
    child?.on("error", () => undefined);
    child?.unref();
    resolve({ status, ...(code ? { resolutionCode: code } : {}), result });
  }
  function complete(): void {
    if (!interruption && spawned && closed && stdoutEnded && stderrEnded && !captureError) finish("completed");
  }
  function interrupt(code: string): Promise<void> {
    if (stopping) return stopping;
    if (finished) return Promise.resolve();
    // Claim before any await, termination or forced pipe closure. Late callbacks cannot complete.
    interruption = code;
    stopping = (async () => {
      let termination: CommandResult["termination"] = "absent";
      try {
        if (leader) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            (options.terminate ?? signalLinuxOwnedProcessGroup)(leader),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cleanup deadline")), 4_500); }),
          ]).finally(() => clearTimeout(timer));
          termination = result === "signaled" ? "leader" : result;
        }
      } catch { termination = "unavailable"; }
      finish("interrupted", code, termination);
    })();
    return stopping;
  }
  try {
    child = (options.spawnProcess ?? spawn)(argv[0]!, argv.slice(1), {
      cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env },
    });
    child.once("spawn", () => {
      spawned = true;
      const identity = child?.pid ? readLinuxProcessIdentity(child.pid) : undefined;
      if (identity?.kind === "present") leader = identity.identity;
      accept({ startedAt: new Date().toISOString(), ...(leader ? { leader } : {}) });
    });
    child.on("error", () => {
      if (!spawned) { accept(null); finish("failed", "COMMAND_SPAWN_FAILED"); }
      else { captureError = true; void interrupt("COMMAND_OUTPUT_INCOMPLETE"); }
    });
    child.on("exit", (code, signal) => {
      if (finished) return;
      exitCode = code; exitSignal = signal;
    });
    child.on("close", () => { if (!finished) { closed = true; complete(); } });
    for (const [stream, tail, isOut] of [[child.stdout, out, true], [child.stderr, err, false]] as const) {
      if (!stream) { captureError = true; continue; }
      stream.on("data", (chunk: Buffer) => { if (!finished) tail.append(chunk); });
      stream.on("end", () => { if (isOut) stdoutEnded = true; else stderrEnded = true; complete(); });
      stream.on("error", () => { captureError = true; void interrupt("COMMAND_OUTPUT_INCOMPLETE"); });
      stream.on("close", () => {
        if (!finished && !(isOut ? stdoutEnded : stderrEnded)) {
          captureError = true; void interrupt("COMMAND_OUTPUT_INCOMPLETE");
        }
      });
    }
  } catch { accept(null); finish("failed", "COMMAND_SPAWN_FAILED"); }
  return { started, done, interrupt };
}
