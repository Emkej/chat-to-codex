import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  clearRuntimeRecordIfUnchanged,
  readRuntimeRecord,
  type RuntimeRecordSnapshot,
  type RuntimeState,
} from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { abortableDelay, throwIfAborted } from "../process/abort.js";
import { loadInstallationIfExists, loadOrCreateInstallation } from "../workspaces/installation.js";
import {
  compareLinuxProcessIdentity,
  readLinuxProcessIdentity,
  signalLinuxProcessIdentity,
  type LinuxProcessIdentity,
  type LinuxProcessSignalResult,
} from "./process-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_STARTUP_TIMEOUT_MS = 20_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 12_000;
const BROKER_GRACEFUL_SHUTDOWN_MS = 5_000;
const ADMIN_IDENTITY_TIMEOUT_MS = 1_500;
const PROCESS_POLL_INTERVAL_MS = 100;
const MAX_RECONCILIATIONS = 5;

export type BrokerLifecycleErrorCode =
  | "cancelled"
  | "installation-mismatch"
  | "pid-mismatch"
  | "ownership-unverified"
  | "process-identity-unavailable"
  | "process-identity-changed"
  | "process-signal-unavailable"
  | "runtime-state-unavailable"
  | "runtime-changed"
  | "start-failed"
  | "startup-timeout"
  | "shutdown-timeout";

export class BrokerLifecycleError extends Error {
  constructor(
    readonly code: BrokerLifecycleErrorCode,
    message: string,
    readonly recoveryRequired = false
  ) {
    super(message);
    this.name = "BrokerLifecycleError";
  }
}

export interface BrokerProcessLifecycleOptions {
  stateDir?: string;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Narrow seam for lifecycle tests; production uses PID-bound Linux pidfd signaling. */
  signalProcessIdentity?: (
    identity: LinuxProcessIdentity,
    signal?: AbortSignal,
    timeoutMs?: number
  ) => Promise<LinuxProcessSignalResult>;
}

interface BrokerAdminIdentity {
  installationId?: unknown;
  pid?: unknown;
}

interface VerifiedRuntime {
  runtime: RuntimeState;
  snapshot: Extract<RuntimeRecordSnapshot, { kind: "present" }>;
  identity: LinuxProcessIdentity;
}

type RuntimeInspection =
  | { kind: "verified"; value: VerifiedRuntime }
  | { kind: "changed" }
  | { kind: "stale-cleared" };

type ProcessWaitResult = "absent" | "different" | "matching" | "unknown";

function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) return { cmd: process.execPath, args: [distEntry] };
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failIfAborted(signal?: AbortSignal): void {
  try {
    throwIfAborted(signal);
  } catch (error) {
    throw new BrokerLifecycleError("cancelled", errorMessage(error));
  }
}

function throwRuntimeUnavailable(reason: string): never {
  throw new BrokerLifecycleError("runtime-state-unavailable", `Broker runtime state is unavailable: ${reason}`, true);
}

function recordStillMatches(
  installationId: string,
  snapshot: Extract<RuntimeRecordSnapshot, { kind: "present" }>,
  stateDir: string
): boolean {
  const current = readRuntimeRecord(installationId, stateDir);
  if (current.kind === "unknown") throwRuntimeUnavailable(current.reason);
  return current.kind === "present" && current.raw === snapshot.raw;
}

function validateRuntimeForInstallation(runtime: RuntimeState, installationId: string): void {
  if (runtime.workspaceId !== installationId) {
    throw new BrokerLifecycleError(
      "installation-mismatch",
      "The runtime record belongs to a different installation; broker ownership cannot be verified.",
      true
    );
  }
  if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || !Number.isInteger(runtime.port) || runtime.port <= 0) {
    throw new BrokerLifecycleError(
      "runtime-state-unavailable",
      "The runtime record does not contain a valid broker PID and port.",
      true
    );
  }
}

function clearVerifiedStaleRuntime(
  installationId: string,
  snapshot: Extract<RuntimeRecordSnapshot, { kind: "present" }>,
  stateDir: string
): RuntimeInspection {
  const result = clearRuntimeRecordIfUnchanged(installationId, snapshot, stateDir);
  if (result === "changed") return { kind: "changed" };
  if (result === "unavailable") {
    throw new BrokerLifecycleError(
      "runtime-state-unavailable",
      "The broker process is absent, but its runtime record could not be safely cleared.",
      true
    );
  }
  return { kind: "stale-cleared" };
}

