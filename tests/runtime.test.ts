import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findLiveBridge,
  readRuntimeRecord,
  writeRuntimeState,
  clearRuntimeState,
} from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const closeFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of closeFns.splice(0).reverse()) await close();
});

describe("findLiveBridge probe resilience", () => {
  it("reports authorization from the live snapshot when expired tokens remain in memory", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("probe-expired-auth");
    write(root, "hello.txt", "hello");
    const bridge = await startBridge({
      workspaceRoot: root,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-probe-expired.json"),
    });
    closeFns.push(() => bridge.close());
    bridge.authStore.issueTokens({
      clientId: "bridge-expired-auth",
      scopes: ["workspace.read"],
      accessTtlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    const info = (await response.json()) as {
      tokenCount: number;
      authorization: { state: string };
    };

    expect(info.tokenCount).toBe(1);
    expect(info.authorization.state).toBe("unauthorized");
  });

  it("tolerates transient probe failures instead of reporting the bridge dead", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("probe-a");
    write(root, "hello.txt", "hello");
    const bridge = await startBridge({
      workspaceRoot: root,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-probe-a.json"),
    });
    closeFns.push(() => bridge.close());
    writeRuntimeState({
      service: "c2c-bridge",
      version: "0.1.0",
      workspaceId: bridge.workspace.id,
      workspaceRoot: bridge.workspace.root,
      pid: process.pid,
      port: bridge.port,
      adminToken: bridge.adminToken,
      publicUrl: null,
      startedAt: new Date().toISOString(),
    });

    const realFetch = globalThis.fetch;
    let failures = 0;
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        // Simulate the observed flake: the first two probes time out.
        if (url.includes(`/health`)) {
          failures++;
          if (failures <= 2) throw new DOMException("aborted", "AbortError");
        }
        return realFetch(input, init);
      }
    );

    const runtime = await findLiveBridge(bridge.workspace.id);
    expect(runtime).not.toBeNull();
    expect(runtime?.port).toBe(bridge.port);
    expect(failures).toBeGreaterThanOrEqual(2);
    clearRuntimeState(bridge.workspace.id);
    cleanup(root);
  });

  it("still reports no bridge after repeated probe failures", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("probe-b");
    write(root, "hello.txt", "hello");
    const bridge = await startBridge({
      workspaceRoot: root,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-probe-b.json"),
    });
    closeFns.push(() => bridge.close());
    writeRuntimeState({
      service: "c2c-bridge",
      version: "0.1.0",
      workspaceId: bridge.workspace.id,
      workspaceRoot: bridge.workspace.root,
      pid: process.pid,
      port: bridge.port,
      adminToken: bridge.adminToken,
      publicUrl: null,
      startedAt: new Date().toISOString(),
    });

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input).includes(`/health`)) throw new DOMException("aborted", "AbortError");
        return realFetch(input, init);
      }
    );

    expect(await findLiveBridge(bridge.workspace.id)).toBeNull();
    clearRuntimeState(bridge.workspace.id);
    cleanup(root);
  });
});

describe("duplicate bridge guard", () => {
  it("refuses to start a second bridge for a workspace that is already served", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("dup-a");
    write(root, "hello.txt", "hello");
    const preferred = 48000 + Math.floor(Math.random() * 500);

    const first = await startBridge({
      workspaceRoot: root,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-dup-a.json"),
    });
    closeFns.push(() => first.close());
    expect(first.port).toBe(preferred);

    // Same workspace, same preferred port: the fallback bind must not silently
    // create a shadow daemon alongside the live one.
    await expect(
      startBridge({
        workspaceRoot: root,
        port: preferred,
        persistRuntime: false,
        authStoreFile: path.join(stateDir, "auth-dup-a.json"),
      })
    ).rejects.toThrow(/already running/);

    // A different workspace on the same port still falls back as before.
    const otherRoot = makeTmpDir("dup-b");
    write(otherRoot, "other.txt", "other");
    const other = await startBridge({
      workspaceRoot: otherRoot,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth-dup-b.json"),
    });
    closeFns.push(() => other.close());
    expect(other.port).not.toBe(preferred);
    cleanup(root);
    cleanup(otherRoot);
  });
});

describe("runtime mutation lock recovery", () => {
  it("does not treat a legacy stale lock marker as a live lock", () => {
    const stateDir = isolateStateDir();
    const workspaceId = "stale-lock-recovery";
    const state = {
      service: "c2c-bridge",
      version: "0.1.0",
      workspaceId,
      workspaceRoot: "/workspace",
      pid: process.pid,
      port: 48001,
      adminToken: "runtime-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };

    writeRuntimeState(state, stateDir);
    fs.writeFileSync(path.join(stateDir, "runtime", `${workspaceId}.lifecycle-lock`), "12345:dead-owner");
    writeRuntimeState({ ...state, port: 48002 }, stateDir);

    const record = readRuntimeRecord(workspaceId, stateDir);
    expect(record.kind).toBe("present");
    if (record.kind === "present") expect(record.runtime.port).toBe(48002);
  });

  it.skipIf(process.platform !== "linux")("resolves flock from fixed system paths instead of caller PATH", () => {
    const stateDir = isolateStateDir();
    const workspaceId = "fixed-flock-path";
    const dir = makeTmpDir("shadow-flock");
    const previousPath = process.env.PATH;
    const fakeFlock = path.join(dir, "flock");
    const state = {
      service: "c2c-bridge",
      version: "0.1.0",
      workspaceId,
      workspaceRoot: "/workspace",
      pid: process.pid,
      port: 48003,
      adminToken: "runtime-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(fakeFlock, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = dir;
    try {
      expect(() => writeRuntimeState(state, stateDir)).not.toThrow();
      expect(readRuntimeRecord(workspaceId, stateDir).kind).toBe("present");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      cleanup(dir);
    }
  });
});
