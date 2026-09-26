import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { RuntimeState } from "../src/bridge/runtime.js";
import {
  clearRuntimeRecordIfUnchanged,
  readRuntimeRecord,
  readRuntimeState,
  writeRuntimeState,
} from "../src/bridge/runtime.js";
import { startInstallationBroker, recoverInstallationBroker, restartInstallationBroker } from "../src/admin/installation-lifecycle.js";
import { checkInstallationHealth } from "../src/admin/installation-health.js";
import {
  ensureBrokerRuntime,
  restartBrokerRuntime,
  stopBrokerRuntime,
  type BrokerLifecycleError,
} from "../src/broker/installation-process.js";
import {
  compareLinuxProcessIdentity,
  parseLinuxProcessStat,
  readLinuxProcessIdentity,
} from "../src/broker/process-identity.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { SERVICE_NAME } from "../src/version.js";
import { loadOrCreateInstallation } from "../src/workspaces/installation.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockedSpawn };
});

type ProcessFixture =
  | { kind: "present"; startTimeTicks: string }
  | { kind: "absent" }
  | { kind: "unknown" };

interface AdminFixture {
  installationId: string;
  pid: number;
  reachable: boolean;
  shutdownOk: boolean;
  tunnel: { running: boolean; url: string | null; provider: string };
  authorization: { state: string };
}

let stateDir: string;
let installationId: string;
let admin: AdminFixture;
let healthReachable: boolean;
let endpointReachable: boolean;
let processFixtures: Map<number, ProcessFixture | ProcessFixture[]>;
let events: string[];
let onSpawn: ((pid: number) => void) | undefined;
let onShutdown: (() => void) | undefined;
let onAdminUnavailable: (() => void) | undefined;
let onSpawnError: ((child: EventEmitter) => void) | undefined;
let killBehavior: (() => void) | undefined;
let nextPid: number;
let killSpy: ReturnType<typeof vi.spyOn>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function processStat(pid: number, comm: string, startTimeTicks: string): string {
  const fields = Array.from({ length: 20 }, () => "1");
  fields[0] = "S";
  fields[19] = startTimeTicks;
  return `${pid} (${comm}) ${fields.join(" ")}`;
}

function setProcess(pid: number, startTimeTicks = "100"): void {
  processFixtures.set(pid, { kind: "present", startTimeTicks });
}

function readProcessFixture(pid: number): ProcessFixture {
  const fixture = processFixtures.get(pid);
  if (!Array.isArray(fixture)) return fixture ?? { kind: "absent" };
  if (fixture.length > 1) return fixture.shift()!;
  return fixture[0] ?? { kind: "absent" };
}

function makeRuntime(pid: number, port = 48_765): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0-test",
    workspaceId: installationId,
    workspaceRoot: stateDir,
    pid,
    port,
    adminToken: `test-admin-${pid}`,
    publicUrl: null,
    startedAt: "2026-09-25T00:00:00.000Z",
  };
}

function setRuntime(pid: number, port = 48_765): RuntimeState {
  const runtime = makeRuntime(pid, port);
  writeRuntimeState(runtime, stateDir);
  return runtime;
}

function commitSpawnedBroker(pid: number): void {
  events.push(`commit:${pid}`);
  admin.pid = pid;
  admin.installationId = installationId;
  admin.reachable = true;
  healthReachable = true;
  setProcess(pid, String(pid * 10));
  setRuntime(pid);
}

function takeMockedSpawn(): void {
  mockedSpawn.mockImplementation(() => {
    const pid = nextPid++;
    events.push(`spawn:${pid}`);
    onSpawn?.(pid);
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; unref: () => void };
    child.pid = pid;
    child.exitCode = null;
    child.unref = vi.fn();
    queueMicrotask(() => onSpawnError?.(child));
    return child as never;
  });
}

