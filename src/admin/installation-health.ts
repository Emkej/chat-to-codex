import { loadInstallationIfExists } from "../workspaces/installation.js";
import { getStateDir } from "../config/paths.js";
import {
  CONNECTOR_SETTINGS_URL,
  DEFAULT_CONNECTOR_NAME,
  confirmStoredConnectorEndpoint,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
} from "../config/endpoint.js";
import { createInstallationPairing, ensureBroker, installationRuntime } from "../broker/daemon.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { getInstallationStatus, type InstallationStatus } from "./installation-status.js";
import { adminFetch } from "../process/daemon.js";
import { abortableDelay } from "../process/abort.js";
import { resolveInstallationTunnel } from "../tunnel/installation.js";
import { needsTunnelChoice, readTunnelState, TUNNEL_CHOICE_PROMPT } from "../tunnel/state.js";
import type { AuthorizationState } from "../auth/store.js";

export interface InstallationHealthOptions {
  fix?: boolean;
  allowTunnelChoiceDefault?: boolean;
  signal?: AbortSignal;
}

export type InstallationHealthIssueCode =
  | "installation-uninitialized"
  | "broker-not-running"
  | "broker-unavailable"
  | "tunnel-not-running"
  | "endpoint-unreachable"
  | "endpoint-unknown"
  | "authorization-required"
  | "authorization-unknown"
  | "connector-state-unavailable"
  | "pairing-unavailable";

export interface InstallationHealthIssue {
  code: InstallationHealthIssueCode;
  component: "installation" | "broker" | "tunnel" | "authorization" | "connector";
  message: string;
  repairable: boolean;
}

export type InstallationHealthRepair =
  | { kind: "broker-started" }
  | { kind: "tunnel-established"; mcpUrl: string }
  | { kind: "tunnel-restarted"; mcpUrl: string }
  | { kind: "pairing-code-generated"; expiresAt: number };

export type InstallationHealthUserAction =
  | {
      kind: "tunnel-setup-required";
      preference: "unset" | "quick" | "named";
      options: readonly ["quick", "named"];
      message: string;
    }
  | {
      kind: "pairing-required";
      connectorName?: string;
      pairingCode?: string;
      expiresAt?: number;
    };

export type ConnectorInstruction =
  | { kind: "none" }
  | {
      kind: "create" | "update";
      connectorName: string;
      mcpUrl: string;
      settingsUrl: string;
      previousMcpUrl: string | null;
      recoveryMessage?: string;
      pairingCode?: string;
      pairingExpiresAt?: number;
    };

export interface InstallationHealthResult {
  ok: boolean;
  status: InstallationStatus;
  endpoint: {
    state: "healthy" | "stopped" | "unreachable" | "unknown";
    mcpUrl: string | null;
  };
  authorization: {
    state: AuthorizationState;
    source: "broker" | "local";
    tokenCount?: number;
  };
  issues: InstallationHealthIssue[];
  repairs: InstallationHealthRepair[];
  connectorInstruction: ConnectorInstruction;
  userActions: InstallationHealthUserAction[];
}

interface InstallationAdminInfo {
  port?: number;
  tokenCount?: number;
  authorization?: { state?: unknown };
  tunnel?: { running?: unknown; url?: unknown };
}

interface TunnelStartResponse {
  url?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

const ENDPOINT_HEALTH_TIMEOUT_MS = 5_000;
const ADMIN_READ_TIMEOUT_MS = 2_000;
const TUNNEL_START_TIMEOUT_MS = 90_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Installation health check was cancelled");
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Health request timed out")), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function endpointResponds(publicUrl: string, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  const request = boundedSignal(signal, ENDPOINT_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${publicUrl.replace(/\/+$/, "")}/health`, { signal: request.signal });
    throwIfAborted(signal);
    return response.ok;
  } catch (error) {
    throwIfAborted(signal);
    return false;
  } finally {
    request.dispose();
  }
}

function validAuthorization(value: unknown): value is AuthorizationState {
  return value === "authorized" || value === "unauthorized" || value === "unknown";
}

function publicUrlFromMcp(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/i, "");
}

function observeEndpoint(runtime: RuntimeState, mcpUrl: string): void {
  const previous = readLastEndpoint(runtime.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: DEFAULT_CONNECTOR_NAME,
    workspaceId: runtime.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: runtime.workspaceId,
    port: runtime.port,
    publicUrl: publicUrlFromMcp(mcpUrl),
    mcpUrl,
    confirmedMcpUrl: previous?.confirmedMcpUrl ?? null,
    connectorName,
  });
}

