import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch } from "../process/daemon.js";
import { readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { resolveLocalTarget, type LocalTargetRegistration } from "../workspace/local-target.js";
import type { WorktreeRunner } from "../workspace/worktrees.js";
import { AuthStore } from "../auth/store.js";
import { loadInstallationIfExists, loadOrCreateInstallation } from "../workspaces/installation.js";
import {
  ensureBrokerRuntime,
  recoverBrokerRuntime,
  restartBrokerRuntime,
  stopBrokerRuntime,
  type BrokerProcessLifecycleOptions,
} from "./installation-process.js";

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export function installationRuntime(stateDir = getStateDir()): RuntimeState | null {
  const installation = loadInstallationIfExists(stateDir);
  if (!installation) return null;
  return readRuntimeState(installation.installationId, stateDir);
}

/** Ensure an installation broker through verified runtime ownership checks. */
export async function ensureBroker(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  return ensureBrokerRuntime(opts);
}

/** Restart through one verified termination/start transition. */
export async function restartBroker(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  return restartBrokerRuntime(opts);
}

/** Recover a broker through the same verified transition used by restart. */
export async function recoverBroker(opts: BrokerProcessLifecycleOptions = {}): Promise<RuntimeState> {
  return recoverBrokerRuntime(opts);
}

/** Compatibility wrapper; it reports true only after stale or live runtime is stopped. */
export async function stopBroker(opts: BrokerProcessLifecycleOptions = {}): Promise<boolean> {
  const result = await stopBrokerRuntime(opts);
  return result.stopped;
}

/** Establish the broker's public tunnel, if not already up. Returns the URL. */
export async function ensureBrokerTunnel(
  runtime: RuntimeState,
  opts: { signal?: AbortSignal } = {}
): Promise<string> {
  if (runtime.publicUrl) return runtime.publicUrl;
  const result = await adminFetch<{ url?: string; message?: string }>(
    runtime,
    "POST",
    "/admin/tunnel/start",
    90_000,
    undefined,
    opts.signal
  );
  if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
  return result.url;
}

// ---- Local Codex session binding ---------------------------------------

export interface LocalSessionBinding {
  sessionId: string;
  workspaceId: string;
  refreshedAt: string;
}

function bindingFile(stateDir: string, workspaceId: string): string {
  return path.join(ensureDir(path.join(stateDir, "agent-sessions")), `${workspaceId}.json`);
}

function loadBinding(stateDir: string, workspaceId: string): LocalSessionBinding | null {
  try {
    const data = JSON.parse(fs.readFileSync(bindingFile(stateDir, workspaceId), "utf8")) as LocalSessionBinding;
    return data.sessionId ? data : null;
  } catch {
    return null;
  }
}

function clearBinding(stateDir: string, workspaceKey: string): void {
  try {
    fs.rmSync(bindingFile(stateDir, workspaceKey), { force: true });
  } catch {
    // ignore
  }
}

function saveBinding(stateDir: string, binding: LocalSessionBinding, workspaceKey: string): void {
  const file = bindingFile(stateDir, workspaceKey);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(binding, null, 2), { mode: 0o600 });
}

/**
 * Register the workspace (idempotent) and keep a live Codex session bound to
 * it. The binding survives in the state dir so later commands (record,
 * doctor) can heartbeat the same session. Fails closed if the broker is
 * unreachable.
 */
