import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { BROKER_DEFAULT_READ_SCOPES, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { WINDOW_MS } from "../src/command-requests/types.js";
import { CommandRequestStore } from "../src/command-requests/store.js";
import { isolateStateDir, makeTmpDir, makeGitRepo, git } from "./helpers.js";

let broker: Broker, state: string, root: string;
const clients: Client[] = [];
beforeEach(async () => {
  isolateStateDir(); state = makeTmpDir("command-broker"), root = makeTmpDir("command-target");
  broker = await startBroker({ stateDir: state, port: 0, persistRuntime: false, authStoreFile: path.join(state, "auth.json") });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close())); await broker.close();
});
function json(result: { content?: unknown }): Record<string, any> {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}
async function client(scopes = ["workspace.command"]) {
  const tokens = broker.authStore.issueTokens({ clientId: `commands-${clients.length}`, scopes });
  const c = new Client({ name: "command-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(broker.localBaseUrl() + "/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  })); clients.push(c); return c;
}
async function admin(route: string, method = "GET", headers: Record<string, string> = {}) {
  return fetch(broker.localBaseUrl() + "/admin/command-requests" + route, {
    method, headers: { authorization: `Bearer ${broker.adminToken}`, ...headers },
  });
}
const command = { argv: [process.execPath, "-e", "console.log('result'); process.exitCode=2"], reason: "Run harmless check" };

