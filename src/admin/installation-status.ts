import fs from "node:fs";
import { readAuthorizationSnapshot, type AuthorizationState } from "../auth/store.js";
import { probeBridge, readRuntimeState, runtimeFile, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { getStateDir } from "../config/paths.js";
import { VERSION } from "../version.js";
import { readTunnelState, type TunnelPreference } from "../tunnel/state.js";
import { loadInstallationIfExists } from "../workspaces/installation.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";

export interface InstallationStatus {
  installation: {
    state: "ready" | "uninitialized";
    id: string | null;
    version: string;
    profile: string | null;
  };
  broker: {
    state: "running" | "stopped" | "unknown";
    port?: number;
    version?: string;
  };
  authorization: { state: AuthorizationState };
  tunnel: {
    state: "running" | "stopped" | "unknown";
    provider: "cloudflare-quick" | "cloudflare-named" | null;
    preference: TunnelPreference;
    endpoint?: string;
  };
  workspaces: Array<{ id: string; name: string; liveSessionCount: number | null }>;
  observedAt: string;
}

interface AdminInfoSnapshot {
  authorization?: { state?: unknown };
  tunnel?: { running?: unknown; provider?: unknown; url?: unknown };
}

interface WorkspaceSnapshot {
  id: string;
  displayName: string;
}

const ADMIN_READ_TIMEOUT_MS = 2_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Installation status read was cancelled");
}

function validInstallationId(value: string): boolean {
  return /^c2c_inst_[A-Za-z0-9_-]+$/.test(value);
}

function isProbeTarget(runtime: RuntimeState | null, installationId: string): runtime is RuntimeState {
  return (
    runtime !== null &&
    runtime.workspaceId === installationId &&
    Number.isInteger(runtime.port) &&
    runtime.port > 0 &&
    runtime.port <= 65_535
  );
}

function runtimeFileState(file: string): "present" | "absent" | "unknown" {
  try {
    fs.accessSync(file, fs.constants.F_OK);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

function isAuthorizationState(value: unknown): value is AuthorizationState {
  return value === "authorized" || value === "unauthorized" || value === "unknown";
}

function tunnelPreference(value: unknown): TunnelPreference {
  return value === "quick" || value === "named" ? value : "unset";
}

function localWorkspaces(stateDir: string): WorkspaceSnapshot[] {
  return WorkspaceRegistry.load(stateDir).list().map(({ id, displayName }) => ({ id, displayName }));
}

function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot[] | null {
  if (!value || typeof value !== "object") return null;
  const rows = (value as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(rows)) return null;
  const parsed: WorkspaceSnapshot[] = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof (row as { id?: unknown }).id !== "string" ||
      typeof (row as { displayName?: unknown }).displayName !== "string"
    ) {
      return null;
    }
    parsed.push({
      id: (row as { id: string }).id,
      displayName: (row as { displayName: string }).displayName,
    });
  }
  return parsed;
}

function parseSessionCounts(value: unknown): Map<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!session || typeof session !== "object" || typeof (session as { workspaceId?: unknown }).workspaceId !== "string") {
      return null;
    }
    const workspaceId = (session as { workspaceId: string }).workspaceId;
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  return counts;
}

function summarizeWorkspaces(
  rows: WorkspaceSnapshot[],
  sessionCounts: Map<string, number> | null
): InstallationStatus["workspaces"] {
  return rows.map(({ id, displayName }) => ({
    id,
    name: displayName,
    liveSessionCount: sessionCounts ? sessionCounts.get(id) ?? 0 : null,
  }));
}

function tunnelSnapshot(
  info: AdminInfoSnapshot | undefined,
  preference: TunnelPreference
): InstallationStatus["tunnel"] {
  if (!info?.tunnel || typeof info.tunnel.running !== "boolean") {
    return { state: "unknown", provider: null, preference };
  }
  if (!info.tunnel.running) return { state: "stopped", provider: null, preference };

  const provider =
    info.tunnel.provider === "cloudflare-quick" || info.tunnel.provider === "cloudflare-named"
      ? info.tunnel.provider
      : null;
  const endpoint =
    typeof info.tunnel.url === "string" && info.tunnel.url.trim() !== ""
      ? `${info.tunnel.url.replace(/\/+$/, "")}/mcp`
      : undefined;
  return { state: "running", provider, preference, ...(endpoint ? { endpoint } : {}) };
}

function offlineAuthorization(stateDir: string, installationId: string): { state: AuthorizationState } {
  return validInstallationId(installationId)
    ? readAuthorizationSnapshot(stateDir, installationId)
    : { state: "unknown" };
}

function stoppedTunnel(preference: TunnelPreference): InstallationStatus["tunnel"] {
  return { state: "stopped", provider: null, preference };
}

