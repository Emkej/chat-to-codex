import { installationRuntime } from "../broker/daemon.js";
import { adminFetch } from "../process/daemon.js";
import { throwIfAborted } from "../process/abort.js";
import { getInstallationStatus, type InstallationStatus } from "../admin/installation-status.js";
import type { PendingObservation } from "../write-requests/observation.js";
import type { WriteRequestDetails } from "../write-requests/service.js";
import type { WriteRequestReceipt } from "../write-requests/types.js";
import { MANAGER_STATUS_TIMEOUT_MS } from "./constants.js";

export type ManagerStatus = InstallationStatus & { pendingCounts?: Record<string, number> | null };

export interface ManagerWriteRequestServices {
  list(workspaceId: string, signal: AbortSignal): Promise<PendingObservation>;
  detail(workspaceId: string, id: string, signal: AbortSignal): Promise<WriteRequestDetails>;
  receipt(workspaceId: string, id: string, signal: AbortSignal): Promise<WriteRequestReceipt>;
  approve(id: string, signal: AbortSignal, onDispatch: () => void): Promise<WriteRequestReceipt>;
}

function runtime(signal: AbortSignal) {
  throwIfAborted(signal);
  const current = installationRuntime();
  if (!current) throw new Error("Broker write-request reads are unavailable.");
  return current;
}

async function read<T>(route: string, query: Record<string, string>, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + MANAGER_STATUS_TIMEOUT_MS;
  const current = runtime(signal);
  const params = new URLSearchParams({ ...query, deadline: String(deadline) });
  return adminFetch<T>(current, "GET", `/admin/write-requests/observe${route}?${params}`, Math.max(1, deadline - Date.now()), undefined, signal);
}

export async function readManagerStatus({ signal }: { signal: AbortSignal }): Promise<ManagerStatus> {
  const [status, observation] = await Promise.all([
    getInstallationStatus({ signal }),
    read<PendingObservation>("", {}, signal).catch(() => null),
  ]);
  throwIfAborted(signal);
  return { ...status, pendingCounts: observation?.counts ?? null };
}

export const managerWriteRequestServices: ManagerWriteRequestServices = {
  list: (workspaceId, signal) => read("", { workspaceId, limit: "100" }, signal),
  detail: (workspaceId, id, signal) => read("/" + encodeURIComponent(id), { workspaceId, includePatch: "true" }, signal),
  receipt: (workspaceId, id, signal) => read("/" + encodeURIComponent(id), { workspaceId }, signal),
  approve: async (id, signal, onDispatch) => {
    const current = runtime(signal);
    throwIfAborted(signal);
    onDispatch();
    // Abort ends the response wait; the canonical broker operation may still apply.
    return adminFetch(current, "POST", `/admin/write-requests/${encodeURIComponent(id)}/approve`, 60_000, undefined, signal);
  },
};
