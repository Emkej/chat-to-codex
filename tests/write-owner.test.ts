import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { startBroker, type Broker } from "../src/broker/server.js";
import { acquireWriteOwner } from "../src/write-requests/owner.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const processSpawningSupported = spawnSync(process.execPath, ["--version"], { encoding: "utf8", timeout: 1_000 }).error?.code !== "EPERM";
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

function directory(name: string): string {
  const result = makeTmpDir(name);
  dirs.push(result);
  return result;
}

describe("exclusive write-owner lease", () => {
  it.each(["win32", "darwin"])("fails closed on %s without creating the state directory", async (platform) => {
    const parent = directory("write-owner-unsupported");
    const stateDir = path.join(parent, "state");
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!descriptor?.configurable) throw new Error("process.platform cannot be stubbed in this runtime.");

    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    try {
      await expect(acquireWriteOwner(stateDir)).rejects.toMatchObject({ code: "WRITE_OWNER_UNAVAILABLE" });
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("allows only one owner for a canonical state directory and releases on close", async () => {
    const stateDir = directory("write-owner");
    const first = await acquireWriteOwner(stateDir);
    await expect(acquireWriteOwner(stateDir)).rejects.toMatchObject({ code: "WRITE_OWNER_ALREADY_HELD" });

    await first.release();
    const next = await acquireWriteOwner(stateDir);
    await next.release();
  });

  it("keeps different state directories independent", async () => {
    const first = await acquireWriteOwner(directory("write-owner-a"));
    const second = await acquireWriteOwner(directory("write-owner-b"));
    await second.release();
    await first.release();
  });

  it.skipIf(!processSpawningSupported)("prevents a separate process from owning the same state directory", async () => {
    const stateDir = directory("write-owner-process");
    const ownerModule = new URL("../src/write-requests/owner.ts", import.meta.url).href;
    const source = `import { acquireWriteOwner } from ${JSON.stringify(ownerModule)}; try { const lease = await acquireWriteOwner(${JSON.stringify(stateDir)}); console.log("acquired"); await lease.release(); } catch (error) { console.log(error.code ?? "unexpected"); process.exitCode = error.code === "WRITE_OWNER_ALREADY_HELD" ? 0 : 1; }`;
    const attempt = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    const owner = await acquireWriteOwner(stateDir);
    const contested = attempt();
    expect(contested.status, contested.stderr).toBe(0);
    expect(contested.stdout.trim()).toBe("WRITE_OWNER_ALREADY_HELD");
    await owner.release();

    const released = attempt();
    expect(released.status, released.stderr).toBe(0);
    expect(released.stdout.trim()).toBe("acquired");
  });

  it("prevents a second broker from writing when the preferred port belongs to another process", async () => {
    const stateDir = directory("write-owner-broker");
    const blockerSockets = new Set<net.Socket>();
    const blocker = net.createServer((socket) => {
      blockerSockets.add(socket);
      socket.once("close", () => blockerSockets.delete(socket));
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port.");

    let first: Broker | undefined;
    let next: Broker | undefined;
    try {
      first = await startBroker({ stateDir, port: address.port, persistRuntime: false });
      expect(first.port).not.toBe(address.port);
      await expect(startBroker({ stateDir, port: address.port, persistRuntime: false }))
        .rejects.toMatchObject({ code: "WRITE_OWNER_ALREADY_HELD" });

      await first.close();
      first = undefined;
      next = await startBroker({ stateDir, port: 0, persistRuntime: false });
      expect(next.port).toBeGreaterThan(0);
    } finally {
      await next?.close();
      await first?.close();
      for (const socket of blockerSockets) socket.destroy();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
