import {
  MANAGER_STATUS_STALE_AFTER_MS,
  MANAGER_WIDE_MIN_COLUMNS,
} from "./constants.js";
import type { InstallationStatus } from "../admin/installation-status.js";

export type ManagerLayout = "wide" | "narrow";

export function getManagerLayout(columns: number): ManagerLayout {
  return columns >= MANAGER_WIDE_MIN_COLUMNS ? "wide" : "narrow";
}

export function isStatusStale(status: InstallationStatus, now = Date.now()): boolean {
  const observedAt = Date.parse(status.observedAt);
  if (!Number.isFinite(observedAt)) return true;
  return now - observedAt >= MANAGER_STATUS_STALE_AFTER_MS;
}

export function formatSessionCount(count: number | null): string {
  return count === null ? "unknown" : String(count);
}