function unknownTunnel(preference: TunnelPreference): InstallationStatus["tunnel"] {
  return { state: "unknown", provider: null, preference };
}

function readyStatus(
  observedAt: string,
  profile: string | null,
  installationId: string,
  broker: InstallationStatus["broker"],
  tunnel: InstallationStatus["tunnel"],
  authorization: InstallationStatus["authorization"],
  workspaces: InstallationStatus["workspaces"]
): InstallationStatus {
  return {
    installation: { state: "ready", id: installationId, version: VERSION, profile },
    broker,
    authorization,
    tunnel,
    workspaces,
    observedAt,
  };
}

/** Read installation status without creating, repairing, or pruning C2C state. */
export async function getInstallationStatus(opts: { signal?: AbortSignal } = {}): Promise<InstallationStatus> {
  const signal = opts.signal;
  throwIfAborted(signal);
  const stateDir = getStateDir();
  const observedAt = new Date().toISOString();
  const profile = process.env.C2C_PROFILE?.trim() || null;
  const installation = loadInstallationIfExists(stateDir);
  if (!installation) {
    return {
      installation: { state: "uninitialized", id: null, version: VERSION, profile },
      broker: { state: "stopped" },
      authorization: { state: "unauthorized" },
      tunnel: { state: "stopped", provider: null, preference: "unset" },
      workspaces: [],
      observedAt,
    };
  }

  const installationId = installation.installationId;
  const storedTunnel = readTunnelState("installation");
  const preference = tunnelPreference(storedTunnel.preference);
  const localRows = localWorkspaces(stateDir);
  if (!validInstallationId(installationId)) {
    return readyStatus(
      observedAt,
      profile,
      installationId,
      { state: "unknown" },
      unknownTunnel(preference),
      { state: "unknown" },
      summarizeWorkspaces(localRows, null)
    );
  }

  const runtimePath = runtimeFile(installationId);
  const runtimeFileStatus = runtimeFileState(runtimePath);
  if (runtimeFileStatus === "absent") {
    return readyStatus(
      observedAt,
      profile,
      installationId,
      { state: "stopped" },
      stoppedTunnel(preference),
      offlineAuthorization(stateDir, installationId),
      summarizeWorkspaces(localRows, null)
    );
  }
  if (runtimeFileStatus === "unknown") {
    return readyStatus(
      observedAt,
      profile,
      installationId,
      { state: "unknown" },
      unknownTunnel(preference),
      offlineAuthorization(stateDir, installationId),
      summarizeWorkspaces(localRows, null)
    );
  }

  const runtime = readRuntimeState(installationId);
  if (!isProbeTarget(runtime, installationId)) {
    return readyStatus(
      observedAt,
      profile,
      installationId,
      { state: "unknown" },
      unknownTunnel(preference),
      offlineAuthorization(stateDir, installationId),
      summarizeWorkspaces(localRows, null)
    );
  }

  const health = await probeBridge(runtime.port, 2_000, signal);
  throwIfAborted(signal);
  if (!health || health.workspaceId !== installationId) {
    return readyStatus(
      observedAt,
      profile,
      installationId,
      { state: "unknown", port: runtime.port },
      unknownTunnel(preference),
      offlineAuthorization(stateDir, installationId),
      summarizeWorkspaces(localRows, null)
    );
  }

  const brokerVersion = typeof health.version === "string" && health.version.trim() !== ""
    ? health.version
    : undefined;

  const [infoResult, workspaceResult, sessionResult] = await Promise.allSettled([
    adminFetch<AdminInfoSnapshot>(runtime, "GET", "/admin/info", ADMIN_READ_TIMEOUT_MS, undefined, signal),
    adminFetch<unknown>(runtime, "GET", "/admin/workspaces", ADMIN_READ_TIMEOUT_MS, undefined, signal),
    adminFetch<unknown>(runtime, "GET", "/admin/sessions", ADMIN_READ_TIMEOUT_MS, undefined, signal),
  ]);
  throwIfAborted(signal);
  const info = infoResult.status === "fulfilled" ? infoResult.value : undefined;
  const workspaceRows =
    workspaceResult.status === "fulfilled" ? parseWorkspaceSnapshot(workspaceResult.value) : null;
  const sessionCounts = sessionResult.status === "fulfilled" ? parseSessionCounts(sessionResult.value) : null;
  const authorizationState = info && isAuthorizationState(info.authorization?.state)
    ? { state: info.authorization.state }
    : offlineAuthorization(stateDir, installationId);

  return readyStatus(
    observedAt,
    profile,
    installationId,
    { state: "running", port: runtime.port, ...(brokerVersion ? { version: brokerVersion } : {}) },
    tunnelSnapshot(info, preference),
    authorizationState,
    summarizeWorkspaces(workspaceRows ?? localRows, sessionCounts)
  );
}
