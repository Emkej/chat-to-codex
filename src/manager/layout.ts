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

export type ManagerFreshness = "loading" | "refreshing" | "fresh" | "stale";

export function formatManagerProfile(profile: string | null): string {
  return profile?.trim() || "default";
}

export function formatStatusAge(observedAt: string, now = Date.now()): string {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return "age unknown";

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 1) return "just now";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

export function getManagerFreshness(
  status: InstallationStatus | null,
  refreshing: boolean,
  now = Date.now()
): ManagerFreshness {
  if (!status) return "loading";
  if (refreshing) return "refreshing";
  return isStatusStale(status, now) ? "stale" : "fresh";
}

export function formatManagerFreshness(
  status: InstallationStatus | null,
  refreshing: boolean,
  now = Date.now()
): string {
  const freshness = getManagerFreshness(status, refreshing, now);
  if (!status) return "loading";
  if (freshness === "refreshing") return `refreshing · ${formatStatusAge(status.observedAt, now)}`;
  if (freshness === "stale") return `stale · ${formatStatusAge(status.observedAt, now)}`;
  return `live · ${formatStatusAge(status.observedAt, now)}`;
}

export function formatManagerOperationalContext(
  status: InstallationStatus | null,
  refreshing: boolean,
  now = Date.now()
): string {
  if (!status) return "Profile: loading · C2C: loading · Refresh: loading";
  const version = status.installation.version.trim() || "unknown";
  return `Profile: ${formatManagerProfile(status.installation.profile)} · C2C: ${version} · Refresh: ${formatManagerFreshness(status, refreshing, now)}`;
}

export function getManagerVersionMismatch(
  status: InstallationStatus | null
): { manager: string; broker: string } | null {
  if (!status) return null;
  const manager = status.installation.version.trim();
  const broker = status.broker.version?.trim() ?? "";
  if (!manager || !broker || manager === broker) return null;
  return { manager, broker };
}

export function formatManagerVersionMismatch(status: InstallationStatus | null): string | null {
  const mismatch = getManagerVersionMismatch(status);
  return mismatch
    ? `Version mismatch: Manager ${mismatch.manager} · Broker ${mismatch.broker}`
    : null;
}
