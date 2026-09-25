import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { RuntimeState } from "../src/bridge/runtime.js";
import type { WriteRequestReceipt } from "../src/write-requests/types.js";

const mocks = vi.hoisted(() => ({ ensureBroker: vi.fn(), adminFetch: vi.fn() }));

vi.mock("../src/broker/daemon.js", () => ({ ensureBroker: mocks.ensureBroker }));
vi.mock("../src/process/daemon.js", () => ({ adminFetch: mocks.adminFetch }));

import { registerWriteRequestCommands, selectOnePendingRequest, toCliWriteRequest, WriteRequestCliError } from "../src/cli/write-requests.js";

function receipt(id: string): WriteRequestReceipt {
  return {
    id,
    kind: "patch",
    status: "pending",
    workspaceId: "workspace-1",
    approvalMode: "manual-local",
    files: [{ path: "docs/example.md", operation: "update", additions: 1, deletions: 1, resultSha256: "hash" }],
    preconditions: [{ path: "docs/example.md", expected: "sha256", baseSha256: "before" }],
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-24T01:00:00.000Z",
  };
}

describe("write-request CLI contracts", () => {
  it("selects exactly one relevant pending request without a second confirmation", () => {
    expect(selectOnePendingRequest([receipt("wr_one")]).id).toBe("wr_one");
  });

  it("fails safely for zero or multiple implicit candidates", () => {
    expect(() => selectOnePendingRequest([])).toThrowError(
      expect.objectContaining({ code: "WRITE_REQUEST_NOT_FOUND" })
    );
    try {
      selectOnePendingRequest([receipt("wr_one"), receipt("wr_two")]);
      throw new Error("Expected ambiguous selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WriteRequestCliError);
      expect(error).toMatchObject({ code: "WRITE_REQUEST_AMBIGUOUS", candidates: [{ id: "wr_one" }, { id: "wr_two" }] });
    }
  });

  it("emits the stable snake_case local receipt fields", () => {
    expect(toCliWriteRequest({ ...receipt("wr_one"), worktreeId: "wt_example" })).toMatchObject({
      request_id: "wr_one",
      workspace_id: "workspace-1",
      worktree_id: "wt_example",
      files: [{ path: "docs/example.md", action: "update" }],
      created_at: "2026-09-24T00:00:00.000Z",
    });
  });
});

describe("registered write-request CLI commands", () => {
  const root = process.cwd();
  const runtime = {
    service: "chat-to-codex",
    version: "0.2.0",
    workspaceId: "workspace-1",
    workspaceRoot: root,
    pid: process.pid,
    port: 32123,
    adminToken: "local-test-token",
    publicUrl: null,
    startedAt: "2026-09-24T00:00:00.000Z",
  } satisfies RuntimeState;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureBroker.mockResolvedValue(runtime);
    mocks.adminFetch.mockResolvedValue({
      workspaces: [{ id: "workspace-1", displayName: "CLI test", canonicalRoot: root }],
    });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = 0;
  });

  async function runCommand(args: string[]): Promise<string> {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const program = new Command();
    program.exitOverride();
    registerWriteRequestCommands(program);
    await program.parseAsync(["node", "c2c", ...args]);
    return output;
  }

  function mockAdminApi(handler: (url: URL, init?: RequestInit) => unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const data = handler(url, init);
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("requires explicit selection for pending --diff when multiple requests match", async () => {
    const rows = [receipt("wr_one"), receipt("wr_two")];
    const fetchMock = mockAdminApi((url) => {
      expect(url.pathname).toBe("/admin/write-requests");
      return { requests: rows };
    });

    const output = await runCommand(["pending", "--diff", "--json"]);

    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: "WRITE_REQUEST_AMBIGUOUS",
      candidates: [{ request_id: "wr_one" }, { request_id: "wr_two" }],
    });
    expect(process.exitCode).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists pending requests without exposing patch content by default", async () => {
    const fetchMock = mockAdminApi((url) => {
      expect(url.pathname).toBe("/admin/write-requests");
      return { requests: [{ ...receipt("wr_one"), patch: "must not be returned" }] };
    });

    const output = await runCommand(["pending", "--json"]);

    const payload = JSON.parse(output) as { requests: Record<string, unknown>[] };
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0]).toMatchObject({ request_id: "wr_one", status: "pending" });
    expect(payload.requests[0]).not.toHaveProperty("patch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the patch for the single pending request in JSON mode", async () => {
    const fetchMock = mockAdminApi((url) => {
      if (url.pathname === "/admin/write-requests") return { requests: [receipt("wr_one")] };
      expect(url.pathname).toBe("/admin/write-requests/wr_one");
      expect(url.searchParams.get("includePatch")).toBe("true");
      return { ...receipt("wr_one"), patch: "--- a/file.txt\n+++ b/file.txt\n" };
    });

    const output = await runCommand(["pending", "--diff", "--json"]);

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      requests: [{ request_id: "wr_one", patch: "--- a/file.txt\n+++ b/file.txt\n" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("implicitly approves the one cwd-matched request without another prompt", async () => {
    const applied = { ...receipt("wr_one"), status: "applied" };
    mockAdminApi((url, init) => {
      if (url.pathname === "/admin/write-requests") return { requests: [receipt("wr_one")] };
      expect(url.pathname).toBe("/admin/write-requests/wr_one/approve");
      expect(init?.method).toBe("POST");
      return applied;
    });

    const output = await runCommand(["approve", "--json"]);

    expect(JSON.parse(output)).toMatchObject({ ok: true, request: { request_id: "wr_one", status: "applied" } });
    expect(mocks.adminFetch).toHaveBeenCalledWith(runtime, "GET", "/admin/workspaces");
  });

  it("does not implicitly select a pending request for another workspace", async () => {
    const fetchMock = mockAdminApi((url) => {
      expect(url.pathname).toBe("/admin/write-requests");
      expect(url.searchParams.get("workspaceId")).toBe("workspace-1");
      expect(url.searchParams.get("worktreeId")).toBe("");
      return { requests: [] };
    });

    const output = await runCommand(["approve", "--json"]);

    expect(JSON.parse(output)).toMatchObject({ ok: false, error: "WRITE_REQUEST_NOT_FOUND" });
    expect(process.exitCode).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("approves an explicit request id without cwd filtering", async () => {
    const fetchMock = mockAdminApi((url, init) => {
      expect(url.pathname).toBe("/admin/write-requests/wr_two/approve");
      expect(init?.method).toBe("POST");
      return { ...receipt("wr_two"), status: "applied" };
    });

    const output = await runCommand(["approve", "wr_two", "--json"]);

    expect(JSON.parse(output)).toMatchObject({ ok: true, request: { request_id: "wr_two", status: "applied" } });
    expect(mocks.adminFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("implicitly rejects the one cwd-matched request", async () => {
    const fetchMock = mockAdminApi((url, init) => {
      if (url.pathname === "/admin/write-requests") return { requests: [receipt("wr_one")] };
      expect(url.pathname).toBe("/admin/write-requests/wr_one/reject");
      expect(init?.method).toBe("POST");
      return { ...receipt("wr_one"), status: "rejected" };
    });

    const output = await runCommand(["reject", "--json"]);

    expect(JSON.parse(output)).toMatchObject({ ok: true, request: { request_id: "wr_one", status: "rejected" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an explicitly selected request through the broker admin route", async () => {
    const rejected = { ...receipt("wr_two"), status: "rejected" };
    const fetchMock = mockAdminApi((url, init) => {
      expect(url.pathname).toBe("/admin/write-requests/wr_two/reject");
      expect(init?.method).toBe("POST");
      return rejected;
    });

    const output = await runCommand(["reject", "wr_two", "--json"]);

    expect(JSON.parse(output)).toMatchObject({ ok: true, request: { request_id: "wr_two", status: "rejected" } });
    expect(mocks.adminFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
