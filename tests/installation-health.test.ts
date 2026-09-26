import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startBroker } from "../src/broker/server.js";
import { checkInstallationHealth, confirmConnectorEndpoint } from "../src/admin/installation-health.js";
import { readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

function testTunnel(initialUrl: string | null): {
  provider: TunnelProvider;
  setUrl(url: string | null): void;
  starts(): number;
} {
  let url = initialUrl;
  let startCount = 0;
  const provider: TunnelProvider = {
    name: "test-tunnel",
    async start() {
      startCount++;
      url ??= "http://127.0.0.1:1";
      return url;
    },
    async stop() {
      url = null;
    },
    async restart() {
      return provider.start();
    },
    status() {
      return { running: url !== null, url, provider: "test-tunnel" };
    },
    getPublicUrl() {
      return url;
    },
    async doctor() {
      return {
        provider: "test-tunnel",
        binaryFound: true,
        binaryPath: "test-tunnel",
        running: url !== null,
        url,
        problems: [],
      };
    },
  };
  return { provider, setUrl: (next) => (url = next), starts: () => startCount };
}

async function startHealthServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("healthy");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("installation health and connector recovery", () => {
  it("returns structured, repairable issues for an uninitialized installation", async () => {
    const stateDir = isolateStateDir();
    const result = await checkInstallationHealth();

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "installation-uninitialized",
      component: "installation",
      repairable: true,
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "broker-not-running",
      repairable: true,
    }));
    expect(result.repairs).toEqual([]);
    cleanup(stateDir);
  });

  it("honors an already-aborted health check signal before reading state", async () => {
    const stateDir = isolateStateDir();
    const controller = new AbortController();
    controller.abort();

    await expect(checkInstallationHealth({ signal: controller.signal })).rejects.toThrow();
    cleanup(stateDir);
  });

  it("asks for a tunnel choice by default and keeps a running broker visible", async () => {
    const stateDir = isolateStateDir();
    const tunnel = testTunnel(null);
    const broker = await startBroker({ stateDir, port: 0, persistRuntime: true, tunnelProvider: tunnel.provider });
    try {
      const result = await checkInstallationHealth({ fix: true });

      expect(result.status.broker.state).toBe("running");
      expect(result.endpoint.state).toBe("stopped");
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "tunnel-not-running",
        repairable: true,
      }));
      expect(result.userActions).toContainEqual(expect.objectContaining({
        kind: "tunnel-setup-required",
        preference: "unset",
        options: ["quick", "named"],
      }));
      expect(tunnel.starts()).toBe(0);
      expect(readTunnelState("installation").preference).toBe("unset");
    } finally {
      await broker.close();
      cleanup(stateDir);
    }
  });

  it("keeps the newest connector update pending with valid auth through pairing and stale confirmation", async () => {
    const stateDir = isolateStateDir();
    const endpoint = await startHealthServer();
    const tunnel = testTunnel(endpoint.url);
    const broker = await startBroker({ stateDir, port: 0, persistRuntime: true, tunnelProvider: tunnel.provider });
    const installationId = broker.installation.installationId;
    const oldMcpUrl = "https://old.example/mcp";
    const firstMcpUrl = `${endpoint.url}/mcp`;
    let latestEndpoint: Awaited<ReturnType<typeof startHealthServer>> | undefined;
    try {
      writeLastEndpoint({
        workspaceId: installationId,
        port: broker.port,
        publicUrl: "https://old.example",
        mcpUrl: oldMcpUrl,
        confirmedMcpUrl: oldMcpUrl,
        connectorName: "Existing connector",
      });
      broker.authStore.issueTokens({ clientId: "health-test", scopes: ["workspace.read"] });

      const observed = await checkInstallationHealth();
      expect(observed.authorization.state).toBe("authorized");
      expect(observed.endpoint.state).toBe("healthy");
      expect(observed.connectorInstruction).toMatchObject({
        kind: "update",
        mcpUrl: firstMcpUrl,
        settingsUrl: "https://claude.ai/settings/connectors",
      });
      expect(readLastEndpoint(installationId)).toMatchObject({
        mcpUrl: firstMcpUrl,
        confirmedMcpUrl: oldMcpUrl,
      });

      const paired = await checkInstallationHealth({ fix: true });
      expect(paired.connectorInstruction).toMatchObject({ kind: "update", mcpUrl: firstMcpUrl });
      expect(paired.connectorInstruction.kind === "none" ? undefined : paired.connectorInstruction.pairingCode)
        .toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(paired.repairs.some((repair) => repair.kind === "pairing-code-generated")).toBe(true);
      expect(readLastEndpoint(installationId)?.confirmedMcpUrl).toBe(oldMcpUrl);

      const refreshed = await checkInstallationHealth({ fix: true });
      expect(refreshed.connectorInstruction).toMatchObject({ kind: "update", mcpUrl: firstMcpUrl });
      expect(refreshed.connectorInstruction.kind === "none" ? undefined : refreshed.connectorInstruction.pairingCode)
        .not.toBe(paired.connectorInstruction.kind === "none" ? undefined : paired.connectorInstruction.pairingCode);
      expect(readLastEndpoint(installationId)?.confirmedMcpUrl).toBe(oldMcpUrl);

      latestEndpoint = await startHealthServer();
      const latestMcpUrl = `${latestEndpoint.url}/mcp`;
      tunnel.setUrl(latestEndpoint.url);
      const changedAgain = await checkInstallationHealth();
      expect(changedAgain.connectorInstruction).toMatchObject({ kind: "update", mcpUrl: latestMcpUrl });
      expect(readLastEndpoint(installationId)).toMatchObject({
        mcpUrl: latestMcpUrl,
        confirmedMcpUrl: oldMcpUrl,
      });

      expect(confirmConnectorEndpoint({ mcpUrl: firstMcpUrl })).toEqual({
        ok: false,
        reason: "endpoint-mismatch",
        currentMcpUrl: latestMcpUrl,
      });
      expect(readLastEndpoint(installationId)?.confirmedMcpUrl).toBe(oldMcpUrl);

      expect(confirmConnectorEndpoint({ mcpUrl: latestMcpUrl })).toEqual({ ok: true, mcpUrl: latestMcpUrl });
      const confirmed = await checkInstallationHealth();
      expect(confirmed.connectorInstruction).toEqual({ kind: "none" });
      expect(readLastEndpoint(installationId)?.confirmedMcpUrl).toBe(latestMcpUrl);
    } finally {
      await broker.close();
      await latestEndpoint?.close();
      await endpoint.close();
      cleanup(stateDir);
    }
  });
});