async function inspectRuntime(
  installationId: string,
  snapshot: Extract<RuntimeRecordSnapshot, { kind: "present" }>,
  stateDir: string,
  signal?: AbortSignal
): Promise<RuntimeInspection> {
  const runtime = snapshot.runtime;
  validateRuntimeForInstallation(runtime, installationId);
  failIfAborted(signal);

  let info: BrokerAdminIdentity;
  try {
    info = await adminFetch<BrokerAdminIdentity>(
      runtime,
      "GET",
      "/admin/info",
      ADMIN_IDENTITY_TIMEOUT_MS,
      undefined,
      signal
    );
  } catch (error) {
    failIfAborted(signal);
    if (!recordStillMatches(installationId, snapshot, stateDir)) return { kind: "changed" };
    const process = readLinuxProcessIdentity(runtime.pid);
    if (process.kind === "absent") return clearVerifiedStaleRuntime(installationId, snapshot, stateDir);
    if (process.kind === "unknown") {
      throw new BrokerLifecycleError(
        "process-identity-unavailable",
        `The broker admin API is unreachable and process identity could not be determined: ${process.reason}`,
        true
      );
    }
    throw new BrokerLifecycleError(
      "ownership-unverified",
      `The broker admin API is unreachable while PID ${runtime.pid} still exists; no signal or replacement is safe. ${errorMessage(error)}`,
      true
    );
  }

  failIfAborted(signal);
  if (!recordStillMatches(installationId, snapshot, stateDir)) return { kind: "changed" };
  if (info.installationId !== installationId) {
    throw new BrokerLifecycleError(
      "installation-mismatch",
      "The broker admin API reported a different installation identity; no lifecycle action was taken.",
      true
    );
  }
  if (info.pid !== runtime.pid) {
    throw new BrokerLifecycleError(
      "pid-mismatch",
      "The broker admin API reported a PID different from the runtime record; no lifecycle action was taken.",
      true
    );
  }

  const process = readLinuxProcessIdentity(runtime.pid);
  if (process.kind === "absent") return clearVerifiedStaleRuntime(installationId, snapshot, stateDir);
  if (process.kind === "unknown") {
    throw new BrokerLifecycleError("process-identity-unavailable", process.reason, true);
  }
  failIfAborted(signal);
  if (!recordStillMatches(installationId, snapshot, stateDir)) return { kind: "changed" };

  // Bind the captured /proc identity to the authenticated broker observation.
  // If the PID changed between the first admin response and this read, the
  // second authenticated response or identity read fails before any signal.
  let confirmedInfo: BrokerAdminIdentity;
  try {
    confirmedInfo = await adminFetch<BrokerAdminIdentity>(
      runtime,
      "GET",
      "/admin/info",
      ADMIN_IDENTITY_TIMEOUT_MS,
      undefined,
      signal
    );
  } catch (error) {
    failIfAborted(signal);
    throw new BrokerLifecycleError(
      "ownership-unverified",
      `Broker ownership could not be revalidated after process identity capture: ${errorMessage(error)}`,
      true
    );
  }
  if (confirmedInfo.installationId !== installationId || confirmedInfo.pid !== runtime.pid) {
    throw new BrokerLifecycleError(
      confirmedInfo.installationId !== installationId ? "installation-mismatch" : "pid-mismatch",
      "Broker identity changed while its Linux process identity was being captured; no lifecycle action was taken.",
      true
    );
  }
  const confirmedProcess = readLinuxProcessIdentity(runtime.pid);
  if (confirmedProcess.kind === "absent") return clearVerifiedStaleRuntime(installationId, snapshot, stateDir);
  if (confirmedProcess.kind === "unknown") {
    throw new BrokerLifecycleError("process-identity-unavailable", confirmedProcess.reason, true);
  }
  if (!sameProcessIdentity(process.identity, confirmedProcess.identity)) {
    throw new BrokerLifecycleError(
      "process-identity-changed",
      "The broker PID changed identity while ownership was being verified; no signal or replacement is safe.",
      true
    );
  }
  failIfAborted(signal);
  if (!recordStillMatches(installationId, snapshot, stateDir)) return { kind: "changed" };
  return { kind: "verified", value: { runtime, snapshot, identity: process.identity } };
}

function runtimeSnapshot(
  installationId: string,
  stateDir: string
): Extract<RuntimeRecordSnapshot, { kind: "present" }> | null {
  const snapshot = readRuntimeRecord(installationId, stateDir);
  if (snapshot.kind === "unknown") throwRuntimeUnavailable(snapshot.reason);
  return snapshot.kind === "present" ? snapshot : null;
}

