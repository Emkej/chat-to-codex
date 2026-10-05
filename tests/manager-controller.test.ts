import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectorInstruction,
  InstallationHealthResult,
  InstallationHealthIssue,
} from "../src/admin/installation-health.js";
import type {
  InstallationLifecycleOperation,
  InstallationLifecycleResult,
} from "../src/admin/installation-lifecycle.js";
import type { InstallationStatus } from "../src/admin/installation-status.js";
import { getAvailableManagerActions } from "../src/manager/action-policy.js";
import { ManagerController } from "../src/manager/controller.js";
import { MANAGER_STATUS_STALE_AFTER_MS, MANAGER_WIDE_MIN_COLUMNS } from "../src/manager/constants.js";
import { formatSessionCount, getManagerLayout, isStatusStale } from "../src/manager/layout.js";
import type { ManagerServices } from "../src/manager/services.js";

const currentUrl = "https://c2c.example/mcp";
const pendingInstruction: ConnectorInstruction = {
  kind: "update",
  connectorName: "C2C",
  mcpUrl: currentUrl,
  settingsUrl: "https://claude.ai/settings/connectors",
  previousMcpUrl: "https://old.example/mcp",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

function makeStatus(options: {
  broker?: InstallationStatus["broker"]["state"];
  authorization?: InstallationStatus["authorization"]["state"];
  tunnel?: InstallationStatus["tunnel"]["state"];
  workspaces?: InstallationStatus["workspaces"];
  installationId?: string | null;
} = {}): InstallationStatus {
  const installationId = options.installationId === undefined ? "c2c_inst_test" : options.installationId;
  return {
    installation: {
      state: installationId ? "ready" : "uninitialized",
      id: installationId,
      version: "0.2.0",
      profile: null,
    },
    broker: { state: options.broker ?? "running", ...(options.broker === "running" ? { port: 4123 } : {}) },
    authorization: { state: options.authorization ?? "unauthorized" },
    tunnel: {
      state: options.tunnel ?? "running",
      provider: options.tunnel === "stopped" ? null : "cloudflare-quick",
      preference: "quick",
      ...(options.tunnel === "running" ? { endpoint: currentUrl } : {}),
    },
    workspaces: options.workspaces ?? [
      { id: "workspace-a", name: "Alpha", liveSessionCount: 2 },
      { id: "workspace-b", name: "Beta", liveSessionCount: null },
    ],
    observedAt: new Date().toISOString(),
  };
}

function makeHealth(options: {
  status?: InstallationStatus;
  endpoint?: InstallationHealthResult["endpoint"]["state"];
  authorization?: InstallationHealthResult["authorization"]["state"];
  instruction?: ConnectorInstruction;
  issues?: InstallationHealthIssue[];
} = {}): InstallationHealthResult {
  const status = options.status ?? makeStatus();
  return {
    ok: (options.issues ?? []).length === 0,
    status,
    endpoint: {
      state: options.endpoint ?? "healthy",
      mcpUrl: options.endpoint === "stopped" ? null : currentUrl,
    },
    authorization: {
      state: options.authorization ?? "unauthorized",
      source: "broker",
    },
    issues: options.issues ?? [],
    repairs: [],
    connectorInstruction: options.instruction ?? { kind: "none" },
    userActions: [],
  };
}

function makeLifecycle(
  operation: InstallationLifecycleOperation,
  status: InstallationStatus = makeStatus()
): InstallationLifecycleResult {
  return {
    requestedOperation: operation,
    outcome: "success",
    status,
    broker: status.broker,
    tunnel: status.tunnel,
    currentMcpUrl: currentUrl,
    connectorInstruction: { kind: "none" },
    userActions: [],
    issues: [],
  };
}

function makeServices(overrides: Partial<ManagerServices> = {}): ManagerServices {
  const defaults: ManagerServices = {
    writeRequests: { list: vi.fn(), detail: vi.fn(), receipt: vi.fn(), approve: vi.fn() },
    readWorkspaceDetail: vi.fn(async () => []),
    readStatus: vi.fn(async () => makeStatus()),
    checkHealth: vi.fn(async () => makeHealth()),
    startBroker: vi.fn(async () => makeLifecycle("start", makeStatus({ broker: "running" }))),
    restartBroker: vi.fn(async () => makeLifecycle("restart", makeStatus({ broker: "running" }))),
    recoverBroker: vi.fn(async () => makeLifecycle("recover", makeStatus({ broker: "running" }))),
    stopBroker: vi.fn(async () => makeLifecycle("stop", makeStatus({ broker: "stopped" }))),
    createPairing: vi.fn(async () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 })),
    confirmEndpoint: vi.fn(({ mcpUrl }) => ({ ok: true as const, mcpUrl })),
    readInstruction: vi.fn(() => ({ kind: "none" })),
  };
  return { ...defaults, ...overrides };
}

