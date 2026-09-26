import {
  checkInstallationHealth,
  readCurrentConnectorInstruction,
  type ConnectorInstruction,
  type InstallationHealthIssue,
  type InstallationHealthUserAction,
} from "./installation-health.js";
import type { InstallationStatus } from "./installation-status.js";
import { getInstallationStatus } from "./installation-status.js";
import {
  BrokerLifecycleError,
  ensureBrokerRuntime,
  recoverBrokerRuntime,
  restartBrokerRuntime,
  stopBrokerRuntime,
} from "../broker/installation-process.js";
import { readLastEndpoint } from "../config/endpoint.js";
import { throwIfAborted } from "../process/abort.js";

export type InstallationLifecycleOperation = "start" | "restart" | "recover" | "stop";
export type InstallationLifecycleOutcome = "success" | "partial-success" | "failure";

export interface InstallationLifecycleResult {
  requestedOperation: InstallationLifecycleOperation;
  outcome: InstallationLifecycleOutcome;
  status: InstallationStatus;
  broker: InstallationStatus["broker"];
  tunnel: InstallationStatus["tunnel"];
  currentMcpUrl: string | null;
  connectorInstruction: ConnectorInstruction;
  userActions: InstallationHealthUserAction[];
  issues: InstallationHealthIssue[];
  pairing?: { code: string; expiresAt: number };
  error?: {
    code: string;
    message: string;
    recoveryRequired: boolean;
  };
}

export interface InstallationLifecycleOptions {
  signal?: AbortSignal;
}

function emptyStatus(): InstallationStatus {
  return {
    installation: { state: "uninitialized", id: null, version: "unknown", profile: null },
    broker: { state: "unknown" },
    authorization: { state: "unknown" },
    tunnel: { state: "unknown", provider: null, preference: "unset" },
    workspaces: [],
    observedAt: new Date().toISOString(),
  };
}

function failure(
  operation: InstallationLifecycleOperation,
  status: InstallationStatus,
  code: string,
  message: string,
  recoveryRequired = false,
  preserveObservedBrokerState = false
): InstallationLifecycleResult {
  const current: InstallationStatus = preserveObservedBrokerState
    ? status
    : {
        ...status,
        broker: { state: "unknown", ...(status.broker.port ? { port: status.broker.port } : {}) },
        observedAt: new Date().toISOString(),
      };
  let connectorInstruction: ConnectorInstruction = { kind: "none" };
  let currentMcpUrl: string | null = null;
  try {
    connectorInstruction = readCurrentConnectorInstruction(status.installation.id);
    currentMcpUrl = status.installation.id ? readLastEndpoint(status.installation.id)?.mcpUrl ?? null : null;
  } catch {
    // Preserve the lifecycle error as the primary result if connector state is unreadable.
  }
  if (!currentMcpUrl && connectorInstruction.kind !== "none") currentMcpUrl = connectorInstruction.mcpUrl;
  return {
    requestedOperation: operation,
    outcome: "failure",
    status: current,
    broker: current.broker,
    tunnel: current.tunnel,
    currentMcpUrl,
    connectorInstruction,
    userActions: [],
    issues: [],
    error: { code, message, recoveryRequired },
    ...(connectorInstruction.kind !== "none" && connectorInstruction.pairingCode
      ? { pairing: { code: connectorInstruction.pairingCode, expiresAt: connectorInstruction.pairingExpiresAt! } }
      : {}),
  };
}

function lifecycleError(error: unknown, signal?: AbortSignal): { code: string; message: string; recoveryRequired: boolean } {
  if (signal?.aborted) {
    return {
      code: "cancelled",
      message: error instanceof Error ? error.message : "Installation lifecycle operation was cancelled",
      recoveryRequired: false,
    };
  }
  if (error instanceof BrokerLifecycleError) {
    return { code: error.code, message: error.message, recoveryRequired: error.recoveryRequired };
  }
  return {
    code: "lifecycle-failed",
    message: error instanceof Error ? error.message : String(error),
    recoveryRequired: false,
  };
}

async function observeStatus(signal?: AbortSignal): Promise<InstallationStatus> {
  try {
    return await getInstallationStatus({ signal });
  } catch {
    return emptyStatus();
  }
}

