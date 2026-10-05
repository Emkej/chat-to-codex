import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBroker, type Broker } from "../src/broker/server.js";
import { WriteRequestStore } from "../src/write-requests/store.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let broker: Broker, state: string, root: string, workspaceId: string;
let id: string;
const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n";
beforeAll(async () => {
  state = makeTmpDir("observation-admin"); root = makeTmpDir("observation-project");
  write(root, "file.txt", "before\n");
  broker = await startBroker({ stateDir: state, port: 0, persistRuntime: false, authStoreFile: path.join(state, "auth/test.json") });
  workspaceId = broker.registry.register({ root, displayName: "Observation" }).id;
});
afterAll(async () => { await broker.close(); cleanup(state); cleanup(root); });

async function request(route: string, method = "GET", body?: unknown, token = broker.adminToken) {
  const response = await fetch(broker.localBaseUrl() + "/admin/write-requests" + route, {
    method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

describe("real broker observation routes", () => {
  it("uses the existing guard and requires a workspace for detail", async () => {
    expect((await request("/observe", "GET", undefined, "wrong")).status).toBe(404);
    id = (await request("", "POST", { workspaceId, patch })).data.id;
    expect((await request("/observe/" + id)).status).toBe(400);
    expect((await request(`/observe/${id}?workspaceId=other&includePatch=true`)).status).toBe(404);
  });
  it("returns scoped metadata and exact counts without mutating the pending record", async () => {
    const store = new WriteRequestStore(state);
    const file = path.join(store.directory, id + ".json");
    const before = fs.readFileSync(file);
    const list = await request(`/observe?workspaceId=${workspaceId}`);
    expect(list.data.counts).toEqual({ [workspaceId]: 1 });
    expect(list.data.requests).toHaveLength(1);
    expect(list.data.requests[0]).not.toHaveProperty("patch");
    expect(JSON.stringify(list.data)).not.toContain(root);
    expect((await request(`/observe/${id}?workspaceId=${workspaceId}&includePatch=true`)).data.patch).toBe(patch);
    expect(fs.readFileSync(file)).toEqual(before);
    expect((await request("/observe?deadline=1")).status).toBe(503);
  });
  it("reconciles canonical terminal outcomes without patch or lazy cleanup", async () => {
    expect((await request(`/${id}/approve`, "POST")).data.status).toBe("applied");
    const receipt = await request(`/observe/${id}?workspaceId=${workspaceId}`);
    expect(receipt.data.status).toBe("applied"); expect(receipt.data).not.toHaveProperty("patch");
    expect((await request(`/observe/${id}?workspaceId=${workspaceId}&includePatch=true`)).status).toBe(409);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("after\n");
  });
});
