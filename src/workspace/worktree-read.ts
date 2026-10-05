import { spawn } from "node:child_process";
import { throwIfAborted } from "../process/abort.js";
import { sanitizedGitEnvironment, type GitCommandResult } from "./git.js";
import { derivedWorktreeRead, type DerivedWorktree, type WorktreeReadCommand, type WorktreeResolutionOptions } from "./worktrees.js";

interface ReadBudget {
  bytes: number;
  maxBytes: number;
}

/** Reject only after the owned command and its pipes have retired. */
function runCommand(command: WorktreeReadCommand, signal: AbortSignal, budget: ReadBudget): Promise<GitCommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const args = command.gitDir
      ? ["--git-dir", command.gitDir, "--work-tree", command.root, ...command.args]
      : command.args;
    const grouped = process.platform !== "win32";
    const child = spawn(command.executable, args, {
      cwd: command.root,
      env: sanitizedGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        // The process may already have exited; close still owns completion.
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 100);
    };
    const abort = () => stop(new Error("Workspace detail read cancelled."));
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      budget.bytes += chunk.length;
      if (budget.bytes > budget.maxBytes) stop(new Error("Workspace detail output limit exceeded."));
      else if (!failure) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => { failure ??= new Error("Workspace detail command unavailable."); });
    child.on("close", (code) => {
      if (failure) kill("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ ok: code === 0, code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One total deadline/output budget includes Git and WSL path conversion. */
export async function discoverDerivedWorktreesAsync(
  root: string,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes?: number;
    resolution?: Omit<WorktreeResolutionOptions, "resolveWslPath">;
  }
): Promise<DerivedWorktree[]> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
      !Number.isFinite(options.maxOutputBytes ?? 1024 * 1024) || (options.maxOutputBytes ?? 1024 * 1024) <= 0) {
    throw new Error("Invalid workspace detail read budget.");
  }
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  const deadline = Date.now() + options.timeoutMs;
  const timer = setTimeout(cancel, options.timeoutMs);
  const budget = { bytes: 0, maxBytes: options.maxOutputBytes ?? 1024 * 1024 };
  const read = derivedWorktreeRead(root, options.resolution, true);
  try {
    let step = read.next();
    while (!step.done) {
      if (Date.now() >= deadline) cancel();
      throwIfAborted(controller.signal);
      const result = await runCommand(step.value, controller.signal, budget);
      throwIfAborted(controller.signal);
      step = read.next(result);
    }
    if (Date.now() >= deadline) cancel();
    throwIfAborted(controller.signal);
    return step.value;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    read.return([]);
  }
}
