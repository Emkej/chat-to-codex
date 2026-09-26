import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { getInstallationStatus, type InstallationStatus } from "../src/admin/installation-status.js";
import { loadOrCreateInstallation } from "../src/workspaces/installation.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { isolateStateDir, makeTmpDir, write } from "./helpers.js";

const mockedAdmin = vi.hoisted(() => ({ failedRoute: null as string | null }));

vi.mock("../src/process/daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process/daemon.js")>();
  return {
    ...actual,
    adminFetch: async <T = unknown>(
      runtime: RuntimeState,
      method: "GET" | "POST",
      route: string,
      timeoutMs?: number,
      body?: unknown
    ): Promise<T> => {
      if (mockedAdmin.failedRoute === route) throw new Error(`Simulated unavailable route: ${route}`);
      return actual.adminFetch<T>(runtime, method, route, timeoutMs, body);
    },
  };
});

function snapshotTree(root: string): string {
  const entries: string[] = [];
  const visit = (dir: string, relative = ""): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`dir:${childRelative}`);
        visit(childPath, childRelative);
      } else {
        entries.push(`file:${childRelative}:${fs.readFileSync(childPath).toString("base64")}`);
      }
    }
  };
  visit(root);
  return entries.join("\n");
}

function seedInstallation(stateDir: string) {
  return loadOrCreateInstallation(stateDir);
}

function seedWorkspace(stateDir: string): { id: string; root: string } {
  const root = makeTmpDir("installation-status-workspace");
  const registered = WorkspaceRegistry.load(stateDir).register({ root, displayName: "Status project" });
  return { id: registered.id, root };
}

function seedAuthorization(stateDir: string, installationId: string): void {
  const store = new AuthStore(installationId, {
    file: path.join(stateDir, "auth", `${installationId}.json`),
  });
  store.issueTokens({ clientId: "status-test", scopes: ["workspace.read", "offline_access"] });
}

function seedTunnelPreference(): void {
  writeTunnelState({
    workspaceId: "installation",
    preference: "named",
    askedAt: "2026-09-25T00:00:00.000Z",
  });
}

function fakeRunningTunnel(): TunnelProvider {
  return {
    name: "cloudflare-quick",
    start: async () => "https://status-test.trycloudflare.com",
    stop: async () => undefined,
    restart: async () => "https://status-test.trycloudflare.com",
    status: () => ({
      running: true,
      url: "https://status-test.trycloudflare.com/",
      provider: "cloudflare-quick",
    }),
    getPublicUrl: () => "https://status-test.trycloudflare.com",
    doctor: async () => ({
      provider: "cloudflare-quick",
      binaryFound: true,
      binaryPath: "/usr/bin/cloudflared",
      running: true,
      url: "https://status-test.trycloudflare.com",
      problems: [],
    }),
  };
}

async function startLiveFixture(): Promise<{
  stateDir: string;
  broker: Broker;
  workspace: { id: string; displayName: string };
}> {
  const stateDir = isolateStateDir();
  const workspaceRoot = makeTmpDir("installation-status-live-workspace");
  const broker = await startBroker({
    stateDir,
    port: 0,
    persistRuntime: true,
    tunnelProvider: fakeRunningTunnel(),
  });
  try {
    const workspace = broker.registry.register({ root: workspaceRoot, displayName: "Live project" });
    broker.sessions.create(workspace.id);
    broker.authStore.issueTokens({ clientId: "status-live-test", scopes: ["workspace.read"] });
    seedTunnelPreference();
    return { stateDir, broker, workspace };
  } catch (error) {
    await broker.close();
    throw error;
  }
}

describe("installation status", () => {
  it("reports an uninitialized installation without creating state", async () => {
    const stateDir = isolateStateDir();
    const before = snapshotTree(stateDir);

    const status = await getInstallationStatus();

    expect(status).toMatchObject({
      installation: { state: "uninitialized", id: null, version: VERSION },
      broker: { state: "stopped" },
      authorization: { state: "unauthorized" },
      tunnel: { state: "stopped", provider: null, preference: "unset" },
      workspaces: [],
    });
    expect(snapshotTree(stateDir)).toBe(before);
  });

  it("uses offline canonical readers when no runtime exists", async () => {
    const stateDir = isolateStateDir();
    const installation = seedInstallation(stateDir);
    const workspace = seedWorkspace(stateDir);
    seedAuthorization(stateDir, installation.installationId);
    seedTunnelPreference();
    const before = snapshotTree(stateDir);

    const status = await getInstallationStatus();

    expect(status).toMatchObject({
      installation: { state: "ready", id: installation.installationId },
      broker: { state: "stopped" },
      authorization: { state: "authorized" },
      tunnel: { state: "stopped", provider: null, preference: "named" },
      workspaces: [{ id: workspace.id, name: "Status project", liveSessionCount: null }],
    });
    expect(snapshotTree(stateDir)).toBe(before);
  });

  it("preserves unknown broker state when runtime metadata cannot be verified", async () => {
    const stateDir = isolateStateDir();
    const installation = seedInstallation(stateDir);
    const workspace = seedWorkspace(stateDir);
    seedAuthorization(stateDir, installation.installationId);
    seedTunnelPreference();
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: installation.installationId,
      workspaceRoot: stateDir,
      pid: process.pid,
      port: 1,
      adminToken: "c2c_admin_test",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    write(stateDir, path.join("runtime", `${installation.installationId}.json`), JSON.stringify(runtime));
    const before = snapshotTree(stateDir);

    const status = await getInstallationStatus();

    expect(status).toMatchObject({
      broker: { state: "unknown", port: 1 },
      authorization: { state: "authorized" },
      tunnel: { state: "unknown", provider: null, preference: "named" },
      workspaces: [{ id: workspace.id, name: "Status project", liveSessionCount: null }],
    });
    expect(snapshotTree(stateDir)).toBe(before);
  });

  it("uses verified broker admin reads for live workspace sessions and tunnel state", async () => {
    const fixture = await startLiveFixture();
    try {
      const before = snapshotTree(fixture.stateDir);

      const status: InstallationStatus = await getInstallationStatus();

      expect(status.installation).toMatchObject({ state: "ready", id: fixture.broker.installation.installationId });
      expect(status.broker).toMatchObject({ state: "running", port: fixture.broker.port });
      expect(status.authorization.state).toBe("authorized");
      expect(status.tunnel).toMatchObject({
        state: "running",
        provider: "cloudflare-quick",
        preference: "named",
        endpoint: "https://status-test.trycloudflare.com/mcp",
      });
      expect(status.workspaces).toEqual([{ id: fixture.workspace.id, name: "Live project", liveSessionCount: 1 }]);
      expect(snapshotTree(fixture.stateDir)).toBe(before);
    } finally {
      await fixture.broker.close();
      mockedAdmin.failedRoute = null;
    }
  });

  it("keeps the overview available when the live session read fails", async () => {
    const fixture = await startLiveFixture();
    try {
      mockedAdmin.failedRoute = "/admin/sessions";
      const before = snapshotTree(fixture.stateDir);

      const status = await getInstallationStatus();

      expect(status.broker).toMatchObject({ state: "running", port: fixture.broker.port });
      expect(status.authorization.state).toBe("authorized");
      expect(status.tunnel).toMatchObject({
        state: "running",
        provider: "cloudflare-quick",
        preference: "named",
      });
      expect(status.workspaces).toEqual([{ id: fixture.workspace.id, name: "Live project", liveSessionCount: null }]);
      expect(snapshotTree(fixture.stateDir)).toBe(before);
    } finally {
      mockedAdmin.failedRoute = null;
      await fixture.broker.close();
    }
  });
});