async function reconcileRunningBroker(
  operation: InstallationLifecycleOperation,
  signal?: AbortSignal
): Promise<InstallationLifecycleResult> {
  const before = await observeStatus(signal);
  try {
    const health = await checkInstallationHealth({ fix: true, allowTunnelChoiceDefault: false, signal });
    const status = health.status;
    const setupRequired = health.userActions.some((action) => action.kind === "tunnel-setup-required");
    const outcome: InstallationLifecycleOutcome =
      status.broker.state !== "running" ? "failure" : setupRequired || health.issues.length > 0 ? "partial-success" : "success";
    const result: InstallationLifecycleResult = {
      requestedOperation: operation,
      outcome,
      status,
      broker: status.broker,
      tunnel: status.tunnel,
      currentMcpUrl: health.endpoint.mcpUrl,
      connectorInstruction: health.connectorInstruction,
      userActions: health.userActions,
      issues: health.issues,
    };
    if (health.connectorInstruction.kind !== "none" && health.connectorInstruction.pairingCode) {
      result.pairing = {
        code: health.connectorInstruction.pairingCode,
        expiresAt: health.connectorInstruction.pairingExpiresAt!,
      };
    }
    if (outcome === "failure") {
      result.error = {
        code: "broker-not-running",
        message: "Broker health reconciliation did not confirm a running broker.",
        recoveryRequired: true,
      };
    }
    return result;
  } catch (error) {
    const reason = lifecycleError(error, signal);
    return failure(operation, before, reason.code, reason.message, reason.recoveryRequired);
  }
}

/** Start or reuse the installation broker, then reconcile its existing tunnel and connector state. */
export async function startInstallationBroker(
  opts: InstallationLifecycleOptions = {}
): Promise<InstallationLifecycleResult> {
  const before = await observeStatus(opts.signal);
  try {
    await ensureBrokerRuntime({ signal: opts.signal });
  } catch (error) {
    const reason = lifecycleError(error, opts.signal);
    return failure("start", before, reason.code, reason.message, reason.recoveryRequired);
  }
  return reconcileRunningBroker("start", opts.signal);
}

/** Stop the verified broker, wait for its original process identity, then start its replacement. */
export async function restartInstallationBroker(
  opts: InstallationLifecycleOptions = {}
): Promise<InstallationLifecycleResult> {
  const before = await observeStatus(opts.signal);
  try {
    await restartBrokerRuntime({ signal: opts.signal });
  } catch (error) {
    const reason = lifecycleError(error, opts.signal);
    return failure("restart", before, reason.code, reason.message, reason.recoveryRequired);
  }
  return reconcileRunningBroker("restart", opts.signal);
}

/** Recover is valid only while the observational broker state is unknown. */
export async function recoverInstallationBroker(
  opts: InstallationLifecycleOptions = {}
): Promise<InstallationLifecycleResult> {
  const before = await observeStatus(opts.signal);
  if (before.broker.state !== "unknown") {
    return failure(
      "recover",
      before,
      "recovery-not-required",
      `Broker recovery requires unknown state; current state is ${before.broker.state}.`,
      false,
      true
    );
  }
  try {
    await recoverBrokerRuntime({ signal: opts.signal });
  } catch (error) {
    const reason = lifecycleError(error, opts.signal);
    return failure("recover", before, reason.code, reason.message, reason.recoveryRequired);
  }
  return reconcileRunningBroker("recover", opts.signal);
}

/** Stop the installation broker only after verified shutdown or signal fallback has completed. */
export async function stopInstallationBroker(
  opts: InstallationLifecycleOptions = {}
): Promise<InstallationLifecycleResult> {
  const before = await observeStatus(opts.signal);
  try {
    await stopBrokerRuntime({ signal: opts.signal });
    throwIfAborted(opts.signal);
    const health = await checkInstallationHealth({ fix: false, allowTunnelChoiceDefault: false, signal: opts.signal });
    const status = health.status;
    const outcome = status.broker.state === "stopped" ? "success" : "failure";
    return {
      requestedOperation: "stop",
      outcome,
      status,
      broker: status.broker,
      tunnel: status.tunnel,
      currentMcpUrl: health.endpoint.mcpUrl,
      connectorInstruction: health.connectorInstruction,
      userActions: health.userActions,
      issues: health.issues,
      ...(outcome === "failure"
        ? {
            error: {
              code: "broker-stop-unconfirmed",
              message: "The broker process was not confirmed stopped after the bounded lifecycle operation.",
              recoveryRequired: true,
            },
          }
        : {}),
    };
  } catch (error) {
    const reason = lifecycleError(error, opts.signal);
    return failure("stop", before, reason.code, reason.message, reason.recoveryRequired);
  }
}