function lifecycleOptions<T extends { signal?: AbortSignal; shutdownTimeoutMs?: number; startupTimeoutMs?: number }>(
  options: T = {} as T
): T & { signalProcessIdentity: (identity: { pid: number }, signal?: AbortSignal) => Promise<"signaled"> } {
  return {
    ...options,
    signalProcessIdentity: async ({ pid }) => {
      events.push(`signal:${pid}:SIGTERM`);
      killBehavior?.();
      return "signaled";
    },
  };
}

function runtimeFileExists(): boolean {
  return fs.existsSync(`${stateDir}/runtime/${installationId}.json`);
}

beforeEach(() => {
  stateDir = isolateStateDir();
  installationId = loadOrCreateInstallation(stateDir).installationId;
  admin = {
    installationId,
    pid: 0,
    reachable: true,
    shutdownOk: true,
    tunnel: { running: false, url: null, provider: "none" },
    authorization: { state: "unauthorized" },
  };
  healthReachable = true;
  endpointReachable = true;
  processFixtures = new Map();
  events = [];
  onSpawn = undefined;
  onShutdown = undefined;
  onAdminUnavailable = undefined;
  onSpawnError = undefined;
  killBehavior = undefined;
  nextPid = 90_000;
  mockedSpawn.mockReset();
  takeMockedSpawn();

  const originalReadFile = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(file));
    if (match) {
      const pid = Number(match[1]);
      const fixture = readProcessFixture(pid);
      if (fixture.kind === "absent") throw Object.assign(new Error("absent"), { code: "ENOENT" });
      if (fixture.kind === "unknown") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return processStat(pid, "c2c broker ) worker with spaces", fixture.startTimeTicks) as never;
    }
    return originalReadFile(file as never, options as never) as never;
  }) as typeof fs.readFileSync);

  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    events.push(`signal:${pid}:${String(signal)}`);
    killBehavior?.();
    return true;
  }) as typeof process.kill);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.pathname === "/health" && url.hostname === "127.0.0.1") {
        if (!healthReachable) return response({ status: "unavailable" }, 503);
        return response({ service: SERVICE_NAME, workspaceId: installationId, status: "ok" });
      }
      if (url.pathname === "/health") {
        return endpointReachable ? response({ ok: true }) : response({ ok: false }, 503);
      }
      if (url.pathname === "/admin/info") {
        events.push(`info:${admin.pid}`);
        if (!admin.reachable) {
          onAdminUnavailable?.();
          return response({ message: "simulated admin outage" }, 503);
        }
        return response({
          installationId: admin.installationId,
          pid: admin.pid,
          tunnel: admin.tunnel,
          authorization: admin.authorization,
          tokenCount: admin.authorization.state === "authorized" ? 1 : 0,
        });
      }
      if (url.pathname === "/admin/shutdown") {
        events.push("shutdown");
        onShutdown?.();
        if (!admin.reachable || !admin.shutdownOk) return response({ message: "shutdown unavailable" }, 503);
        return response({ shuttingDown: true });
      }
      if (url.pathname === "/admin/workspaces") return response({ workspaces: [] });
      if (url.pathname === "/admin/sessions") return response({ sessions: [] });
      if (url.pathname === "/admin/pairing") return response({ code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 });
      if (url.pathname === "/admin/tunnel/start") {
        return response({ url: "https://new.example" });
      }
      return response({});
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockedSpawn.mockReset();
  cleanup(stateDir);
});

describe("Linux broker process identity", () => {
  it("parses start-time ticks after a parenthesized comm containing spaces and parentheses", () => {
    const stat = processStat(31_415, "a name ) with spaces", "987654321");
    expect(parseLinuxProcessStat(stat, 31_415)).toEqual({ pid: 31_415, startTimeTicks: "987654321" });
    expect(parseLinuxProcessStat(stat, 31_416)).toBeNull();
    expect(parseLinuxProcessStat("malformed", 31_415)).toBeNull();
  });

  it("distinguishes definite absence from unreadable process identity", () => {
    const pid = 31_417;
    processFixtures.set(pid, { kind: "absent" });
    expect(readLinuxProcessIdentity(pid).kind).toBe("absent");
    processFixtures.set(pid, { kind: "unknown" });
    expect(readLinuxProcessIdentity(pid)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("Cannot read") });
    setProcess(pid, "777");
    expect(readLinuxProcessIdentity(pid)).toMatchObject({
      kind: "present",
      identity: { pid, startTimeTicks: "777" },
    });
    expect(compareLinuxProcessIdentity({ pid, startTimeTicks: "777" })).toEqual({ kind: "matching" });
    expect(compareLinuxProcessIdentity({ pid, startTimeTicks: "776" }).kind).toBe("different");
    processFixtures.set(pid, { kind: "absent" });
    expect(compareLinuxProcessIdentity({ pid, startTimeTicks: "777" })).toEqual({ kind: "absent" });
    processFixtures.set(pid, { kind: "unknown" });
    expect(compareLinuxProcessIdentity({ pid, startTimeTicks: "777" }).kind).toBe("unknown");
  });
});

