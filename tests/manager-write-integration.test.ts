import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBroker, type Broker } from "../src/broker/server.js";
import { ManagerController } from "../src/manager/controller.js";
import { managerServices } from "../src/manager/services.js";
import type { ManagerStatus } from "../src/manager/write-request-service.js";
import type { PendingObservation } from "../src/write-requests/observation.js";
import type { WriteRequestDetails } from "../src/write-requests/service.js";
import type { WriteRequestReceipt } from "../src/write-requests/types.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let broker: Broker | undefined, controller: ManagerController | undefined;
const dirs: string[] = [];
afterEach(async () => { controller?.close(); await broker?.close(); vi.restoreAllMocks(); dirs.splice(0).forEach(cleanup); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("Manager approval against the real installation broker", () => {
  it("leaves review bytes unchanged, cancels confirmation, loses a dispatched response, and reconciles exactly one apply", async () => {
    const state = makeTmpDir("manager-write-state"), root = makeTmpDir("manager-write-project"); dirs.push(state, root);
    write(root, "file.txt", "before\n");
    broker = await startBroker({ stateDir: state, port: 0, persistRuntime: false, authStoreFile: path.join(state, "auth/test.json") });
    const workspaceId = broker.registry.register({ root, displayName: "Fixture" }).id;
    const currentBroker = broker;
    const fetchAdmin = async <T>(route: string, signal?: AbortSignal, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(currentBroker.localBaseUrl() + "/admin/write-requests" + route, {
        method, signal, headers: { authorization: "Bearer " + currentBroker.adminToken, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      return result as T;
    };
    const request = await fetchAdmin<WriteRequestReceipt>("", undefined, "POST", { workspaceId, patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n" });
    const recordPath = path.join(state, "write-requests", request.id + ".json"), before = fs.readFileSync(recordPath);
    let posts = 0;
    controller = new ManagerController({ ...managerServices,
      readInstruction: () => ({ kind: "none" }),
      readStatus: async ({ signal }): Promise<ManagerStatus> => ({
        installation: { state: "ready", id: "c2c_inst_fixture", version: "0.2.0", profile: null },
        broker: { state: "running" }, authorization: { state: "unknown" }, tunnel: { state: "stopped", provider: null, preference: "unset" },
        workspaces: [{ id: workspaceId, name: "Fixture", liveSessionCount: 0 }], observedAt: new Date().toISOString(),
        pendingCounts: (await fetchAdmin<PendingObservation>("/observe", signal)).counts,
      }),
      writeRequests: {
        list: (workspace, signal) => fetchAdmin(`/observe?workspaceId=${workspace}`, signal),
        detail: (workspace, id, signal) => fetchAdmin<WriteRequestDetails>(`/observe/${id}?workspaceId=${workspace}&includePatch=true`, signal),
        receipt: (workspace, id, signal) => fetchAdmin(`/observe/${id}?workspaceId=${workspace}`, signal),
        approve: (id, signal, dispatch) => { dispatch(); posts++; return fetchAdmin(`/${id}/approve`, signal, "POST"); },
      },
    });
    await controller.refresh(); await controller.requests.openQueue(); await controller.requests.openDetail();
    expect(fs.readFileSync(recordPath)).toEqual(before); expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
    controller.requests.requestApproval(); controller.cancelConfirmation(); expect(posts).toBe(0);
    const started = deferred(), release = deferred(), applied = deferred();
    const original = broker.writeRequests!.approveManualRequest.bind(broker.writeRequests!);
    vi.spyOn(broker.writeRequests!, "approveManualRequest").mockImplementation(async (id) => {
      started.resolve(); await release.promise;
      try { return await original(id); } finally { applied.resolve(); }
    });
    controller.requests.requestApproval(); const approving = controller.confirmPendingAction();
    await started.promise; controller.requests.back(); await approving;
    expect(controller.getSnapshot().approvalAttempt?.state).toBe("unknown"); expect(posts).toBe(1);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
    release.resolve(); await applied.promise;
    await controller.refresh();
    expect(controller.getSnapshot().approvalAttempt).toMatchObject({ state: "resolved", receipt: { status: "applied" } });
    expect(controller.getSnapshot().pendingCounts?.[workspaceId] ?? 0).toBe(0);
    expect(posts).toBe(1); expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
    await expect(original(request.id)).rejects.toMatchObject({ code: "WRITE_REQUEST_NOT_PENDING" });
  });
});