function spawnBroker(stateDir: string): {
  child: ChildProcess;
  logFile: string;
  spawnError: () => Error | undefined;
} {
  const logDir = ensureDir(path.join(stateDir, "logs"));
  const logFile = path.join(logDir, "broker.out.log");
  let out: number;
  try {
    out = fs.openSync(logFile, "a", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    throw new BrokerLifecycleError(
      "start-failed",
      `Cannot write broker log ${logFile} (${code || errorMessage(error)}). Starting the broker requires access to the system daemon state directory.`
    );
  }

  const { cmd, args } = cliEntry();
  try {
    const child = spawn(cmd, [...args, "broker-serve"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, C2C_STATE_DIR: stateDir },
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    return { child, logFile, spawnError: () => spawnError };
  } catch (error) {
    throw new BrokerLifecycleError("start-failed", `Could not start the installation broker: ${errorMessage(error)}`);
  } finally {
    fs.closeSync(out);
  }
}

async function waitForStartedBroker(
  installationId: string,
  stateDir: string,
  child: ChildProcess,
  logFile: string,
  spawnError: () => Error | undefined,
  opts: BrokerProcessLifecycleOptions
): Promise<RuntimeState> {
  const deadline = Date.now() + (opts.startupTimeoutMs ?? BROKER_STARTUP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    failIfAborted(opts.signal);
    const failedToSpawn = spawnError();
    if (failedToSpawn) {
      throw new BrokerLifecycleError("start-failed", `Could not start the installation broker: ${errorMessage(failedToSpawn)}`);
    }
    const snapshot = runtimeSnapshot(installationId, stateDir);
    if (snapshot) {
      try {
        const inspection = await inspectRuntime(installationId, snapshot, stateDir, opts.signal);
        if (inspection.kind === "verified") return inspection.value.runtime;
      } catch (error) {
        failIfAborted(opts.signal);
        if (
          error instanceof BrokerLifecycleError &&
          (error.code === "installation-mismatch" || error.code === "pid-mismatch" || error.code === "runtime-state-unavailable")
        ) {
          throw error;
        }
        // A freshly spawned daemon may have written runtime state before its
        // authenticated admin listener is ready. Keep waiting without
        // treating an unreachable probe as process exit or spawning again.
      }
    }
    if (child.exitCode !== null) {
      throw new BrokerLifecycleError("start-failed", `Broker process exited with code ${child.exitCode}. See ${logFile}`);
    }
    await abortableDelay(Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), opts.signal);
  }
  throw new BrokerLifecycleError("startup-timeout", `Broker did not become healthy within the startup timeout. See ${logFile}`);
}

async function startOrReuseBroker(
  installationId: string,
  opts: BrokerProcessLifecycleOptions
): Promise<RuntimeState> {
  const stateDir = opts.stateDir ?? getStateDir();
  for (let attempt = 0; attempt < MAX_RECONCILIATIONS; attempt++) {
    failIfAborted(opts.signal);
    const snapshot = readRuntimeRecord(installationId, stateDir);
    if (snapshot.kind === "unknown") throwRuntimeUnavailable(snapshot.reason);
    if (snapshot.kind === "present") {
      const inspection = await inspectRuntime(installationId, snapshot, stateDir, opts.signal);
      failIfAborted(opts.signal);
      if (inspection.kind === "verified") return inspection.value.runtime;
      continue;
    }

    // Re-read immediately before spawning so a concurrently committed runtime
    // record is reconciled before this caller creates another daemon.
    const current = readRuntimeRecord(installationId, stateDir);
    if (current.kind === "unknown") throwRuntimeUnavailable(current.reason);
    if (current.kind === "present") continue;

    const { child, logFile, spawnError } = spawnBroker(stateDir);
    failIfAborted(opts.signal); // a spawned daemon is committed state; cancellation leaves it for status reconciliation
    return waitForStartedBroker(installationId, stateDir, child, logFile, spawnError, opts);
  }
  throw new BrokerLifecycleError(
    "runtime-changed",
    "The broker runtime record changed repeatedly while reconciling; refresh status and retry.",
    true
  );
}

function sameProcessIdentity(expected: LinuxProcessIdentity, actual: LinuxProcessIdentity): boolean {
  return expected.pid === actual.pid && expected.startTimeTicks === actual.startTimeTicks;
}

async function waitForOriginalProcess(
  identity: LinuxProcessIdentity,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProcessWaitResult> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let last: ReturnType<typeof compareLinuxProcessIdentity> = { kind: "unknown", reason: "No process read was made" };
  do {
    failIfAborted(signal);
    last = compareLinuxProcessIdentity(identity);
    if (last.kind === "absent" || last.kind === "different") return last.kind;
    if (Date.now() >= deadline) break;
    await abortableDelay(Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), signal);
  } while (Date.now() <= deadline);
  return last.kind === "matching" ? "matching" : "unknown";
}

