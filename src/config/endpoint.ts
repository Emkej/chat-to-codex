import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CONNECTOR_SETTINGS_URL = "https://claude.ai/settings/connectors";
export const CREATE_CONNECTOR_URL = CONNECTOR_SETTINGS_URL;

export const CLAUDE_CONNECTORS_URL = CONNECTOR_SETTINGS_URL;
export const CLAUDE_CREATE_CONNECTOR_URL = CREATE_CONNECTOR_URL;

/** @deprecated Use CONNECTOR_SETTINGS_URL. */
export const CHATGPT_DEVELOPER_MODE_URL = CONNECTOR_SETTINGS_URL;
/** @deprecated Use CONNECTOR_SETTINGS_URL. */
export const CHATGPT_PLUGINS_URL = CONNECTOR_SETTINGS_URL;
/** @deprecated Use CREATE_CONNECTOR_URL. */
export const CHATGPT_CREATE_CONNECTOR_URL = CREATE_CONNECTOR_URL;

export const DEFAULT_CONNECTOR_NAME = "Chat to Codex";

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  /** Latest observed MCP endpoint. This is not proof that Claude was updated. */
  mcpUrl: string | null;
  /** Endpoint the user explicitly confirmed in Claude. */
  confirmedMcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export type ConnectorEndpointConfirmation =
  | { ok: true; mcpUrl: string }
  | { ok: false; reason: "endpoint-mismatch"; currentMcpUrl: string | null };

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  const stored = readJsonIfExists<Omit<LastEndpoint, "confirmedMcpUrl"> & { confirmedMcpUrl?: string | null }>(
    endpointFile(workspaceId)
  );
  if (!stored) return null;

  // Legacy files stored the last configured MCP URL in mcpUrl. Treat that
  // value as confirmed on read; new observations always preserve this field.
  const confirmedMcpUrl = stored.confirmedMcpUrl === undefined ? stored.mcpUrl : stored.confirmedMcpUrl;
  return { ...stored, confirmedMcpUrl };
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

/** Confirm only the endpoint that is still the current observation. */
export function confirmStoredConnectorEndpoint(opts: {
  workspaceId: string;
  mcpUrl: string;
}): ConnectorEndpointConfirmation {
  const current = readLastEndpoint(opts.workspaceId);
  if (!current?.mcpUrl || normalizePublicUrl(current.mcpUrl) !== normalizePublicUrl(opts.mcpUrl)) {
    return {
      ok: false,
      reason: "endpoint-mismatch",
      currentMcpUrl: current?.mcpUrl ?? null,
    };
  }

  writeLastEndpoint({ ...current, confirmedMcpUrl: current.mcpUrl });
  return { ok: true, mcpUrl: current.mcpUrl };
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to THIS workspace's Claude connector.
 *  `update` means the public address changed: remove the old connector
 *  in Claude, then add it again. Claude does not currently edit a custom
 *  connector URL in place. */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Same workspace keeps one connector title forever. A workspace already
 * recorded without a title gets the Claude default name; new workspaces get
 * a distinct workspace-qualified title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
}): string {
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.hadEndpointBefore) return DEFAULT_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

export function reclaimUserMessage(connectorName: string): string {
  return `This workspace's connector URL has expired. In Claude, Customize > Connectors, remove "${connectorName}" and re-add it with the new address. Other workspaces are unaffected.`;
}
