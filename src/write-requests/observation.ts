import type { WriteRequestStore } from "./store.js";
import { toReceipt, WriteRequestError, type WriteRequestReceipt } from "./types.js";
import type { WriteReadBudget } from "./read-budget.js";

export interface PendingObservation {
  counts: Record<string, number>;
  requests: WriteRequestReceipt[];
  overflow: boolean;
}

export interface WriteObservationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function compareReceipts(a: WriteRequestReceipt, b: WriteRequestReceipt): number {
  return Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt) || a.id.localeCompare(b.id);
}

export async function observePending(
  store: WriteRequestStore, budget: WriteReadBudget, now: number, workspaceId?: string, limit = 100
): Promise<PendingObservation> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const requests: WriteRequestReceipt[] = [];
  const pageLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  let matched = 0;
  await store.visitObserved(budget, (record) => {
    if (record.status !== "pending" || Date.parse(record.expiresAt!) <= now) return;
    counts[record.workspaceId] = (counts[record.workspaceId] ?? 0) + 1;
    if (workspaceId === undefined || record.workspaceId !== workspaceId) return;
    matched++;
    const receipt = toReceipt(record);
    const index = requests.findIndex((entry) => compareReceipts(receipt, entry) < 0);
    if (index === -1) {
      if (requests.length < pageLimit) requests.push(receipt);
    } else {
      // Never retain pageLimit+1 entries, even briefly.
      if (requests.length === pageLimit) requests.pop();
      requests.splice(index, 0, receipt);
    }
  });
  budget.check();
  return { counts, requests, overflow: matched > pageLimit };
}

export async function observeRequest(
  store: WriteRequestStore, budget: WriteReadBudget, now: number,
  id: string, workspaceId: string, includePatch: boolean
): Promise<WriteRequestReceipt & { patch?: string }> {
  const record = await store.getObserved(id, budget);
  if (!record || record.workspaceId !== workspaceId) {
    throw new WriteRequestError("WRITE_REQUEST_NOT_FOUND", "Write request was not found in the selected workspace.");
  }
  // Project expiry in memory only. Reconciliation is receipt-only, including terminal outcomes.
  const receipt = toReceipt(record);
  if (record.status === "pending" && Date.parse(record.expiresAt!) <= now) {
    return { ...receipt, status: "expired", resolutionCode: "WRITE_REQUEST_EXPIRED" };
  }
  if (includePatch && record.status !== "pending") {
    throw new WriteRequestError("WRITE_REQUEST_NOT_PENDING", "Write request is no longer pending.");
  }
  return { ...receipt, ...(includePatch && record.patch !== undefined ? { patch: record.patch } : {}) };
}