function currentRuntimeChanged(
  installationId: string,
  verified: VerifiedRuntime,
  stateDir: string
): boolean {
  const current = readRuntimeRecord(installationId, stateDir);
  if (current.kind === "unknown") throwRuntimeUnavailable(current.reason);
  return current.kind === "present" && current.raw !== verified.snapshot.raw;
}

function clearExitedRuntime(installationId: string, verified: VerifiedRuntime, stateDir: string): boolean {
  const result = clearRuntimeRecordIfUnchanged(installationId, verified.snapshot, stateDir);
  if (result === "unavailable") {
    throw new BrokerLifecycleError(
      "runtime-state-unavailable",
      "The original broker process exited, but its runtime record could not be safely reconciled.",
      true
    );
  }
  return result === "cleared" || result === "already-absent";
}

async function reconcileExitedProcess(
  installationId: string,
  verified: VerifiedRuntime,
  stateDir: string,
  opts: BrokerProcessLifecycleOptions
): Promise<"stopped" | "changed" | "replaced"> {
  const current = readRuntimeRecord(installationId, stateDir);
  if (current.kind === "unknown") throwRuntimeUnavailable(current.reason);
  if (current.kind === "absent") return "stopped";
  if (current.raw !== verified.snapshot.raw) return "changed";

  const identity = compareLinuxProcessIdentity(verified.identity);
  if (identity.kind === "absent") {
    return clearExitedRuntime(installationId, verified, stateDir) ? "stopped" : "changed";
  }
  if (identity.kind === "unknown") {
    throw new BrokerLifecycleError("process-identity-unavailable", identity.reason, true);
  }
  if (identity.kind === "matching") return "changed";

  // PID reuse proves the original identity exited, but the new occupant may
  // already be a newer broker. Reconcile its authenticated admin identity
  // before deciding whether the old runtime record can be changed.
  let info: BrokerAdminIdentity;
  try {
    info = await adminFetch<BrokerAdminIdentity>(
      verified.runtime,
      "GET",
      "/admin/info",
      ADMIN_IDENTITY_TIMEOUT_MS,
      undefined,
      opts.signal
    );
  } catch (error) {
    failIfAborted(opts.signal);
    throw new BrokerLifecycleError(
      "ownership-unverified",
      `The original broker identity exited, but PID ${verified.identity.pid} now exists and its broker ownership cannot be verified: ${errorMessage(error)}`,
      true
    );
  }
  if (info.installationId !== installationId || info.pid !== verified.identity.pid) {
    throw new BrokerLifecycleError(
      info.installationId !== installationId ? "installation-mismatch" : "pid-mismatch",
      "The original broker exited, but the reused PID reports a different broker identity; runtime state was preserved.",
      true
    );
  }
  return "replaced";
}