describe("verified installation broker process transitions", () => {
  it("requires matching admin installation and PID before a signal fallback", async () => {
    const pid = 91_001;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.shutdownOk = false;
    killBehavior = () => processFixtures.set(pid, { kind: "absent" });
    onSpawn = commitSpawnedBroker;

    const restarted = await restartBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 500 }));

    expect(restarted.pid).not.toBe(pid);
    expect(events).toContain(`signal:${pid}:SIGTERM`);
    expect(events.indexOf(`signal:${pid}:SIGTERM`)).toBeGreaterThan(events.indexOf("shutdown"));
  });

  it("fails closed on an admin installation mismatch", async () => {
    const pid = 91_002;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.installationId = "c2c_inst_other";

    await expect(restartBrokerRuntime({ shutdownTimeoutMs: 100 })).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "installation-mismatch",
    });
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("fails closed on an admin PID mismatch", async () => {
    const pid = 91_003;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid + 1;

    await expect(restartBrokerRuntime({ shutdownTimeoutMs: 100 })).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "pid-mismatch",
    });
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("clears stale runtime only after the recorded PID is definitely absent", async () => {
    const pid = 91_004;
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;
    onSpawn = (newPid) => {
      expect(readRuntimeState(installationId, stateDir)).toBeNull();
      commitSpawnedBroker(newPid);
    };

    const runtime = await ensureBrokerRuntime({ startupTimeoutMs: 500 });

    expect(runtime.pid).not.toBe(pid);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("preserves a runtime record that changed after the stale snapshot was read", () => {
    const pid = 91_022;
    setRuntime(pid);
    const snapshot = readRuntimeRecord(installationId, stateDir);
    expect(snapshot.kind).toBe("present");
    if (snapshot.kind !== "present") throw new Error("expected runtime snapshot");
    writeRuntimeState({ ...snapshot.runtime, pid: pid + 1 }, stateDir);

    expect(clearRuntimeRecordIfUnchanged(installationId, snapshot, stateDir)).toBe("changed");
    expect(readRuntimeState(installationId, stateDir)?.pid).toBe(pid + 1);
  });

  it("does not signal or spawn when the PID exists but admin ownership is unverified", async () => {
    const pid = 91_005;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;

    await expect(ensureBrokerRuntime({ startupTimeoutMs: 100 })).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "ownership-unverified",
      recoveryRequired: true,
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(runtimeFileExists()).toBe(true);
  });

  it("does not interpret an unreachable health probe alone as process exit", async () => {
    const pid = 91_006;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;
    healthReachable = false;

    await expect(ensureBrokerRuntime({ startupTimeoutMs: 100 })).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "ownership-unverified",
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("waits for actual termination before spawning a graceful restart replacement", async () => {
    const pid = 91_007;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    onShutdown = () => {
      events.push("old-process-exited");
      processFixtures.set(pid, { kind: "absent" });
    };
    onSpawn = (newPid) => {
      expect(processFixtures.get(pid)).toEqual({ kind: "absent" });
      commitSpawnedBroker(newPid);
    };

    const runtime = await restartBrokerRuntime({ shutdownTimeoutMs: 500 });

    expect(runtime.pid).not.toBe(pid);
    expect(events.indexOf("old-process-exited")).toBeLessThan(events.findIndex((event) => event.startsWith("spawn:")));
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
  });

  it("revalidates a concurrent runtime update instead of reporting a restart without stopping the broker", async () => {
    const pid = 91_024;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.shutdownOk = false;
    let firstShutdown = true;
    onShutdown = () => {
      if (!firstShutdown) return;
      firstShutdown = false;
      writeRuntimeState({ ...makeRuntime(pid), publicUrl: "https://changed.example" }, stateDir);
    };
    killBehavior = () => processFixtures.set(pid, { kind: "absent" });
    onSpawn = (newPid) => {
      expect(processFixtures.get(pid)).toEqual({ kind: "absent" });
      commitSpawnedBroker(newPid);
    };

    const runtime = await restartBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 1_000 }));

    expect(runtime.pid).not.toBe(pid);
    expect(events.filter((event) => event === "shutdown")).toHaveLength(2);
    expect(events).toContain(`signal:${pid}:SIGTERM`);
    expect(events.indexOf(`signal:${pid}:SIGTERM`)).toBeLessThan(events.findIndex((event) => event.startsWith("spawn:")));
  });

  it("signals only while the previously verified process start time still matches", async () => {
    const pid = 91_008;
    setProcess(pid, "321");
    setRuntime(pid);
    admin.pid = pid;
    admin.shutdownOk = false;
    killBehavior = () => processFixtures.set(pid, { kind: "absent" });
    onSpawn = commitSpawnedBroker;

    await restartBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 500 }));

    expect(events).toContain(`signal:${pid}:SIGTERM`);
  });

  it("treats PID reuse as original-process exit and reuses a verified replacement without signaling it", async () => {
    const pid = 91_009;
    processFixtures.set(pid, [
      { kind: "present", startTimeTicks: "321" },
      { kind: "present", startTimeTicks: "321" },
      { kind: "present", startTimeTicks: "654" },
    ]);
    setRuntime(pid);
    admin.pid = pid;
    onSpawn = commitSpawnedBroker;
    onShutdown = () => processFixtures.set(pid, { kind: "present", startTimeTicks: "654" });

    const runtime = await restartBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 500 }));

    expect(runtime.pid).toBe(pid);
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(readProcessFixture(pid)).toEqual({ kind: "present", startTimeTicks: "654" });
  });

  it("fails closed when a reused PID exists but its current broker ownership is unverified", async () => {
    const pid = 91_021;
    processFixtures.set(pid, [
      { kind: "present", startTimeTicks: "321" },
      { kind: "present", startTimeTicks: "321" },
    ]);
    setRuntime(pid);
    admin.pid = pid;
    onShutdown = () => {
      processFixtures.set(pid, { kind: "present", startTimeTicks: "654" });
      admin.reachable = false;
    };

    await expect(restartBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 500 }))).rejects.toMatchObject<
      Partial<BrokerLifecycleError>
    >({ code: "ownership-unverified", recoveryRequired: true });
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(runtimeFileExists()).toBe(true);
  });

  it("preserves and reconciles a runtime record changed while stale state is being inspected", async () => {
    const oldPid = 91_010;
    const newPid = 91_011;
    setRuntime(oldPid);
    admin.pid = oldPid;
    admin.reachable = false;
    onAdminUnavailable = () => {
      onAdminUnavailable = undefined;
      setProcess(newPid, "999");
      setRuntime(newPid);
      admin.pid = newPid;
      admin.reachable = true;
    };

    const runtime = await ensureBrokerRuntime({ startupTimeoutMs: 500 });

    expect(runtime.pid).toBe(newPid);
    expect(readRuntimeState(installationId, stateDir)?.pid).toBe(newPid);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("recovers an unknown installation after absent-PID stale cleanup", async () => {
    const oldPid = 91_012;
    setRuntime(oldPid);
    admin.pid = oldPid;
    admin.reachable = false;
    healthReachable = false;
    onSpawn = commitSpawnedBroker;

    const result = await recoverInstallationBroker();

    expect(result.requestedOperation).toBe("recover");
    expect(result.broker.state).toBe("running");
    expect(result.outcome).toBe("partial-success");
    expect(result.userActions).toContainEqual(expect.objectContaining({ kind: "tunnel-setup-required" }));
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("fails recovery for an unverified existing PID without signal or replacement", async () => {
    const pid = 91_013;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;
    healthReachable = false;

    const result = await recoverInstallationBroker();

    expect(result.outcome).toBe("failure");
    expect(result.error).toMatchObject({ code: "ownership-unverified", recoveryRequired: true });
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("reports stop success only after observing the original process identity disappear", async () => {
    const pid = 91_014;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    onShutdown = () => processFixtures.set(pid, { kind: "absent" });

    const result = await stopBrokerRuntime({ shutdownTimeoutMs: 500 });

    expect(result).toEqual({ stopped: true, foundRuntime: true });
    expect(runtimeFileExists()).toBe(false);
  });

  it("returns the structured ownership error and pending connector guidance from Start", async () => {
    const pid = 91_019;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;
    healthReachable = false;
    writeLastEndpoint({
      workspaceId: installationId,
      port: 48_765,
      publicUrl: "https://pending.example",
      mcpUrl: "https://pending.example/mcp",
      confirmedMcpUrl: "https://old.example/mcp",
      connectorName: "Existing connector",
    });

    const result = await startInstallationBroker();

    expect(result.outcome).toBe("failure");
    expect(result.error).toMatchObject({ code: "ownership-unverified", recoveryRequired: true });
    expect(result.currentMcpUrl).toBe("https://pending.example/mcp");
    expect(result.connectorInstruction).toMatchObject({
      kind: "update",
      connectorName: "Existing connector",
      mcpUrl: "https://pending.example/mcp",
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("preserves the observed broker state when recovery is not required", async () => {
    const pid = 91_020;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;

    const result = await recoverInstallationBroker();

    expect(result.outcome).toBe("failure");
    expect(result.error?.code).toBe("recovery-not-required");
    expect(result.broker.state).toBe("running");
  });

  it("returns bounded shutdown failure instead of success while the process remains", async () => {
    const pid = 91_015;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.shutdownOk = false;

    await expect(stopBrokerRuntime(lifecycleOptions({ shutdownTimeoutMs: 500 }))).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "shutdown-timeout",
    });
    expect(events).toContain(`signal:${pid}:SIGTERM`);
    expect(runtimeFileExists()).toBe(true);
  });

  it("returns cancellation and does not signal after the graceful request is committed", async () => {
    const pid = 91_016;
    const controller = new AbortController();
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    onShutdown = () => controller.abort(new Error("cancel requested"));

    await expect(stopBrokerRuntime({ signal: controller.signal, shutdownTimeoutMs: 500 })).rejects.toMatchObject<
      Partial<BrokerLifecycleError>
    >({ code: "cancelled" });
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
    expect(runtimeFileExists()).toBe(true);
  });

  it("leaves a spawned daemon's runtime committed when startup is cancelled", async () => {
    const controller = new AbortController();
    onSpawn = (pid) => {
      commitSpawnedBroker(pid);
      controller.abort(new Error("cancel startup"));
    };

    await expect(ensureBrokerRuntime({ signal: controller.signal, startupTimeoutMs: 500 })).rejects.toMatchObject<
      Partial<BrokerLifecycleError>
    >({ code: "cancelled" });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(readRuntimeState(installationId, stateDir)?.pid).toBeGreaterThan(0);
    expect(events.some((event) => event.startsWith("signal:"))).toBe(false);
  });

  it("converts asynchronous spawn errors into typed startup failures", async () => {
    onSpawnError = (child) => child.emit("error", new Error("executable unavailable"));

    await expect(ensureBrokerRuntime({ startupTimeoutMs: 500 })).rejects.toMatchObject<Partial<BrokerLifecycleError>>({
      code: "start-failed",
      message: expect.stringContaining("executable unavailable"),
    });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("Manager-facing installation lifecycle", () => {
  it("returns broker-running partial success when the tunnel choice is unset", async () => {
    onSpawn = commitSpawnedBroker;

    const result = await startInstallationBroker();

    expect(result.requestedOperation).toBe("start");
    expect(result.outcome).toBe("partial-success");
    expect(result.broker.state).toBe("running");
    expect(result.tunnel.preference).toBe("unset");
    expect(result.userActions).toContainEqual(expect.objectContaining({ kind: "tunnel-setup-required" }));
  });

  it("preserves endpoint update and pairing instructions across restart with existing authorization", async () => {
    const oldPid = 91_017;
    const newPublicUrl = "https://new.example";
    const newMcpUrl = `${newPublicUrl}/mcp`;
    setProcess(oldPid);
    setRuntime(oldPid);
    admin.pid = oldPid;
    admin.authorization = { state: "authorized" };
    admin.tunnel = { running: true, url: newPublicUrl, provider: "cloudflare-quick" };
    writeTunnelState({
      workspaceId: "installation",
      preference: "quick",
      askedAt: "2026-09-25T00:00:00.000Z",
      provider: "cloudflare-quick",
    });
    writeLastEndpoint({
      workspaceId: installationId,
      port: 48_765,
      publicUrl: "https://old.example",
      mcpUrl: "https://old.example/mcp",
      confirmedMcpUrl: "https://old.example/mcp",
      connectorName: "Existing connector",
    });
    onShutdown = () => processFixtures.set(oldPid, { kind: "absent" });
    onSpawn = commitSpawnedBroker;

    const result = await restartInstallationBroker();

    expect(result.outcome).toBe("success");
    expect(result.status.authorization.state).toBe("authorized");
    expect(result.tunnel).toMatchObject({ state: "running", provider: "cloudflare-quick" });
    expect(result.currentMcpUrl).toBe(newMcpUrl);
    expect(result.connectorInstruction).toMatchObject({
      kind: "update",
      connectorName: "Existing connector",
      mcpUrl: newMcpUrl,
      previousMcpUrl: "https://old.example/mcp",
      pairingCode: "ABCD-EFGH",
    });
    expect(result.pairing).toMatchObject({ code: "ABCD-EFGH" });
  });

  it("preserves endpoint update guidance across recovery with existing authorization", async () => {
    const oldPid = 91_023;
    setProcess(oldPid);
    setRuntime(oldPid);
    admin.pid = oldPid;
    admin.authorization = { state: "authorized" };
    admin.tunnel = { running: true, url: "https://recovered.example", provider: "cloudflare-quick" };
    healthReachable = false;
    writeTunnelState({
      workspaceId: "installation",
      preference: "quick",
      askedAt: "2026-09-25T00:00:00.000Z",
      provider: "cloudflare-quick",
    });
    writeLastEndpoint({
      workspaceId: installationId,
      port: 48_765,
      publicUrl: "https://old.example",
      mcpUrl: "https://old.example/mcp",
      confirmedMcpUrl: "https://old.example/mcp",
      connectorName: "Existing connector",
    });
    onShutdown = () => processFixtures.set(oldPid, { kind: "absent" });
    onSpawn = commitSpawnedBroker;

    const result = await recoverInstallationBroker();

    expect(result.requestedOperation).toBe("recover");
    expect(result.outcome).toBe("success");
    expect(result.status.authorization.state).toBe("authorized");
    expect(result.currentMcpUrl).toBe("https://recovered.example/mcp");
    expect(result.connectorInstruction).toMatchObject({
      kind: "update",
      connectorName: "Existing connector",
      mcpUrl: "https://recovered.example/mcp",
      previousMcpUrl: "https://old.example/mcp",
    });
  });

  it("makes health repair use safe broker startup when an existing runtime is ambiguous", async () => {
    const pid = 91_018;
    setProcess(pid);
    setRuntime(pid);
    admin.pid = pid;
    admin.reachable = false;
    healthReachable = false;

    const result = await checkInstallationHealth({ fix: true });

    expect(result.issues).toContainEqual(expect.objectContaining({ code: "broker-unavailable" }));
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });
});
