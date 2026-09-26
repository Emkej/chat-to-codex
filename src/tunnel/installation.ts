import { ensureBrokerTunnel } from "../broker/daemon.js";
import { restartBrokerRuntime } from "../broker/installation-process.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { findBinaryAsync } from "./detect.js";
import { parseZoneInput, suggestedNamedHostname } from "./hostname.js";
import { chooseQuickTunnel, hasCloudflaredCert, provisionNamedTunnel } from "./named-provision.js";
import {
  isNamedTunnelReady,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
  type TunnelPreference,
} from "./state.js";

export const INSTALLATION_TUNNEL_ID = "installation";

export interface InstallationTunnelOptions {
  mode?: "quick" | "named";
  zone?: string;
  hostname?: string;
  allowAutoQuick?: boolean;
  signal?: AbortSignal;
}

export interface InstallationTunnelResult {
  ok: boolean;
  needsChoice: boolean;
  url: string | null;
  mcpUrl: string | null;
  preference: TunnelPreference;
  namedReady: boolean;
  hostname: string | null;
  zone: string | null;
  userPrompt?: string;
  message?: string;
  fallback?: boolean;
}

export function installationTunnelPayload(zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(INSTALLATION_TUNNEL_ID);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone
      ? suggestedNamedHostname(zone, "installation", INSTALLATION_TUNNEL_ID)
      : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    fallbackReason: state.fallbackReason,
  };
}

async function requireCloudflared(signal?: AbortSignal): Promise<void> {
  if (!(await findBinaryAsync("cloudflared", { signal }))) {
    throw new Error(
      "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
    );
  }
}

async function restartBrokerTunnel(opts: { signal?: AbortSignal } = {}): Promise<{ runtime: RuntimeState; url: string }> {
  const runtime = await restartBrokerRuntime(opts);
  const url = await ensureBrokerTunnel(runtime, { signal: opts.signal });
  return { runtime, url };
}

export async function resolveInstallationTunnel(
  runtime: RuntimeState,
  opts: InstallationTunnelOptions = {}
): Promise<InstallationTunnelResult> {
  await requireCloudflared(opts.signal);
  let state = readTunnelState(INSTALLATION_TUNNEL_ID);
  const zone = parseZoneInput(opts.zone ?? "") ?? state.zone ?? null;

  const base = (partial: Partial<InstallationTunnelResult>): InstallationTunnelResult => ({
    ok: false,
    needsChoice: false,
    url: null,
    mcpUrl: null,
    preference: state.preference,
    namedReady: isNamedTunnelReady(state),
    hostname: state.hostname ?? null,
    zone,
    ...partial,
  });

  if (opts.mode === "named") {
    if (!zone) {
      return base({
        needsChoice: true,
        message: "Tell me your Cloudflare domain, e.g. example.com",
      });
    }
    // Named profiles need their own Cloudflare tunnel; reusing the default
    // name would route both profiles' hostnames at one installation.
    const profile = process.env.C2C_PROFILE?.trim();
    const result = await provisionNamedTunnel({
      workspaceId: INSTALLATION_TUNNEL_ID,
      workspaceName: profile ? `installation-${profile}` : "installation",
      zone,
      hostname: opts.hostname,
      tunnelName: profile ? `c2c-installation-${profile}` : undefined,
    });
    state = result.state;
    const { url } = await restartBrokerTunnel({ signal: opts.signal });
    return base({
      ok: true,
      url,
      mcpUrl: `${url}/mcp`,
      preference: state.preference,
      namedReady: isNamedTunnelReady(state),
      hostname: state.hostname ?? null,
      zone: state.zone ?? zone,
      fallback: result.fallback,
      message: result.userMessage,
    });
  }

  if (opts.mode === "quick") {
    if (needsTunnelChoice(state)) chooseQuickTunnel(INSTALLATION_TUNNEL_ID);
    const url = await ensureBrokerTunnel(runtime, { signal: opts.signal });
    state = readTunnelState(INSTALLATION_TUNNEL_ID);
    return base({
      ok: true,
      url,
      mcpUrl: `${url}/mcp`,
      preference: state.preference,
      namedReady: false,
    });
  }

  if (isNamedTunnelReady(state)) {
    const url = await ensureBrokerTunnel(runtime, { signal: opts.signal });
    return base({
      ok: true,
      url,
      mcpUrl: `${url}/mcp`,
      preference: state.preference,
      namedReady: true,
      hostname: state.hostname ?? null,
      zone: state.zone ?? null,
    });
  }

  if (state.preference === "quick") {
    const url = await ensureBrokerTunnel(runtime, { signal: opts.signal });
    return base({
      ok: true,
      url,
      mcpUrl: `${url}/mcp`,
      preference: "quick",
      namedReady: false,
    });
  }

  if (needsTunnelChoice(state) && !opts.allowAutoQuick) {
    return base({
      needsChoice: true,
      userPrompt: TUNNEL_CHOICE_PROMPT,
    });
  }

  if (needsTunnelChoice(state)) chooseQuickTunnel(INSTALLATION_TUNNEL_ID);
  const url = await ensureBrokerTunnel(runtime, { signal: opts.signal });
  state = readTunnelState(INSTALLATION_TUNNEL_ID);
  return base({
    ok: true,
    url,
    mcpUrl: `${url}/mcp`,
    preference: state.preference,
    namedReady: isNamedTunnelReady(state),
    hostname: state.hostname ?? null,
    zone: state.zone ?? null,
  });
}