async function stopVerifiedRuntime(
  installationId: string,
  verified: VerifiedRuntime,
  stateDir: string,
  opts: BrokerProcessLifecycleOptions,
  deadline: number
): Promise<"stopped" | "changed" | "replaced"> {
  const { runtime, identity } = verified;
  failIfAborted(opts.signal);
  let graceful = false;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    await adminFetch(runtime, "POST", "/admin/shutdown", Math.min(3_000, remaining), undefined, opts.signal);
    graceful = true;
  } catch (error) {
    failIfAborted(opts.signal);
    // The verified process identity remains the only permitted fallback.
  }

  if (graceful) {
    const grace = Math.min(BROKER_GRACEFUL_SHUTDOWN_MS, Math.max(0, deadline - Date.now()));
    const result = await waitForOriginalProcess(identity, grace, opts.signal);
    if (result === "absent" || result === "different") {
      return reconcileExitedProcess(installationId, verified, stateDir, opts);
    }
    if (result === "unknown") {
      throw new BrokerLifecycleError(
        "process-identity-unavailable",
        "The broker process identity became unreadable while waiting for graceful shutdown; no signal was sent.",
        true
      );
    }
  }

  failIfAborted(opts.signal);
  if (currentRuntimeChanged(installationId, verified, stateDir)) return "changed";
  const currentIdentity = compareLinuxProcessIdentity(identity);
  if (currentIdentity.kind === "absent") {
    return reconcileExitedProcess(installationId, verified, stateDir, opts);
  }
  if (currentIdentity.kind === "unknown") {
    throw new BrokerLifecycleError(
      "process-identity-unavailable",
      `Cannot safely signal broker PID ${identity.pid}: ${currentIdentity.reason}`,
      true
    );
  }
  if (currentIdentity.kind === "different") {
    return reconcileExitedProcess(installationId, verified, stateDir, opts);
  }

  let signalResult: LinuxProcessSignalResult;
  try {
    const signalTimeoutMs = Math.max(0, deadline - Date.now());
    if (signalTimeoutMs === 0) {
      throw new BrokerLifecycleError("shutdown-timeout", "The broker shutdown deadline elapsed before signal fallback.", true);
    }
    signalResult = await (opts.signalProcessIdentity ?? signalLinuxProcessIdentity)(
      identity,
      opts.signal,
      Math.min(1_500, signalTimeoutMs)
    );
  } catch (error) {
    failIfAborted(opts.signal);
    if (error instanceof BrokerLifecycleError) throw error;
    throw new BrokerLifecycleError(
      "process-signal-unavailable",
      `The broker identity still matches, but PID-bound SIGTERM could not be delivered: ${errorMessage(error)}`,
      true
    );
  }
  if (signalResult === "absent" || signalResult === "different") {
    return reconcileExitedProcess(installationId, verified, stateDir, opts);
  }
  const remaining = Math.max(0, deadline - Date.now());
  const result = await waitForOriginalProcess(identity, remaining, opts.signal);
  if (result === "absent" || result === "different") {
    return reconcileExitedProcess(installationId, verified, stateDir, opts);
  }
  if (result === "unknown") {
    throw new BrokerLifecycleError(
      "process-identity-unavailable",
      "The broker process identity became unreadable after SIGTERM; termination was not confirmed.",
      true
    );
  }
  throw new BrokerLifecycleError(
    "shutdown-timeout",
    `The verified broker process PID ${identity.pid} remained alive after the bounded shutdown wait.`,
    true
  );
}

async function stopCurrentBroker(
  installationId: string,
  opts: BrokerProcessLifecycleOptions
): Promise<{ stopped: boolean; foundRuntime: boolean; changed?: boolean }> {
  const stateDir = opts.stateDir ?? getStateDir();
  const deadline = Date.now() + (opts.shutdownTimeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS);
  for (let attempt = 0; attempt < MAX_RECONCILIATIONS; attempt++) {
    failIfAborted(opts.signal);
    const snapshot = readRuntimeRecord(installationId, stateDir);
    if (snapshot.kind === "unknown") throwRuntimeUnavailable(snapshot.reason);
    if (snapshot.kind === "absent") return { stopped: false, foundRuntime: false };

    const inspection = await inspectRuntime(installationId, snapshot, stateDir, opts.signal);
    if (inspection.kind === "changed") continue;
    if (inspection.kind === "stale-cleared") return { stopped: true, foundRuntime: true };
    const outcome = await stopVerifiedRuntime(installationId, inspection.value, stateDir, opts, deadline);
    if (outcome === "stopped") return { stopped: true, foundRuntime: true };
    if (outcome === "replaced") return { stopped: false, foundRuntime: true, changed: true };
  }
  throw new BrokerLifecycleError(
    "runtime-changed",
    "The broker runtime changed repeatedly during shutdown; refresh status before retrying.",
    true
  );
}

export async function ensureBrokerRuntime(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  return startOrReuseBroker(installation.installationId, { ...opts, stateDir });
}

/** One verified stop/wait/start transition shared by Manager and internal callers. */
export async function restartBrokerRuntime(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  await stopCurrentBroker(installation.installationId, { ...opts, stateDir });
  failIfAborted(opts.signal);
  return startOrReuseBroker(installation.installationId, { ...opts, stateDir });
}

/** Recover follows the same ownership and process-exit state machine as restart. */
export async function recoverBrokerRuntime(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  return restartBrokerRuntime(opts);
}

export async function stopBrokerRuntime(
  opts: BrokerProcessLifecycleOptions = {}
): Promise<{ stopped: boolean; foundRuntime: boolean }> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadInstallationIfExists(stateDir);
  if (!installation) return { stopped: false, foundRuntime: false };
  return stopCurrentBroker(installation.installationId, { ...opts, stateDir });
}
