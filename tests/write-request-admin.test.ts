import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBroker, type Broker } from "../src/broker/server.js";
import { WriteRequestStore } from "../src/write-requests/store.js";
import type { WriteRequestRecord } from "../src/write-requests/types.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let workspaceRoot: string;
let sortWorkspaceRoot: string;
let broker: Broker;
let workspaceId: string;
let sortWorkspaceId: string;

function updatePatch(before: string, after: string): string {
  return `--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

async function adminRequest(
  route: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${broker.adminToken}` }
): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await fetch(`${broker.localBaseUrl()}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  stateDir = makeTmpDir("write-admin-state");
  workspaceRoot = makeTmpDir("write-admin-workspace");
  sortWorkspaceRoot = makeTmpDir("write-admin-sort-workspace");
  write(workspaceRoot, "file.txt", "before\n");
  write(sortWorkspaceRoot, "file.txt", "after\n");
  broker = await startBroker({
    stateDir,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(stateDir, "auth", "test.json"),
  });
  workspaceId = broker.registry.register({ root: workspaceRoot, displayName: "Write admin test" }).id;
  sortWorkspaceId = broker.registry.register({ root: sortWorkspaceRoot, displayName: "Write admin sort test" }).id;
});

afterAll(async () => {
  await broker.close();
  cleanup(stateDir);
  cleanup(workspaceRoot);
  cleanup(sortWorkspaceRoot);
});

describe("local write-request admin API", () => {
  it("requires the loopback admin token and rejects forwarded requests", async () => {
    const unauthenticated = await adminRequest("/admin/write-requests", "GET", undefined, {});
    expect(unauthenticated.response.status).toBe(404);
    const forwarded = await adminRequest("/admin/write-requests", "GET", undefined, {
      authorization: `Bearer ${broker.adminToken}`,
      "x-forwarded-for": "203.0.113.10",
    });
    expect(forwarded.response.status).toBe(404);
  });

  it("creates, inspects, approves, rejects, and scrubs terminal request patches", async () => {
    const created = await adminRequest("/admin/write-requests", "POST", {
      workspaceId,
      patch: updatePatch("before", "after"),
    });
    expect(created.response.status).toBe(200);
    const id = String(created.data.id);
    expect(created.data.status).toBe("pending");

    const detail = await adminRequest(`/admin/write-requests/${id}?includePatch=true`);
    expect(detail.data.patch).toBe(updatePatch("before", "after"));
    expect((detail.data as { files: unknown[] }).files).toHaveLength(1);

    const applied = await adminRequest(`/admin/write-requests/${id}/approve`, "POST");
    expect(applied.response.status).toBe(200);
    expect(applied.data.status).toBe("applied");
    expect(fs.readFileSync(path.join(workspaceRoot, "file.txt"), "utf8")).toBe("after\n");
    const terminal = await adminRequest(`/admin/write-requests/${id}?includePatch=true`);
    expect(terminal.data.patch).toBeUndefined();
    const secondApproval = await adminRequest(`/admin/write-requests/${id}/approve`, "POST");
    expect(secondApproval.response.status).toBe(409);
    expect(secondApproval.data.error).toBe("WRITE_REQUEST_NOT_PENDING");

    const rejectedCreate = await adminRequest("/admin/write-requests", "POST", {
      workspaceId,
      patch: updatePatch("after", "rejected"),
    });
    const rejectedId = String(rejectedCreate.data.id);
    const rejected = await adminRequest(`/admin/write-requests/${rejectedId}/reject`, "POST");
    expect(rejected.response.status).toBe(200);
    expect(rejected.data.status).toBe("rejected");
    expect((await adminRequest(`/admin/write-requests/${rejectedId}?includePatch=true`)).data.patch).toBeUndefined();
  });

  it("filters main-workspace requests, sorts before applying limit, and maps stale to 409", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const created = await adminRequest("/admin/write-requests", "POST", {
        workspaceId: sortWorkspaceId,
        patch: updatePatch("after", `result-${index}`),
      });
      ids.push(String(created.data.id));
    }
    const store = new WriteRequestStore(stateDir);
    const [oldPending, oldTerminal, newerPending] = ids.map((id) => store.get(id) as WriteRequestRecord);
    store.update({ ...oldPending, createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    store.update({
      ...oldTerminal,
      status: "rejected",
      createdAt: "2019-01-01T00:00:00.000Z",
      resolvedAt: "2030-01-01T00:00:00.000Z",
      patch: undefined,
    });
    store.update({ ...newerPending, createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    const derivedRequestId = "wr_aaaaaaaaaaaaaaaaaaaaaaaa";
    store.create({
      ...oldPending,
      id: derivedRequestId,
      worktreeId: "wt_other",
      createdAt: "2040-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const sorted = await adminRequest(`/admin/write-requests?workspaceId=${sortWorkspaceId}&worktreeId=&limit=2`);
    const tiedMainRequests = [ids[0], ids[2]].sort();
    expect((sorted.data.requests as { id: string }[]).map((request) => request.id)).toEqual([ids[1], tiedMainRequests[0]]);
    const pending = await adminRequest(`/admin/write-requests?workspaceId=${sortWorkspaceId}&worktreeId=&status=pending`);
    expect((pending.data.requests as { id: string }[]).map((request) => request.id)).toEqual(tiedMainRequests);
    const anyWorktree = await adminRequest(`/admin/write-requests?workspaceId=${sortWorkspaceId}&status=pending`);
    expect((anyWorktree.data.requests as { id: string }[]).map((request) => request.id)).toContain(derivedRequestId);
    const missing = await adminRequest("/admin/write-requests/wr_000000000000000000000000/approve", "POST");
    expect(missing.response.status).toBe(404);
    expect(missing.data.error).toBe("WRITE_REQUEST_NOT_FOUND");

    const staleCreated = await adminRequest("/admin/write-requests", "POST", {
      workspaceId,
      patch: updatePatch("after", "stale-result"),
    });
    write(workspaceRoot, "file.txt", "external edit\n");
    const stale = await adminRequest(`/admin/write-requests/${String(staleCreated.data.id)}/approve`, "POST");
    expect(stale.response.status).toBe(409);
    expect(stale.data.error).toBe("WRITE_STALE");
    expect((await adminRequest(`/admin/write-requests/${String(staleCreated.data.id)}?includePatch=true`)).data.patch)
      .toBeUndefined();
  });

  it("maps expiry to 409 after persisting a terminal receipt without the raw patch", async () => {
    const created = await adminRequest("/admin/write-requests", "POST", {
      workspaceId: sortWorkspaceId,
      patch: updatePatch("after", "expired-result"),
    });
    const id = String(created.data.id);
    const store = new WriteRequestStore(stateDir);
    const pending = store.get(id) as WriteRequestRecord;
    store.update({ ...pending, expiresAt: "2020-01-01T00:00:00.000Z" });

    const expired = await adminRequest(`/admin/write-requests/${id}/approve`, "POST");

    expect(expired.response.status).toBe(409);
    expect(expired.data.error).toBe("WRITE_REQUEST_EXPIRED");
    const persisted = store.get(id);
    expect(persisted).toMatchObject({
      status: "expired",
      resolutionCode: "WRITE_REQUEST_EXPIRED",
    });
    expect(persisted).not.toHaveProperty("patch");
    const terminal = await adminRequest(`/admin/write-requests/${id}?includePatch=true`);
    expect(terminal.data.status).toBe("expired");
    expect(terminal.data.resolutionCode).toBe("WRITE_REQUEST_EXPIRED");
    expect(terminal.data.patch).toBeUndefined();
  });

  it("maps transport body-limit failures to PATCH_TOO_LARGE", async () => {
    const oversized = JSON.stringify({ workspaceId, patch: "x".repeat(3 * 1024 * 1024) });
    const response = await fetch(`${broker.localBaseUrl()}/admin/write-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${broker.adminToken}`, "content-type": "application/json" },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "PATCH_TOO_LARGE" });
  });
});