export async function ensureWorkspaceSession(
  runtime: RuntimeState,
  workspaceRoot: string,
  opts: { stateDir?: string; displayName?: string; pid?: number; worktreeRunner?: WorktreeRunner } = {}
): Promise<{ workspaceId: string; displayName: string; sessionId: string; created: boolean; worktreeId?: string }> {
  const stateDir = opts.stateDir ?? getStateDir();
  // Binding files are keyed by the workspace's stable root-hash id, so they
  // survive display-name changes; the registry id lives inside the binding.
  const workspace = new Workspace(workspaceRoot);
  const workspaceKey = workspace.id;
  const snapshot = await adminFetch<{ workspaces: LocalTargetRegistration[] }>(runtime, "GET", "/admin/workspaces");
  const target = resolveLocalTarget(workspace.root, snapshot.workspaces, opts.worktreeRunner);
  if (target.kind === "derived" && opts.displayName?.trim()) {
    throw new Error("--name cannot rename a derived worktree; use it from the registered main workspace");
  }

  const registration =
    target.kind === "derived"
      ? target.registration!
      : await adminFetch<{ id: string; displayName: string }>(
          runtime,
          "POST",
          "/admin/workspace",
          60_000,
          { root: workspace.root, displayName: opts.displayName }
        );

  const existing = loadBinding(stateDir, workspaceKey);
  if (existing && existing.workspaceId === registration.id) {
    try {
      await adminFetch(runtime, "POST", "/admin/session/heartbeat", 10_000, {
        sessionId: existing.sessionId,
      });
      return {
        workspaceId: registration.id,
        displayName: registration.displayName,
        sessionId: existing.sessionId,
        created: false,
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
      };
    } catch {
      // expired or cleared: fall through and create a fresh session
    }
  }

  const session = await adminFetch<{ sessionId: string }>(runtime, "POST", "/admin/session", 10_000, {
    workspaceId: registration.id,
    pid: opts.pid,
  });
  saveBinding(stateDir, {
    sessionId: session.sessionId,
    workspaceId: registration.id,
    refreshedAt: new Date().toISOString(),
  }, workspaceKey);
  return {
    workspaceId: registration.id,
    displayName: registration.displayName,
    sessionId: session.sessionId,
    created: true,
    ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
  };
}

/** Heartbeat the stored session for a workspace, if one is bound. */
export async function heartbeatWorkspaceSession(
  workspaceRoot: string,
  opts: { stateDir?: string } = {}
): Promise<boolean> {
  const stateDir = opts.stateDir ?? getStateDir();
  const runtime = installationRuntime(stateDir);
  if (!runtime) return false;
  const workspaceKey = new Workspace(workspaceRoot).id;
  const binding = loadBinding(stateDir, workspaceKey);
  if (!binding) return false;
  try {
    await adminFetch(runtime, "POST", "/admin/session/heartbeat", 10_000, {
      sessionId: binding.sessionId,
    });
    return true;
  } catch {
    return false;
  }
}


/** End the bound Codex session for a workspace and remove the local binding file. */
export async function endWorkspaceSession(
  workspaceRoot: string,
  opts: { stateDir?: string } = {}
): Promise<{ ended: boolean; sessionId?: string }> {
  const stateDir = opts.stateDir ?? getStateDir();
  const workspaceKey = new Workspace(workspaceRoot).id;
  const binding = loadBinding(stateDir, workspaceKey);
  if (!binding) return { ended: false };

  const runtime = installationRuntime(stateDir);
  if (runtime) {
    try {
      await adminFetch(runtime, "POST", "/admin/session/end", 10_000, {
        sessionId: binding.sessionId,
      });
    } catch {
      // session may already be expired or cleared server-side
    }
  }
  clearBinding(stateDir, workspaceKey);
  return { ended: true, sessionId: binding.sessionId };
}


/** Revoke every OAuth token for this installation (live broker or persisted store). */
export async function revokeInstallationAuth(opts: { stateDir?: string } = {}): Promise<number> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  const runtime = installationRuntime(stateDir);
  if (runtime) {
    const result = await adminFetch<{ revoked: number }>(runtime, "POST", "/admin/revoke-all");
    return result.revoked ?? 0;
  }
  return new AuthStore(installation.installationId).revokeAll();
}

export interface PairingResponse {
  code: string;
  expiresAt: number;
}

/** Mint a one-time pairing code for the installation connector. */
export async function createInstallationPairing(
  opts: { stateDir?: string; signal?: AbortSignal } = {}
): Promise<PairingResponse> {
  const runtime = await ensureBroker(opts);
  return adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing", 60_000, undefined, opts.signal);
}