export function readCurrentConnectorInstruction(workspaceId: string | null): ConnectorInstruction {
  if (!workspaceId) return { kind: "none" };
  const endpoint = readLastEndpoint(workspaceId);
  if (!endpoint?.mcpUrl) return { kind: "none" };
  const action = connectorAction(endpoint.confirmedMcpUrl, endpoint.mcpUrl);
  if (action === "none") return { kind: "none" };

  const connectorName = connectorNameFor({
    workspaceName: DEFAULT_CONNECTOR_NAME,
    workspaceId,
    previousName: endpoint.connectorName,
    hadEndpointBefore: true,
  });
  return {
    kind: action,
    connectorName,
    mcpUrl: endpoint.mcpUrl,
    settingsUrl: CONNECTOR_SETTINGS_URL,
    previousMcpUrl: endpoint.confirmedMcpUrl,
    recoveryMessage:
      action === "update"
        ? reclaimUserMessage(connectorName)
        : `Add "${connectorName}" in Claude connector settings using the current MCP URL.`,
  };
}

function addTunnelChoiceAction(actions: InstallationHealthUserAction[], preference: "unset" | "quick" | "named"): void {
  if (actions.some((action) => action.kind === "tunnel-setup-required")) return;
  actions.push({
    kind: "tunnel-setup-required",
    preference,
    options: ["quick", "named"],
    message: TUNNEL_CHOICE_PROMPT,
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BrokerContext {
  status: InstallationStatus;
  runtime: RuntimeState | null;
  info: InstallationAdminInfo | null;
  error?: string;
}

async function readBrokerContext(
  fix: boolean,
  signal: AbortSignal | undefined,
  repairs: InstallationHealthRepair[]
): Promise<BrokerContext> {
  let status = await getInstallationStatus({ signal });
  let runtime = installationRuntime();
  let error: string | undefined;

  if (fix) {
    try {
      runtime = await ensureBroker({ signal });
      if (status.broker.state !== "running") repairs.push({ kind: "broker-started" });
    } catch (cause) {
      error = safeMessage(cause);
    }
    throwIfAborted(signal);
    try {
      status = await getInstallationStatus({ signal });
    } catch {
      throwIfAborted(signal);
    }
  }

  let info: InstallationAdminInfo | null = null;
  if (runtime) {
    try {
      info = await adminFetch<InstallationAdminInfo>(
        runtime,
        "GET",
        "/admin/info",
        ADMIN_READ_TIMEOUT_MS,
        undefined,
        signal
      );
    } catch (cause) {
      error = safeMessage(cause);
    }
    throwIfAborted(signal);
  }

  return { status, runtime, info, error };
}

interface EndpointCheck {
  state: InstallationHealthResult["endpoint"]["state"];
  mcpUrl: string | null;
  error?: string;
}

async function checkEndpoint(
  context: BrokerContext,
  options: InstallationHealthOptions,
  repairs: InstallationHealthRepair[],
  userActions: InstallationHealthUserAction[]
): Promise<EndpointCheck> {
  const runtime = context.runtime;
  if (!runtime || !context.info) {
    return {
      state: runtime ? "unknown" : context.status.tunnel.state === "unknown" ? "unknown" : "stopped",
      mcpUrl: null,
      ...(context.error ? { error: context.error } : {}),
    };
  }

  const tunnelUrl =
    context.info.tunnel?.running === true && typeof context.info.tunnel.url === "string" && context.info.tunnel.url.trim()
      ? context.info.tunnel.url.trim()
      : null;
  let state: EndpointCheck["state"] = "stopped";
  let mcpUrl: string | null = null;
  let error: string | undefined;

  if (tunnelUrl) {
    let healthy = await endpointResponds(tunnelUrl, options.signal);
    let currentUrl = tunnelUrl;
    if (!healthy && options.fix) {
      try {
        await adminFetch(runtime, "POST", "/admin/tunnel/stop", 5_000, undefined, options.signal).catch(() => undefined);
        await abortableDelay(500, options.signal);
        throwIfAborted(options.signal);
        const restarted = await adminFetch<TunnelStartResponse>(
          runtime,
          "POST",
          "/admin/tunnel/start",
          TUNNEL_START_TIMEOUT_MS,
          undefined,
          options.signal
        );
        const restartedMcpUrl = mcpUrlFromPublic(restarted.url);
        if (restartedMcpUrl) {
          currentUrl = restarted.url!;
          healthy = true;
          mcpUrl = restartedMcpUrl;
          repairs.push({ kind: "tunnel-restarted", mcpUrl: restartedMcpUrl });
        } else {
          error = restarted.message ?? "Tunnel restart did not return a public URL";
        }
      } catch (cause) {
        throwIfAborted(options.signal);
        error = safeMessage(cause);
      }
    }
    if (healthy) {
      state = "healthy";
      mcpUrl ??= mcpUrlFromPublic(currentUrl);
    } else {
      state = "unreachable";
    }
  } else {
    const tunnelState = readTunnelState("installation");
    if (needsTunnelChoice(tunnelState) && !options.allowTunnelChoiceDefault) {
      addTunnelChoiceAction(userActions, tunnelState.preference);
    } else if (options.fix) {
      try {
        const tunnel = await resolveInstallationTunnel(runtime, {
          allowAutoQuick: options.allowTunnelChoiceDefault ?? false,
          signal: options.signal,
        });
        if (tunnel.ok && tunnel.mcpUrl) {
          state = "healthy";
          mcpUrl = tunnel.mcpUrl;
          repairs.push({ kind: "tunnel-established", mcpUrl: tunnel.mcpUrl });
        } else if (tunnel.needsChoice) {
          addTunnelChoiceAction(userActions, tunnel.preference);
        } else {
          error = tunnel.message ?? "Tunnel setup did not return a public URL";
        }
      } catch (cause) {
        throwIfAborted(options.signal);
        error = safeMessage(cause);
      }
    }
  }

  if (state === "healthy" && mcpUrl) {
    try {
      observeEndpoint(runtime, mcpUrl);
    } catch (cause) {
      error = safeMessage(cause);
    }
  }
  return { state, mcpUrl, ...(error ? { error } : {}) };
}

async function refreshStatusAfterRepair(
  status: InstallationStatus,
  repairs: InstallationHealthRepair[],
  signal?: AbortSignal
): Promise<InstallationStatus> {
  if (!repairs.some((repair) => repair.kind !== "pairing-code-generated")) return status;
  try {
    return await getInstallationStatus({ signal });
  } catch {
    throwIfAborted(signal);
    return status;
  }
}

async function pairPendingConnector(
  instruction: ConnectorInstruction,
  endpointState: EndpointCheck["state"],
  fix: boolean,
  signal: AbortSignal | undefined,
  repairs: InstallationHealthRepair[]
): Promise<{ instruction: ConnectorInstruction; error?: string }> {
  if (!fix || endpointState !== "healthy" || instruction.kind === "none") return { instruction };
  try {
    const pairing: PairingResponse = await createInstallationPairing({ signal });
    repairs.push({ kind: "pairing-code-generated", expiresAt: pairing.expiresAt });
    return {
      instruction: { ...instruction, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt },
    };
  } catch (cause) {
    throwIfAborted(signal);
    return { instruction, error: safeMessage(cause) };
  }
}

function healthIssues(opts: {
  status: InstallationStatus;
  runtime: RuntimeState | null;
  info: InstallationAdminInfo | null;
  brokerError?: string;
  endpoint: EndpointCheck;
  authorization: AuthorizationState;
  pairingError?: string;
  connectorError?: string;
}): InstallationHealthIssue[] {
  const issues: InstallationHealthIssue[] = [];
  if (opts.status.installation.state === "uninitialized") {
    issues.push({
      code: "installation-uninitialized",
      component: "installation",
      message: "Installation identity is not initialized",
      repairable: true,
    });
  }
  if (opts.brokerError) {
    issues.push({
      code: "broker-unavailable",
      component: "broker",
      message: opts.brokerError,
      repairable: true,
    });
  } else if (!opts.runtime || !opts.info) {
    issues.push({
      code: "broker-not-running",
      component: "broker",
      message: "Installation broker is not responding",
      repairable: true,
    });
  }

  if (opts.status.installation.state === "ready") {
    if (opts.endpoint.state === "stopped") {
      issues.push({
        code: "tunnel-not-running",
        component: "tunnel",
        message: opts.endpoint.error ?? "Public endpoint is not enabled",
        repairable: true,
      });
    } else if (opts.endpoint.state === "unreachable") {
      issues.push({
        code: "endpoint-unreachable",
        component: "tunnel",
        message: opts.endpoint.error ?? "Public endpoint is unreachable",
        repairable: true,
      });
    } else if (opts.endpoint.state === "unknown") {
      issues.push({
        code: "endpoint-unknown",
        component: "tunnel",
        message: opts.endpoint.error ?? "Public endpoint health could not be determined",
        repairable: true,
      });
    }
    if (opts.authorization === "unauthorized") {
      issues.push({
        code: "authorization-required",
        component: "authorization",
        message: "Claude is not authorized for this installation",
        repairable: false,
      });
    } else if (opts.authorization === "unknown") {
      issues.push({
        code: "authorization-unknown",
        component: "authorization",
        message: "Authorization state could not be determined",
        repairable: false,
      });
    }
  }
  if (opts.connectorError || (opts.endpoint.error && opts.runtime && opts.endpoint.state === "healthy")) {
    issues.push({
      code: "connector-state-unavailable",
      component: "connector",
      message: opts.connectorError ?? opts.endpoint.error!,
      repairable: true,
    });
  }
  if (opts.pairingError) {
    issues.push({
      code: "pairing-unavailable",
      component: "connector",
      message: opts.pairingError,
      repairable: true,
    });
  }
  return issues;
}

function lastObservedMcpUrl(
  status: InstallationStatus,
  runtime: RuntimeState | null,
  endpointMcpUrl: string | null
): string | null {
  if (endpointMcpUrl) return endpointMcpUrl;
  const workspaceId = status.installation.id ?? runtime?.workspaceId ?? null;
  if (!workspaceId) return null;
  try {
    return readLastEndpoint(workspaceId)?.mcpUrl ?? null;
  } catch {
    return null;
  }
}

/** Check installation health and optionally repair broker/tunnel issues. */
export async function checkInstallationHealth(
  options: InstallationHealthOptions = {}
): Promise<InstallationHealthResult> {
  const fix = options.fix ?? false;
  const signal = options.signal;
  throwIfAborted(signal);
  const repairs: InstallationHealthRepair[] = [];
  const userActions: InstallationHealthUserAction[] = [];
  const context = await readBrokerContext(fix, signal, repairs);
  const endpoint = await checkEndpoint(context, options, repairs, userActions);
  const status = await refreshStatusAfterRepair(context.status, repairs, signal);
  let connectorInstruction: ConnectorInstruction = { kind: "none" };
  let connectorError: string | undefined;
  try {
    connectorInstruction = readCurrentConnectorInstruction(status.installation.id ?? context.runtime?.workspaceId ?? null);
  } catch (cause) {
    connectorError = safeMessage(cause);
  }
  const pairing = await pairPendingConnector(connectorInstruction, endpoint.state, fix, signal, repairs);
  connectorInstruction = pairing.instruction;
  const authorizationState = validAuthorization(context.info?.authorization?.state)
    ? context.info.authorization.state
    : status.authorization.state;
  const authorization = {
    state: authorizationState,
    source: context.info ? ("broker" as const) : ("local" as const),
    ...(typeof context.info?.tokenCount === "number" ? { tokenCount: context.info.tokenCount } : {}),
  };
  const issues = healthIssues({
    status,
    runtime: context.runtime,
    info: context.info,
    brokerError: context.error,
    endpoint,
    authorization: authorization.state,
    pairingError: pairing.error,
    connectorError,
  });
  if (
    endpoint.state === "healthy" &&
    (authorization.state === "unauthorized" || connectorInstruction.kind !== "none")
  ) {
    userActions.push({
      kind: "pairing-required",
      ...(connectorInstruction.kind !== "none" ? { connectorName: connectorInstruction.connectorName } : {}),
      ...(connectorInstruction.kind !== "none" && connectorInstruction.pairingCode
        ? { pairingCode: connectorInstruction.pairingCode, expiresAt: connectorInstruction.pairingExpiresAt }
        : {}),
    });
  }

  return {
    ok: issues.length === 0,
    status,
    endpoint: { state: endpoint.state, mcpUrl: lastObservedMcpUrl(status, context.runtime, endpoint.mcpUrl) },
    authorization,
    issues,
    repairs,
    connectorInstruction,
    userActions,
  };
}

/** Confirm the connector URL only if it remains the installation's current observation. */
export function confirmConnectorEndpoint(opts: { mcpUrl: string }):
  | { ok: true; mcpUrl: string }
  | { ok: false; reason: "endpoint-mismatch" | "installation-uninitialized"; currentMcpUrl: string | null } {
  const installation = loadInstallationIfExists(getStateDir());
  if (!installation) {
    return { ok: false, reason: "installation-uninitialized", currentMcpUrl: null };
  }
  return confirmStoredConnectorEndpoint({ workspaceId: installation.installationId, mcpUrl: opts.mcpUrl });
}