const controllers: ManagerController[] = [];

function makeController(services: ManagerServices = makeServices()): ManagerController {
  const controller = new ManagerController(services);
  controllers.push(controller);
  return controller;
}

async function loadedController(services: ManagerServices = makeServices()): Promise<ManagerController> {
  const controller = makeController(services);
  await controller.refresh();
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close();
  vi.useRealTimers();
});

describe("Manager workspace detail lifecycle", () => {
  it("keeps discovery lazy and reads only the selected workspace", async () => {
    const services = makeServices({ readWorkspaceDetail: vi.fn(async () => [{ worktreeId: "wt-test", branch: null, commit: "abc123" }]) });
    const controller = await loadedController(services);
    controller.selectWorkspace("workspace-b");
    await controller.refresh();
    expect(services.readWorkspaceDetail).not.toHaveBeenCalled();
    await controller.openWorkspaceDetail();
    expect(services.readWorkspaceDetail).toHaveBeenCalledWith("workspace-b", { signal: expect.any(AbortSignal) });
    expect(controller.getSnapshot().workspaceDetail).toEqual({ workspaceId: "workspace-b", state: "ready", worktrees: [{ worktreeId: "wt-test", branch: null, commit: "abc123" }] });
    controller.closeWorkspaceDetail();
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("workspace-b");
    for (const action of [services.startBroker, services.restartBroker, services.recoverBroker, services.stopBroker, services.checkHealth, services.createPairing, services.confirmEndpoint]) expect(action).not.toHaveBeenCalled();
  });

  it("does not discover with no selection or during confirmation", async () => {
    const emptyServices = makeServices({ readStatus: vi.fn(async () => makeStatus({ workspaces: [] })) });
    const empty = await loadedController(emptyServices);
    expect(await empty.openWorkspaceDetail()).toBe(false);
    expect(emptyServices.readWorkspaceDetail).not.toHaveBeenCalled();
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("stop");
    expect(await controller.openWorkspaceDetail()).toBe(false);
    expect(services.readWorkspaceDetail).not.toHaveBeenCalled();
  });

  it("keeps the foreground guard through cancellation cleanup and ignores late results", async () => {
    const pending = deferred<[]>();
    let signal!: AbortSignal;
    const services = makeServices({ readWorkspaceDetail: vi.fn(async (_id, options) => { signal = options.signal; return pending.promise; }) });
    const controller = await loadedController(services);
    const opening = controller.openWorkspaceDetail();
    expect(controller.getSnapshot().workspaceDetail?.state).toBe("loading");
    controller.closeWorkspaceDetail();
    expect(signal.aborted).toBe(true);
    expect(controller.getSnapshot().activeAction).toBe("detail");
    expect(await controller.openWorkspaceDetail()).toBe(false);
    expect(await controller.perform("restart")).toBe(false);
    controller.selectWorkspace("workspace-b");
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("workspace-b");
    pending.resolve([]);
    await opening;
    expect(controller.getSnapshot().workspaceDetail).toBeNull();
    expect(controller.getSnapshot().activeAction).toBeNull();
    await controller.openWorkspaceDetail();
    expect(controller.getSnapshot().workspaceDetail?.workspaceId).toBe("workspace-b");
  });

  it("cancels when selection changes and when the Manager closes", async () => {
    const pending = deferred<[]>();
    let signal!: AbortSignal;
    const services = makeServices({ readWorkspaceDetail: vi.fn(async (_id, options) => { signal = options.signal; return pending.promise; }) });
    const controller = await loadedController(services);
    const opening = controller.openWorkspaceDetail();
    controller.selectWorkspace("workspace-b");
    expect(signal.aborted).toBe(true);
    expect(controller.getSnapshot().workspaceDetail).toBeNull();
    pending.resolve([]);
    await opening;
    const closing = controller.openWorkspaceDetail();
    controller.close();
    expect(signal.aborted).toBe(true);
    await closing;
    expect(controller.getSnapshot().closed).toBe(true);
  });

  it("drops a removed workspace after a read and redacts failures", async () => {
    const services = makeServices({
      readStatus: vi.fn().mockResolvedValueOnce(makeStatus()).mockResolvedValue(makeStatus({ workspaces: [{ id: "workspace-b", name: "Beta", liveSessionCount: null }] })),
      readWorkspaceDetail: vi.fn(async () => []),
    });
    const controller = await loadedController(services);
    await controller.openWorkspaceDetail();
    expect(controller.getSnapshot().workspaceDetail).toBeNull();
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("workspace-b");
    vi.mocked(services.readWorkspaceDetail).mockRejectedValue(new Error("/private/repository cannot be read"));
    await controller.openWorkspaceDetail();
    expect(controller.getSnapshot().workspaceDetail?.state).toBe("unavailable");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("/private/repository");
  });

  it("refreshes the displayed detail without starting a detail polling lane", async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.openWorkspaceDetail();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(services.readWorkspaceDetail).toHaveBeenCalledTimes(1);
    await controller.perform("refresh");
    expect(services.readWorkspaceDetail).toHaveBeenCalledTimes(2);
  });
});