describe("command broker security and public contracts", () => {
  it("normalizes malformed and missing fields through the real SDK into JSON command errors", async () => {
    broker.registry.register({ root }); const c = await client();
    for (const args of [{ ...command, argv: "echo" }, { argv: command.argv }, { reason: "missing argv" },
      { ...command, argv: [4] }, { ...command, cwd: null }]) {
      const result = await c.callTool({ name: "request_command", arguments: args });
      expect(result.isError).toBe(true); expect(json(result).error).toBe("COMMAND_INVALID");
    }
    const request = json(await c.callTool({ name: "request_command", arguments: command }));
    for (const max_output_bytes of ["8192", null, {}]) {
      const result = await c.callTool({ name: "get_command_request", arguments: { request_id: request.request_id, max_output_bytes } });
      expect(result.isError).toBe(true); expect(json(result).error).toBe("COMMAND_INVALID");
    }
  });
  it("requires explicit command scope for both tools, excludes default/legacy scope and remote approval", async () => {
    const workspace = broker.registry.register({ root }).id;
    expect(BROKER_DEFAULT_READ_SCOPES).not.toContain("workspace.command");
    expect(SUPPORTED_SCOPES).not.toContain("workspace.command");
    const c = await client(["workspace.read", "workspace.write", "execution.read"]);
    for (const name of ["request_command", "get_command_request"]) {
      const denied = await c.callTool({ name, arguments: { workspace, ...command, request_id: "cr_" + "a".repeat(24) } });
      expect(denied.isError).toBe(true); expect(json(denied).error).toBe("INSUFFICIENT_SCOPE");
    }
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("request_command"); expect(names).not.toContain("approve_command");
    expect(names).not.toContain("list_command_requests");
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const legacy = createMcpServer({ workspace: new Workspace(root), commandRequests: broker.commandRequests, logger: nullLogger });
    const local = new Client({ name: "legacy", version: "1" });
    await legacy.connect(serverTransport); await local.connect(clientTransport);
    expect((await local.listTools()).tools.map((t) => t.name)).not.toContain("request_command");
    await local.close(); await legacy.close();
  });
  it("returns exact creation, running, completed nonzero and metadata-only receipt shapes", async () => {
    const workspace = broker.registry.register({ root }).id, c = await client();
    const created = json(await c.callTool({ name: "request_command", arguments: command }));
    expect(Object.keys(created).sort()).toEqual(["approval_command", "expires_at", "request_id", "status", "workspace_id"]);
    expect(created).toMatchObject({ status: "pending", workspace_id: workspace, approval_command: `c2c approve ${created.request_id}` });
    expect(created.request_id).toMatch(/^cr_[a-f0-9]{24}$/);
    const pending = json(await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id } }));
    expect(Object.keys(pending).sort()).toEqual(["argv", "created_at", "cwd", "expires_at", "reason", "request_id", "status", "workspace_id"]);
    expect(pending.argv).toEqual(command.argv); expect(pending.cwd).toBe(".");
    const approved = await admin(`/${created.request_id}/approve`, "POST"), started = await approved.json();
    expect(approved.status).toBe(200); expect(started.status).toBe("running"); expect(started.started_at).toBeDefined();
    let result: Awaited<ReturnType<Client["callTool"]>>;
    await vi.waitFor(async () => {
      result = await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id } });
      expect(json(result).status).toBe("completed");
    });
    expect(result!.isError).not.toBe(true);
    const done = json(result!);
    expect(done).toMatchObject({ exit_code: 2, signal: null, stdout: "result\n", stderr: "", stdout_truncated: false, stderr_truncated: false,
      stdout_response_truncated: false, stderr_response_truncated: false, output_incomplete: false });
    expect(Date.parse(done.result_available_until) - Date.parse(done.resolved_at)).toBe(WINDOW_MS);
    expect(JSON.stringify(done)).not.toContain(root); expect(done).not.toHaveProperty("leader");
    const metadata = json(await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id, max_output_bytes: 0 } }));
    expect(metadata.stdout).toBe(""); expect(metadata.stdout_response_truncated).toBe(true);
    expect((await admin(`/${created.request_id}/approve`, "POST")).status).toBe(409);
  });
  it("handles zero/one/multiple selection and explicit unknown targets for both tools", async () => {
    const c = await client();
    const getArgs = { request_id: "cr_" + "a".repeat(24) };
    for (const name of ["request_command", "get_command_request"]) {
      expect(json(await c.callTool({ name, arguments: { ...command, ...getArgs } })).error).toBe("WORKSPACE_REQUIRED");
    }
    const workspace = broker.registry.register({ root }).id;
    const created = json(await c.callTool({ name: "request_command", arguments: command }));
    expect(created.status).toBe("pending");
    expect(json(await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id } })).status).toBe("pending");
    broker.registry.register({ root: makeTmpDir("second-command-root") });
    for (const name of ["request_command", "get_command_request"]) {
      expect(json(await c.callTool({ name, arguments: { ...command, ...getArgs } })).error).toBe("WORKSPACE_REQUIRED");
      expect(json(await c.callTool({ name, arguments: { ...command, ...getArgs, workspace: "unknown" } })).error).toBe("WORKSPACE_UNAVAILABLE");
      expect(json(await c.callTool({ name, arguments: { ...command, ...getArgs, workspace, worktree: "unavailable" } })).error).toBe("WORKTREE_UNAVAILABLE");
    }
    // Changed default registration set cannot retarget a stored request.
    expect((await admin(`/${created.request_id}/approve`, "POST")).status).toBe(200);
    expect(broker.commandRequests!.get(created.request_id).workspaceId).toBe(workspace);
    broker.registry.remove(workspace);
    for (const name of ["request_command", "get_command_request"]) {
      expect(json(await c.callTool({ name, arguments: { ...command, ...getArgs, workspace } })).error).toBe("WORKSPACE_UNAVAILABLE");
    }
  });
  it("isolates concrete workspace/worktree receipts, including unavailable cross-target results", async () => {
    makeGitRepo(root);
    const linked = path.join(makeTmpDir("command-linked-parent"), "linked");
    git(root, "worktree", "add", "-b", "command-test", linked);
    const workspace = broker.registry.register({ root }).id;
    const second = broker.registry.register({ root: makeTmpDir("command-other") }).id;
    const c = await client(["workspace.command", "git.read"]);
    const worktree = json(await c.callTool({ name: "list_worktrees", arguments: { workspace } })).worktrees[0].worktree_id;
    const created = json(await c.callTool({ name: "request_command", arguments: { ...command, workspace, worktree } }));
    expect(created.worktree_id).toBe(worktree);
    for (const args of [{ workspace }, { workspace: second }]) {
      const cross = json(await c.callTool({ name: "get_command_request", arguments: { ...args, request_id: created.request_id } }));
      const missing = json(await c.callTool({ name: "get_command_request", arguments: { ...args, request_id: "cr_" + "a".repeat(24) } }));
      expect(cross).toEqual(missing); expect(cross.error).toBe("COMMAND_REQUEST_NOT_FOUND");
    }
    expect(json(await c.callTool({ name: "get_command_request", arguments: { workspace, worktree, request_id: created.request_id } })).status).toBe("pending");
    expect((await admin(`/${created.request_id}/approve`, "POST")).status).toBe(200);
    expect(broker.commandRequests!.get(created.request_id).worktreeId).toBe(worktree);
  });
  it("protects every admin operation from bearer clients and proxy forwarding", async () => {
    broker.registry.register({ root }); const c = await client();
    const r = json(await c.callTool({ name: "request_command", arguments: command }));
    for (const [route, method] of [["", "GET"], [`/${r.request_id}`, "GET"], [`/${r.request_id}/approve`, "POST"], [`/${r.request_id}/reject`, "POST"]]) {
      expect((await admin(route!, method, { authorization: "Bearer invalid" })).status).toBe(404);
      expect((await admin(route!, method, { "x-forwarded-for": "127.0.0.1" })).status).toBe(404);
      expect((await admin(route!, method, { "cf-connecting-ip": "127.0.0.1" })).status).toBe(404);
    }
    expect(broker.commandRequests!.get(r.request_id).status).toBe("pending");
  });
  it("projects default/max/UTF-8 output independently from retained truncation; invalid bounds are stable errors", async () => {
    broker.registry.register({ root }); const c = await client();
    const created = json(await c.callTool({ name: "request_command", arguments: { argv: [process.execPath, "-e", "process.stdout.write('λ'.repeat(200000)); process.stderr.write('err')"], reason: "output" } }));
    await admin(`/${created.request_id}/approve`, "POST");
    await vi.waitFor(() => expect(broker.commandRequests!.get(created.request_id).status).toBe("completed"));
    for (const max of [undefined, 0, 5, 65536]) {
      const r = json(await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id, ...(max !== undefined ? { max_output_bytes: max } : {}) } }));
      expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(max ?? 8192);
      expect(r.stdout).not.toContain("�"); expect(r.stdout_truncated).toBe(true); expect(r.stdout_response_truncated).toBe(true);
      expect(r.output_incomplete).toBe(false); expect(r.stderr_truncated).toBe(false);
    }
    for (const max_output_bytes of [-1, 65537, 0.5]) {
      const r = await c.callTool({ name: "get_command_request", arguments: { request_id: created.request_id, max_output_bytes } });
      expect(r.isError).toBe(true); expect(json(r).error).toBe("COMMAND_INVALID");
    }
  });
  it("exposes state-dependent spawn failure/rejected/expired fields and observational reads", async () => {
    broker.registry.register({ root }); const c = await client();
    const r = json(await c.callTool({ name: "request_command", arguments: { argv: ["/nonexistent-c2c"], reason: "spawn failure" } }));
    expect((await (await admin(`/${r.request_id}/approve`, "POST")).json()).status).toBe("failed");
    const failed = json(await c.callTool({ name: "get_command_request", arguments: { request_id: r.request_id } }));
    expect(failed).toMatchObject({ status: "failed", resolution_code: "COMMAND_SPAWN_FAILED", exit_code: null, signal: null, stdout: "", stderr: "", output_incomplete: false });
    expect(failed).not.toHaveProperty("started_at");
    const rejected = json(await c.callTool({ name: "request_command", arguments: command }));
    await admin(`/${rejected.request_id}/reject`, "POST");
    expect(json(await c.callTool({ name: "get_command_request", arguments: { request_id: rejected.request_id } }))).not.toHaveProperty("stdout");
    const expired = json(await c.callTool({ name: "request_command", arguments: command }));
    const store = new CommandRequestStore(state), record = store.get(expired.request_id)!;
    store.update({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const file = path.join(store.directory, record.id + ".json"), bytes = fs.readFileSync(file);
    const receipt = json(await c.callTool({ name: "get_command_request", arguments: { request_id: record.id } }));
    expect(receipt.status).toBe("expired"); expect(receipt.resolved_at).toBe(store.get(record.id)!.expiresAt);
    expect(receipt).not.toHaveProperty("stdout"); expect(fs.readFileSync(file)).toEqual(bytes);
    await admin(`/${record.id}`); await admin(""); expect(fs.readFileSync(file)).toEqual(bytes);
  });
  it("omits broken command capability while preserving patch capability and ordinary reads", async () => {
    await broker.close();
    fs.mkdirSync(path.join(state, "command-requests"), { recursive: true });
    fs.writeFileSync(path.join(state, "command-requests", "cr_" + "a".repeat(24) + ".json"), "invalid json");
    broker = await startBroker({ stateDir: state, port: 0, persistRuntime: false, authStoreFile: path.join(state, "auth.json") });
    expect(broker.commandRequests).toBeUndefined(); expect(broker.writeRequests).toBeDefined();
    const c = await client(["workspace.read"]), names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("read_file"); expect(names).toContain("propose_patch"); expect(names).not.toContain("request_command");
    expect((await admin("")).status).toBe(404);
  });
});
