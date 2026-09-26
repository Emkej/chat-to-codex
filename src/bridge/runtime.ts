import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { abortableDelay, throwIfAborted } from "../process/abort.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function runtimeFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(stateDir, "runtime", `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState, stateDir = getStateDir()): void {
  const file = runtimeFile(state.workspaceId, stateDir);
  if (process.platform !== "linux") {
    writeSecureJson(file, state);
    return;
  }
  runLinuxRuntimeRecordOperation("write", state.workspaceId, stateDir, { file, state });
}

export function readRuntimeState(workspaceId: string, stateDir = getStateDir()): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId, stateDir));
}

export function clearRuntimeState(workspaceId: string, stateDir = getStateDir()): void {
  if (process.platform !== "linux") {
    try {
      fs.rmSync(runtimeFile(workspaceId, stateDir), { force: true });
    } catch {
      // ignore
    }
    return;
  }
  runLinuxRuntimeRecordOperation("clear", workspaceId, stateDir, { file: runtimeFile(workspaceId, stateDir) });
}

/** Serialize Linux runtime mutations with a kernel lock that is released if its owner exits. */
type RuntimeRecordOperationResult = "written" | "cleared" | "already-absent" | "changed" | "unavailable";

function linuxLockUtility(): string {
  for (const candidate of ["/usr/bin/flock", "/bin/flock"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Resolve only from fixed system locations; do not trust caller PATH.
    }
  }
  throw new Error("The operating-system file-lock utility is unavailable.");
}

function runLinuxRuntimeRecordOperation(
  operation: "write" | "clear" | "clear-if-unchanged",
  workspaceId: string,
  stateDir: string,
  details: { file: string; state?: RuntimeState; expectedRaw?: string }
): RuntimeRecordOperationResult {
  const directory = ensureDir(path.join(stateDir, "runtime"));
  const lock = path.join(directory, `${workspaceId}.lifecycle-lock`);
  const script = `
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    try { fs.chmodSync(input.lock, 0o600); } catch {}
    if (input.operation === "write") {
      const temporary = input.file + "." + crypto.randomUUID() + ".tmp";
      try {
        fs.writeFileSync(temporary, JSON.stringify(input.state, null, 2) + "\\n", { mode: 0o600 });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, input.file);
      } finally {
        try { fs.rmSync(temporary, { force: true }); } catch {}
      }
      process.stdout.write("written");
    } else if (input.operation === "clear") {
      try { fs.rmSync(input.file, { force: true }); } catch {}
      process.stdout.write("cleared");
    } else {
      let current;
      let readResult;
      try { current = fs.readFileSync(input.file, "utf8"); }
      catch (error) { readResult = error && error.code === "ENOENT" ? "already-absent" : "unavailable"; }
      if (readResult) {
        process.stdout.write(readResult);
      } else if (current !== input.expectedRaw) {
        process.stdout.write("changed");
      } else {
        try { fs.unlinkSync(input.file); process.stdout.write("cleared"); }
        catch (error) { process.stdout.write(error && error.code === "ENOENT" ? "already-absent" : "unavailable"); }
      }
    }
  `;
  const result = spawnSync(
    linuxLockUtility(),
    ["--exclusive", "--nonblock", "--no-fork", lock, process.execPath, "-e", script],
    {
      input: JSON.stringify({ operation, lock, ...details }),
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }
  );
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit status ${String(result.status)}`);
    throw new Error(`Could not update installation runtime record: ${reason}`);
  }
  const output = result.stdout.trim();
  const allowedOutput: Record<typeof operation, readonly RuntimeRecordOperationResult[]> = {
    write: ["written"],
    clear: ["cleared"],
    "clear-if-unchanged": ["cleared", "already-absent", "changed", "unavailable"],
  };
  if (!allowedOutput[operation].includes(output as RuntimeRecordOperationResult)) {
    throw new Error(`Could not update installation runtime record: unexpected result from lock helper`);
  }
  return output as RuntimeRecordOperationResult;
}

export type RuntimeRecordSnapshot =
  | { kind: "absent" }
  | { kind: "present"; runtime: RuntimeState; raw: string }
  | { kind: "unknown"; reason: string };

export type ClearRuntimeRecordResult = "cleared" | "already-absent" | "changed" | "unavailable";

/** Read the runtime file without conflating malformed or unreadable state with absence. */
export function readRuntimeRecord(workspaceId: string, stateDir = getStateDir()): RuntimeRecordSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(runtimeFile(workspaceId, stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    const value = JSON.parse(raw) as Partial<RuntimeState> | null;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.service !== "string" ||
      typeof value.version !== "string" ||
      typeof value.workspaceId !== "string" ||
      typeof value.workspaceRoot !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.port !== "number" ||
      typeof value.adminToken !== "string" ||
      (value.publicUrl !== null && typeof value.publicUrl !== "string") ||
      typeof value.startedAt !== "string"
    ) {
      return { kind: "unknown", reason: "Runtime record is malformed" };
    }
    return { kind: "present", runtime: value as RuntimeState, raw };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Clear stale state only while the exact record inspected by the caller remains current. */
export function clearRuntimeRecordIfUnchanged(
  workspaceId: string,
  expected: Extract<RuntimeRecordSnapshot, { kind: "present" }>,
  stateDir = getStateDir()
): ClearRuntimeRecordResult {
  const file = runtimeFile(workspaceId, stateDir);
  if (process.platform !== "linux") {
    let current: string;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-absent";
      return "unavailable";
    }
    if (current !== expected.raw) return "changed";
    try {
      fs.unlinkSync(file);
      return "cleared";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-absent";
      return "unavailable";
    }
  }
  try {
    const result = runLinuxRuntimeRecordOperation("clear-if-unchanged", workspaceId, stateDir, {
      file,
      expectedRaw: expected.raw,
    });
    if (result === "written") return "unavailable";
    return result;
  } catch (error) {
    return "unavailable";
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000,
  signal?: AbortSignal
): Promise<HealthPayload | null> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    throwIfAborted(signal);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    throwIfAborted(signal);
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    throwIfAborted(signal);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Find a live bridge for a workspace via its runtime state file.
 *
 * The loopback health probe occasionally times out even against a healthy,
 * idle bridge (observed on macOS). Acting on a single missed probe is
 * dangerous: `ensureBridge` would spawn a duplicate daemon that hijacks the
 * runtime state while the original keeps the tunnel, and commands like
 * `unpair` would silently do nothing. Retry before concluding it is down.
 */
export async function findLiveBridge(
  workspaceId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RuntimeState | null> {
  throwIfAborted(opts.signal);
  const state = readRuntimeState(workspaceId);
  if (!state) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfAborted(opts.signal);
    const health = await probeBridge(state.port, opts.timeoutMs ?? 2000, opts.signal);
    if (health && health.workspaceId === workspaceId) return state;
    if (attempt < 2) await abortableDelay(200, opts.signal);
  }
  return null;
}

export { SERVICE_NAME, VERSION };
