import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import { WriteRequestStore } from "../src/write-requests/store.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let profileStateDir: string;
let stateDir: string;
let workspaceA: string;
let workspaceB: string;
let workspaceAId: string;
let workspaceBId: string;
let broker: Broker;
const clients: Client[] = [];
let readClient: Client;
let writeClient: Client;
let writeOnlyClient: Client;

function patchUpdate(before: string, after: string): string {
  return `--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function connectClient(name: string, scopes: string[]): Promise<Client> {
  const tokens = broker.authStore.issueTokens({ clientId: name, scopes });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${broker.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    })
  );
  clients.push(client);
  return client;
}

async function propose(client: Client, workspace: string, before: string, after: string, worktree?: string) {
  return client.callTool({
    name: "propose_patch",
    arguments: { workspace, ...(worktree ? { worktree } : {}), patch: patchUpdate(before, after) },
  });
}

beforeAll(async () => {
  profileStateDir = isolateStateDir();
  stateDir = makeTmpDir("mcp-write-state");
  workspaceA = makeTmpDir("mcp-write-a");
  workspaceB = makeTmpDir("mcp-write-b");
  write(workspaceA, "file.txt", "before-a\n");
  write(workspaceB, "file.txt", "before-b\n");

  broker = await startBroker({
    stateDir,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(stateDir, "auth", "test.json"),
  });
  workspaceAId = broker.registry.register({ root: workspaceA, displayName: "MCP Write A" }).id;
  workspaceBId = broker.registry.register({ root: workspaceB, displayName: "MCP Write B" }).id;
  readClient = await connectClient("mcp-write-read", ["workspace.read"]);
  writeClient = await connectClient("mcp-write-write", ["workspace.read", "workspace.write"]);
  writeOnlyClient = await connectClient("mcp-write-only", ["workspace.write"]);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await broker.close();
  cleanup(profileStateDir);
  cleanup(stateDir);
  cleanup(workspaceA);
  cleanup(workspaceB);
});

describe("broker MCP write-request tools", () => {
  it("registers truthful proposal and read-only receipt annotations", async () => {
    const { tools } = await writeClient.listTools();
    const proposal = tools.find((tool) => tool.name === "propose_patch");
    const list = tools.find((tool) => tool.name === "list_write_requests");
    const detail = tools.find((tool) => tool.name === "get_write_request");

    expect(proposal?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(list?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(detail?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.map((tool) => tool.name)).not.toContain("apply_patch");
  });

  it("requires workspace.write and leaves workspace files unchanged when proposing", async () => {
    const denied = await propose(readClient, workspaceAId, "before-a", "denied");
    expect(denied.isError).toBe(true);
    expect(jsonOf(denied).error).toBe("INSUFFICIENT_SCOPE");
    expect(await broker.writeRequests!.listRequests({ workspaceId: workspaceAId, worktreeId: null })).toHaveLength(0);

    const patch = patchUpdate("before-a", "after-a");
    const created = await propose(writeClient, workspaceAId, "before-a", "after-a");
    expect(created.isError).not.toBe(true);
    const receipt = jsonOf<{
      request_id: string;
      status: string;
      files: { path: string; action: string; additions: number; deletions: number }[];
      expires_at: string;
    }>(created);
    expect(receipt).toMatchObject({
      status: "pending",
      files: [{ path: "file.txt", action: "update", additions: 1, deletions: 1 }],
    });
    expect(receipt.request_id).toMatch(/^wr_[a-f0-9]{24}$/);
    expect(receipt.expires_at).toBeTruthy();
    expect(textOf(created)).not.toContain(workspaceA);
    expect(textOf(created)).not.toContain(patch);
    expect(fs.readFileSync(path.join(workspaceA, "file.txt"), "utf8")).toBe("before-a\n");
    expect((await broker.writeRequests!.getRequest(receipt.request_id, true)).patch).toBe(patch);

    const invalid = await writeClient.callTool({
      name: "propose_patch",
      arguments: { workspace: workspaceAId, patch: "not a unified diff" },
    });
    expect(invalid.isError).toBe(true);
    expect(jsonOf(invalid).error).toBe("PATCH_INVALID");
    expect(fs.readFileSync(path.join(workspaceA, "file.txt"), "utf8")).toBe("before-a\n");
  });

  it("returns scoped receipts without raw patches or absolute paths", async () => {
    const patchA = patchUpdate("before-a", "after-a");
    const patchB = patchUpdate("before-b", "after-b");
    const createdA = jsonOf<{ request_id: string }>(await propose(writeClient, workspaceAId, "before-a", "after-a"));
    const createdB = jsonOf<{ request_id: string }>(await propose(writeClient, workspaceBId, "before-b", "after-b"));

    const listed = await readClient.callTool({
      name: "list_write_requests",
      arguments: { workspace: workspaceAId, status: "pending", limit: 20 },
    });
    const list = jsonOf<{ requests: Record<string, unknown>[] }>(listed);
    const expectedWorkspaceA = await broker.writeRequests!.listRequests({
      workspaceId: workspaceAId,
      worktreeId: null,
      status: "pending",
    });
    expect(list.requests.map((request) => request.request_id)).toEqual(expectedWorkspaceA.map((request) => request.id));
    expect(list.requests.map((request) => request.request_id)).not.toContain(createdB.request_id);
    expect(list.requests[0]).toMatchObject({
      request_id: createdA.request_id,
      status: "pending",
      approval_mode: "manual-local",
      files: [{ path: "file.txt", action: "update", additions: 1, deletions: 1, result_sha256: expect.any(String) }],
    });
    expect(JSON.stringify(list)).not.toContain(workspaceA);
    expect(JSON.stringify(list)).not.toContain(workspaceB);
    expect(JSON.stringify(list)).not.toContain(patchA);
    expect(JSON.stringify(list)).not.toContain(patchB);
    expect(list.requests[0]).not.toHaveProperty("patch");
    expect((list.requests[0].files as Record<string, unknown>[])[0]).not.toHaveProperty("base_sha256");

    const detail = await readClient.callTool({
      name: "get_write_request",
      arguments: { workspace: workspaceAId, request_id: createdA.request_id },
    });
    expect(jsonOf(detail)).toMatchObject({ request_id: createdA.request_id, status: "pending" });
    expect(textOf(detail)).not.toContain(workspaceA);
    expect(textOf(detail)).not.toContain(patchA);

    const crossWorkspace = await readClient.callTool({
      name: "get_write_request",
      arguments: { workspace: workspaceAId, request_id: createdB.request_id },
    });
    expect(crossWorkspace.isError).toBe(true);
    expect(jsonOf(crossWorkspace).error).toBe("WRITE_REQUEST_NOT_FOUND");

    const readDenied = await writeOnlyClient.callTool({
      name: "list_write_requests",
      arguments: { workspace: workspaceAId },
    });
    expect(readDenied.isError).toBe(true);
    expect(jsonOf(readDenied).error).toBe("INSUFFICIENT_SCOPE");
  });

  it("keeps receipts scoped to the selected main workspace and derived worktree", async () => {
    const mainRoot = makeTmpDir("mcp-write-derived-main");
    const worktreeParent = makeTmpDir("mcp-write-derived-parent");
    const worktreeRoot = path.join(worktreeParent, "linked");
    let registrationId: string | undefined;
    try {
      makeGitRepo(mainRoot);
      write(mainRoot, "file.txt", "before\n");
      git(mainRoot, "add", "file.txt");
      git(mainRoot, "commit", "-m", "track write-request target");
      git(mainRoot, "worktree", "add", "-b", "mcp-write-derived", worktreeRoot);
      registrationId = broker.registry.register({ root: mainRoot, displayName: "MCP derived write target" }).id;

      const gitReadClient = await connectClient("mcp-write-derived-list", ["workspace.read", "git.read"]);
      const discovered = await gitReadClient.callTool({ name: "list_worktrees", arguments: { workspace: registrationId } });
      const worktrees = jsonOf<{ worktrees: { worktree_id: string }[] }>(discovered).worktrees;
      expect(worktrees).toHaveLength(1);
      const worktreeId = worktrees[0].worktree_id;

      const mainProposal = jsonOf<{ request_id: string }>(
        await propose(writeClient, registrationId, "before", "main-after")
      );
      const derivedProposal = jsonOf<{ request_id: string }>(
        await propose(writeClient, registrationId, "before", "derived-after", worktreeId)
      );
      expect(derivedProposal.request_id).not.toBe(mainProposal.request_id);
      expect(fs.readFileSync(path.join(mainRoot, "file.txt"), "utf8")).toBe("before\n");
      expect(fs.readFileSync(path.join(worktreeRoot, "file.txt"), "utf8")).toBe("before\n");

      const mainReceipts = jsonOf<{ requests: { request_id: string }[] }>(await readClient.callTool({
        name: "list_write_requests",
        arguments: { workspace: registrationId, status: "pending", limit: 100 },
      }));
      const derivedReceipts = jsonOf<{ requests: { request_id: string }[] }>(await readClient.callTool({
        name: "list_write_requests",
        arguments: { workspace: registrationId, worktree: worktreeId, status: "pending", limit: 100 },
      }));
      expect(mainReceipts.requests.map((request) => request.request_id)).toEqual([mainProposal.request_id]);
      expect(derivedReceipts.requests.map((request) => request.request_id)).toEqual([derivedProposal.request_id]);

      const mainGet = await readClient.callTool({
        name: "get_write_request",
        arguments: { workspace: registrationId, request_id: derivedProposal.request_id },
      });
      expect(mainGet.isError).toBe(true);
      expect(jsonOf(mainGet).error).toBe("WRITE_REQUEST_NOT_FOUND");
      const derivedGet = await readClient.callTool({
        name: "get_write_request",
        arguments: { workspace: registrationId, worktree: worktreeId, request_id: mainProposal.request_id },
      });
      expect(derivedGet.isError).toBe(true);
      expect(jsonOf(derivedGet).error).toBe("WRITE_REQUEST_NOT_FOUND");

      const sanitized = JSON.stringify({ mainReceipts, derivedReceipts });
      expect(sanitized).not.toContain(mainRoot);
      expect(sanitized).not.toContain(worktreeRoot);
    } finally {
      if (registrationId) broker.registry.remove(registrationId);
      cleanup(mainRoot);
      cleanup(worktreeParent);
    }
  });

  it("keeps identical MCP proposals as separate pending receipts", async () => {
    const root = makeTmpDir("mcp-write-duplicate-proposals");
    write(root, "file.txt", "before\n");
    const id = broker.registry.register({ root, displayName: "MCP duplicate proposal test" }).id;
    try {
      const first = jsonOf<{ request_id: string; status: string }>(
        await propose(writeClient, id, "before", "duplicate-result")
      );
      const second = jsonOf<{ request_id: string; status: string }>(
        await propose(writeClient, id, "before", "duplicate-result")
      );

      expect(first.status).toBe("pending");
      expect(second.status).toBe("pending");
      expect(first.request_id).not.toBe(second.request_id);
      expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
      const listed = jsonOf<{ requests: { request_id: string }[] }>(await readClient.callTool({
        name: "list_write_requests",
        arguments: { workspace: id, status: "pending", limit: 100 },
      }));
      expect(listed.requests).toHaveLength(2);
      expect(listed.requests.map((request) => request.request_id)).toEqual(
        expect.arrayContaining([first.request_id, second.request_id])
      );
    } finally {
      broker.registry.remove(id);
      cleanup(root);
    }
  });

  it("returns the latest applied receipt for status=applied and limit=1", async () => {
    const first = await broker.writeRequests!.createManualRequest({
      workspaceId: workspaceBId,
      patch: patchUpdate("before-b", "first-applied"),
    });
    await broker.writeRequests!.approveManualRequest(first.id);
    const second = await broker.writeRequests!.createManualRequest({
      workspaceId: workspaceBId,
      patch: patchUpdate("first-applied", "latest-applied"),
    });
    await broker.writeRequests!.approveManualRequest(second.id);

    const store = new WriteRequestStore(stateDir);
    const firstRecord = store.get(first.id);
    const secondRecord = store.get(second.id);
    if (!firstRecord || !secondRecord) throw new Error("Expected applied receipts to be persisted.");
    const now = Date.now();
    const latestResolvedAt = new Date(now - 30_000).toISOString();
    store.update({ ...firstRecord, resolvedAt: new Date(now - 60_000).toISOString() });
    store.update({ ...secondRecord, resolvedAt: latestResolvedAt });

    const latest = await readClient.callTool({
      name: "list_write_requests",
      arguments: { workspace: workspaceBId, status: "applied", limit: 1 },
    });
    const requests = jsonOf<{ requests: { request_id: string; status: string; resolved_at: string }[] }>(latest).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      request_id: second.id,
      status: "applied",
      resolved_at: latestResolvedAt,
    });
  });

  it("denies proposal targets inside the registered broker state root", async () => {
    write(stateDir, "ordinary-state-file.txt", "private\n");
    const stateWorkspaceId = broker.registry.register({ root: stateDir, displayName: "Broker state root" }).id;
    try {
      const denied = await writeClient.callTool({
        name: "propose_patch",
        arguments: { workspace: stateWorkspaceId, patch: patchUpdate("private", "changed") },
      });
      expect(denied.isError).toBe(true);
      expect(jsonOf(denied).error).toBe("WRITE_PROTECTED_PATH");
      expect(fs.readFileSync(path.join(stateDir, "ordinary-state-file.txt"), "utf8")).toBe("private\n");
    } finally {
      broker.registry.remove(stateWorkspaceId);
    }
  });

  it("maps an oversized MCP transport body to sanitized PATCH_TOO_LARGE", async () => {
    const token = broker.authStore.issueTokens({ clientId: "mcp-oversized-body", scopes: ["workspace.write"] });
    const fileBefore = fs.readFileSync(path.join(workspaceA, "file.txt"), "utf8");
    const pendingBefore = (await broker.writeRequests!.listRequests({
      workspaceId: workspaceAId,
      worktreeId: null,
      status: "pending",
    })).map((receipt) => receipt.id);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "oversized",
      method: "tools/call",
      params: {
        name: "propose_patch",
        arguments: { workspace: workspaceAId, patch: "x".repeat(8 * 1024 * 1024) },
      },
    });
    const response = await fetch(`${broker.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "PATCH_TOO_LARGE",
      message: "Request body exceeds the MCP transport limit.",
    });
    expect(fs.readFileSync(path.join(workspaceA, "file.txt"), "utf8")).toBe(fileBefore);
    const pendingAfter = (await broker.writeRequests!.listRequests({
      workspaceId: workspaceAId,
      worktreeId: null,
      status: "pending",
    })).map((receipt) => receipt.id);
    expect(pendingAfter).toEqual(pendingBefore);
  });
});