describe("Manager action policy and controller", () => {
  it.each([
    ["stopped", "start"],
    ["running", "restart"],
    ["unknown", "recover"],
  ] as const)("maps broker state %s to %s", async (broker, action) => {
    const controller = await loadedController(makeServices({ readStatus: vi.fn(async () => makeStatus({ broker })) }));
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === action)).toBe(true);
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "start" || option.id === "restart" || option.id === "recover")).toBe(true);
  });

  it("keeps session counts unknown when the canonical read model reports null", async () => {
    const controller = await loadedController();
    expect(controller.getSnapshot().status?.workspaces[1]?.liveSessionCount).toBeNull();
    expect(formatSessionCount(null)).toBe("unknown");
  });

  it("preserves a selected workspace across refresh when it remains registered", async () => {
    const controller = await loadedController();
    controller.selectWorkspace("workspace-b");
    await controller.refresh();
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("workspace-b");
  });

  it("selects the first remaining workspace when the prior selection disappears", async () => {
    const services = makeServices({
      readStatus: vi.fn()
        .mockResolvedValueOnce(makeStatus())
        .mockResolvedValueOnce(makeStatus({ workspaces: [{ id: "workspace-a", name: "Alpha", liveSessionCount: 1 }] })),
    });
    const controller = await loadedController(services);
    controller.selectWorkspace("workspace-b");
    await controller.refresh();
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("workspace-a");
  });

  it("requires explicit confirmation before stopping the broker", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("stop");
    expect(controller.getSnapshot().confirmation).toBe("stop");
    expect(services.stopBroker).not.toHaveBeenCalled();
  });

  it("cancels a stop confirmation without calling the broker service", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("stop");
    controller.cancelConfirmation();
    expect(controller.getSnapshot().confirmation).toBeNull();
    expect(services.stopBroker).not.toHaveBeenCalled();
  });

  it("runs stop only after the confirmation is accepted", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("stop");
    await controller.confirmPendingAction();
    expect(services.stopBroker).toHaveBeenCalledOnce();
  });

  it("routes Start to the canonical lifecycle service", async () => {
    const services = makeServices({ readStatus: vi.fn(async () => makeStatus({ broker: "stopped" })) });
    const controller = await loadedController(services);
    await controller.perform("start");
    expect(services.startBroker).toHaveBeenCalledOnce();
  });

  it("routes Restart to the canonical lifecycle service", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("restart");
    expect(services.restartBroker).toHaveBeenCalledOnce();
  });

  it("routes Recover to the canonical lifecycle service only for unknown state", async () => {
    const services = makeServices({ readStatus: vi.fn(async () => makeStatus({ broker: "unknown" })) });
    const controller = await loadedController(services);
    await controller.perform("recover");
    expect(services.recoverBroker).toHaveBeenCalledOnce();
  });

  it("runs Check without repair or a default tunnel choice", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(services.checkHealth).toHaveBeenCalledWith(
      expect.objectContaining({ fix: false, allowTunnelChoiceDefault: false, signal: expect.any(AbortSignal) })
    );
  });

  it("offers Fix only when structured health contains a repairable issue", async () => {
    const repairable = { code: "tunnel-not-running", component: "tunnel", message: "Tunnel stopped", repairable: true } as const;
    const services = makeServices({
      checkHealth: vi.fn(async () => makeHealth({ issues: [repairable] })),
    });
    const controller = await loadedController(services);
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "fix")).toBe(false);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "fix")).toBe(true);
  });

  it("runs Fix with repair enabled and tunnel choice default disabled", async () => {
    const issue = { code: "tunnel-not-running", component: "tunnel", message: "Tunnel stopped", repairable: true } as const;
    const services = makeServices({ checkHealth: vi.fn(async ({ fix }) => makeHealth({ issues: fix ? [] : [issue] })) });
    const controller = await loadedController(services);
    await controller.perform("check");
    await controller.perform("fix");
    expect(services.checkHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ fix: true, allowTunnelChoiceDefault: false })
    );
  });

  it("hides Pair until an explicit health check confirms the endpoint is ready", async () => {
    const controller = await loadedController();
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(false);
  });

  it("hides Pair when the endpoint is unavailable", async () => {
    const services = makeServices({ checkHealth: vi.fn(async () => makeHealth({ endpoint: "stopped" })) });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(false);
  });

  it("offers initial Pair for unauthorized state after endpoint health is confirmed", async () => {
    const services = makeServices({
      checkHealth: vi.fn(async () => makeHealth({ authorization: "unauthorized" })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(true);
  });

  it("keeps Pair available for an authorized installation with a pending connector update", async () => {
    const services = makeServices({
      readInstruction: vi.fn(() => pendingInstruction),
      checkHealth: vi.fn(async () => makeHealth({
        status: makeStatus({ authorization: "authorized" }),
        authorization: "authorized",
        instruction: pendingInstruction,
      })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(true);
  });

  it.each([
    ["stopped", "running"],
    ["running", "stopped"],
  ] as const)("hides Pair when the latest status reports broker %s and tunnel %s", async (broker, tunnel) => {
    const services = makeServices({
      readStatus: vi.fn()
        .mockResolvedValueOnce(makeStatus())
        .mockResolvedValue(makeStatus({ broker, tunnel })),
      checkHealth: vi.fn(async () => makeHealth()),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(controller.getSnapshot().status?.broker.state).toBe(broker);
    expect(controller.getSnapshot().status?.tunnel.state).toBe(tunnel);
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(false);
  });

  it("hides initial Pair when the latest authorization is no longer unauthorized", async () => {
    const services = makeServices({
      readStatus: vi.fn()
        .mockResolvedValueOnce(makeStatus())
        .mockResolvedValue(makeStatus({ authorization: "authorized" })),
      checkHealth: vi.fn(async () => makeHealth({ authorization: "unauthorized" })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(controller.getSnapshot().status?.authorization.state).toBe("authorized");
    expect(controller.getSnapshot().health?.authorization.state).toBe("unauthorized");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "pair")).toBe(false);
  });

  it("renews the pairing code without clearing the pending connector instruction", async () => {
    const services = makeServices({
      readInstruction: vi.fn(() => pendingInstruction),
      checkHealth: vi.fn(async () => makeHealth({ instruction: pendingInstruction })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    await controller.perform("pair");
    expect(services.createPairing).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().pairing?.code).toBe("ABCD-EFGH");
    expect(controller.getSnapshot().connectorInstruction).toEqual(pendingInstruction);
  });

  it("does not offer Confirm unless the displayed URL matches the current healthy target", async () => {
    const changedHealth = makeHealth({
      instruction: pendingInstruction,
    });
    changedHealth.endpoint.mcpUrl = "https://different.example/mcp";
    const services = makeServices({
      readInstruction: vi.fn(() => pendingInstruction),
      checkHealth: vi.fn(async () => changedHealth),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).some((option) => option.id === "confirm")).toBe(false);
  });

  it("confirms only the displayed current connector URL and clears the instruction", async () => {
    let instruction: ConnectorInstruction = pendingInstruction;
    const services = makeServices({
      readInstruction: vi.fn(() => instruction),
      checkHealth: vi.fn(async () => makeHealth({ instruction: pendingInstruction })),
      confirmEndpoint: vi.fn(({ mcpUrl }) => {
        instruction = { kind: "none" };
        return { ok: true as const, mcpUrl };
      }),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    await controller.perform("confirm");
    expect(controller.getSnapshot().confirmation).toBe("confirm");
    expect(services.confirmEndpoint).not.toHaveBeenCalled();
    await controller.confirmPendingAction();
    expect(services.confirmEndpoint).toHaveBeenCalledWith({ mcpUrl: currentUrl });
    expect(controller.getSnapshot().connectorInstruction).toEqual({ kind: "none" });
  });

  it("rejects a stale confirmation target and shows the newly observed instruction", async () => {
    const nextInstruction: ConnectorInstruction = { ...pendingInstruction, mcpUrl: "https://next.example/mcp" };
    let instructionRead = 0;
    const services = makeServices({
      readInstruction: vi.fn(() => {
        instructionRead += 1;
        return instructionRead <= 2 ? pendingInstruction : nextInstruction;
      }),
      checkHealth: vi.fn(async () => makeHealth({ instruction: pendingInstruction })),
      confirmEndpoint: vi.fn(() => ({
        ok: false as const,
        reason: "endpoint-mismatch" as const,
        currentMcpUrl: nextInstruction.mcpUrl,
      })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    await controller.perform("confirm");
    expect(services.confirmEndpoint).not.toHaveBeenCalled();
    await controller.confirmPendingAction();
    expect(services.confirmEndpoint).toHaveBeenCalledWith({ mcpUrl: currentUrl });
    expect(controller.getSnapshot().connectorInstruction.mcpUrl).toBe(nextInstruction.mcpUrl);
    expect(controller.getSnapshot().notice).toContain(nextInstruction.mcpUrl);
  });

  it("cancels connector confirmation without calling the confirmation service", async () => {
    const services = makeServices({
      readInstruction: vi.fn(() => pendingInstruction),
      checkHealth: vi.fn(async () => makeHealth({ instruction: pendingInstruction })),
    });
    const controller = await loadedController(services);
    await controller.perform("check");
    await controller.perform("confirm");
    controller.cancelConfirmation();
    expect(controller.getSnapshot().confirmation).toBeNull();
    expect(services.confirmEndpoint).not.toHaveBeenCalled();
  });

  it("blocks a second foreground action while the first is running", async () => {
    let resolveHealth!: (result: InstallationHealthResult) => void;
    const services = makeServices({
      checkHealth: vi.fn(() => new Promise<InstallationHealthResult>((resolve) => { resolveHealth = resolve; })),
    });
    const controller = await loadedController(services);
    const first = controller.perform("check");
    expect(controller.getSnapshot().activeAction).toBe("check");
    expect(await controller.perform("check")).toBe(false);
    expect(services.checkHealth).toHaveBeenCalledOnce();
    resolveHealth(makeHealth());
    await first;
  });

  it("starts a foreground action immediately while an obsolete status read retires", async () => {
    const obsoleteRead = deferred<InstallationStatus>();
    let readCount = 0;
    let obsoleteSignal: AbortSignal | undefined;
    const services = makeServices({
      readStatus: vi.fn(({ signal }) => {
        readCount += 1;
        if (readCount === 2) {
          obsoleteSignal = signal;
          return obsoleteRead.promise;
        }
        return Promise.resolve(makeStatus());
      }),
    });
    const controller = await loadedController(services);
    const obsoleteRefresh = controller.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(readCount).toBe(2);

    const restart = controller.perform("restart");
    expect(obsoleteSignal?.aborted).toBe(true);
    expect(services.restartBroker).toHaveBeenCalledOnce();
    obsoleteRead.resolve(makeStatus({ broker: "stopped" }));
    await Promise.all([obsoleteRefresh, restart]);
    expect(readCount).toBe(3);
    expect(controller.getSnapshot().status?.broker.state).toBe("running");
  });

  it("keeps the foreground guard held until its completion refresh retires", async () => {
    const completionRead = deferred<InstallationStatus>();
    let readCount = 0;
    const services = makeServices({
      readStatus: vi.fn(() => {
        readCount += 1;
        return readCount === 2 ? completionRead.promise : Promise.resolve(makeStatus());
      }),
    });
    const controller = await loadedController(services);
    const restart = controller.perform("restart");
    await flushMicrotasks();
    expect(controller.getSnapshot().activeAction).toBe("restart");
    expect(readCount).toBe(2);
    expect(await controller.perform("check")).toBe(false);
    expect(services.checkHealth).not.toHaveBeenCalled();
    completionRead.resolve(makeStatus());
    await restart;
    expect(controller.getSnapshot().activeAction).toBeNull();
  });

  it("keeps Check health and Fix health on the same controller service", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).find((action) => action.id === "check")?.shortcut).toBe("d");
    expect(services.checkHealth).toHaveBeenCalledWith(expect.objectContaining({ fix: false }));
  });

  it("manual Refresh reads status without running health repair", async () => {
    const services = makeServices();
    const controller = await loadedController(services);
    await controller.perform("refresh");
    expect(services.readStatus).toHaveBeenCalledTimes(2);
    expect(services.checkHealth).not.toHaveBeenCalled();
  });

  it("preserves the last valid status if a later read fails", async () => {
    const previous = makeStatus();
    const services = makeServices({
      readStatus: vi.fn().mockResolvedValueOnce(previous).mockRejectedValueOnce(new Error("status unavailable")),
    });
    const controller = await loadedController(services);
    await controller.perform("refresh");
    expect(controller.getSnapshot().status).toEqual(previous);
    expect(controller.getSnapshot().refreshError).toBe("status unavailable");
  });

  it("keeps the action and menu policy aligned through one available-action list", async () => {
    const controller = await loadedController();
    const actions = getAvailableManagerActions(controller.getSnapshot());
    expect(actions.find((action) => action.id === "restart")?.shortcut).toBe("b");
    expect(actions.find((action) => action.id === "check")?.shortcut).toBe("d");
    expect(actions.find((action) => action.id === "refresh")?.shortcut).toBe("r");
  });

  it("offers only Quit while a foreground action is running", async () => {
    const healthRead = deferred<InstallationHealthResult>();
    const services = makeServices({ checkHealth: vi.fn(() => healthRead.promise) });
    const controller = await loadedController(services);
    const check = controller.perform("check");
    expect(controller.getSnapshot().activeAction).toBe("check");
    expect(getAvailableManagerActions(controller.getSnapshot()).map((action) => action.id)).toEqual(["quit"]);
    healthRead.resolve(makeHealth());
    await check;
  });

  it("hides Refresh while a status read is active", async () => {
    const statusRead = deferred<InstallationStatus>();
    const controller = makeController(makeServices({ readStatus: vi.fn(() => statusRead.promise) }));
    const refresh = controller.refresh();
    await flushMicrotasks();
    expect(controller.getSnapshot().refreshing).toBe(true);
    expect(getAvailableManagerActions(controller.getSnapshot()).some((action) => action.id === "refresh")).toBe(false);
    statusRead.resolve(makeStatus());
    await refresh;
  });

  it("ignores a status result that completes after the Manager closes", async () => {
    let resolveStatus!: (status: InstallationStatus) => void;
    const services = makeServices({
      readStatus: vi.fn(() => new Promise<InstallationStatus>((resolve) => { resolveStatus = resolve; })),
    });
    const controller = makeController(services);
    const read = controller.refresh();
    await Promise.resolve();
    await Promise.resolve();
    controller.close();
    resolveStatus(makeStatus());
    await read;
    expect(controller.getSnapshot().closed).toBe(true);
    expect(controller.getSnapshot().status).toBeNull();
  });

  it("uses a named stale-status threshold", () => {
    const status = makeStatus();
    const observedAt = Date.parse(status.observedAt);
    expect(isStatusStale(status, observedAt + MANAGER_STATUS_STALE_AFTER_MS - 1)).toBe(false);
    expect(isStatusStale(status, observedAt + MANAGER_STATUS_STALE_AFTER_MS)).toBe(true);
  });

  it("chooses wide or narrow layout at the named terminal width", () => {
    expect(getManagerLayout(MANAGER_WIDE_MIN_COLUMNS - 1)).toBe("narrow");
    expect(getManagerLayout(MANAGER_WIDE_MIN_COLUMNS)).toBe("wide");
  });

  it("marks unparsable status timestamps stale", () => {
    expect(isStatusStale({ ...makeStatus(), observedAt: "invalid" })).toBe(true);
  });
});
