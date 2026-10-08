import { Command } from "commander";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { registerWriteRequestCommands } from "../src/cli/write-requests.js";
import { describeCommand } from "../src/cli/command-requests.js";
import { terminalSafeJson } from "../src/terminal/escape.js";
import type { CommandReceipt } from "../src/command-requests/receipt.js";

const mocks = vi.hoisted(() => ({ ensureBroker: vi.fn(), adminFetch: vi.fn() }));
vi.mock("../src/broker/daemon.js", () => ({ ensureBroker: mocks.ensureBroker }));
vi.mock("../src/process/daemon.js", () => ({ adminFetch: mocks.adminFetch }));
const id = "cr_" + "a".repeat(24), root = process.cwd();
const record: CommandReceipt = {
  request_id: id, status: "pending", workspace_id: "ws-one", argv: ["node", "a b", "$(bad);\x1b[31m", "literal\\u001b", "\x9b31m\u202eevil"],
  cwd: ".", reason: "inspect\x1b]0;evil\x07", created_at: "2026-10-08T00:00:00Z", expires_at: "2026-10-08T01:00:00Z",
};
let output: string;
beforeEach(() => {
  vi.clearAllMocks(); output = ""; process.exitCode = 0;
  mocks.ensureBroker.mockResolvedValue({ port: 32123, adminToken: "test" });
  mocks.adminFetch.mockResolvedValue({ workspaces: [{ id: "ws-one", canonicalRoot: root, displayName: "test" }] });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });
async function run(...args: string[]) {
  const program = new Command(); program.exitOverride(); registerWriteRequestCommands(program);
  await program.parseAsync(["node", "c2c", ...args]); return output;
}
function mockFetch(handler: (url: URL, init: RequestInit | undefined) => unknown) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const result = handler(new URL(input), init);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  }); vi.stubGlobal("fetch", fetchMock); return fetchMock;
}

describe("explicit command CLI routing and safe display", () => {
  it("mixes commands with unchanged patch summaries for the concrete cwd target", async () => {
    mockFetch((url) => {
      expect(url.searchParams.get("workspaceId")).toBe("ws-one"); expect(url.searchParams.get("worktreeId")).toBe("");
      return { requests: url.pathname === "/admin/command-requests" ? [record] : [] };
    });
    const text = await run("pending");
    expect(text).toContain(`${id}  command  pending  ws-one`); expect(text).toContain("cwd: ."); expect(text).toContain("argv:");
    expect(text).not.toMatch(/[\x1b\x07\x9b\u202e]/u); expect(text).toContain("\\u{009b}");
  });
  it("shows full argument-by-argument detail and safely escaped reason", async () => {
    mockFetch((url) => { expect(url.pathname).toBe(`/admin/command-requests/${id}`); return record; });
    const text = await run("pending", id);
    for (let i = 0; i < record.argv.length; i++) expect(text).toContain(`argv[${i}]:`);
    expect(text).toContain('argv[1]: "a b"'); expect(text).toContain("reason:"); expect(text).toContain("created:");
    expect(text).not.toMatch(/[\x1b\x07\x9b\u202e]/u); expect(mocks.adminFetch).not.toHaveBeenCalled();
  });
  it("requires --output and returns safe, roundtrippable JSON including Unicode controls", async () => {
    const terminal = { ...record, status: "completed", stdout: "secret\x1b[31m\n\x9b32m\u202e", stderr: "\x07", output_incomplete: false };
    mockFetch((url) => { expect(url.searchParams.get("output")).toBe("true"); return terminal; });
    const text = await run("pending", id, "--output", "--json");
    expect(text).not.toMatch(/[\x1b\x07\x9b\u202e]/u); expect(JSON.parse(text).requests[0].stdout).toBe(terminal.stdout);
    expect(JSON.parse(terminalSafeJson({ argv: record.argv })).argv).toEqual(record.argv);
  });
  it("does not request output by default and rejects patch-only --diff for commands", async () => {
    const fetchMock = mockFetch((url) => { expect(url.search).toBe(""); return record; });
    await run("pending", id); expect(fetchMock).toHaveBeenCalledTimes(1);
    output = ""; await run("pending", id, "--diff", "--json");
    expect(JSON.parse(output).error).toBe("COMMAND_INVALID"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["approve", "reject"])("%s explicit cr_ id sends one exact POST without extra confirmation", async (action) => {
    const fetchMock = mockFetch((url, init) => {
      expect(url.pathname).toBe(`/admin/command-requests/${id}/${action}`); expect(init?.method).toBe("POST");
      return { ...record, status: action === "approve" ? "running" : "rejected", started_at: action === "approve" ? "now" : undefined };
    });
    const text = await run(action, id);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(mocks.adminFetch).not.toHaveBeenCalled();
    if (action === "approve") expect(text).toContain(`Started ${id}`);
  });
  it.each(["approve", "reject"])("no-id %s never selects a command", async (action) => {
    const fetchMock = mockFetch((url) => {
      expect(url.pathname).toBe("/admin/write-requests"); return { requests: [] };
    });
    await run(action, "--json"); expect(JSON.parse(output).error).toBe("WRITE_REQUEST_NOT_FOUND"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a lost approval response is unknown, never retried, and explicit inspection reconciles", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("fetch failed after dispatch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...record, status: "running", started_at: "now" })));
    vi.stubGlobal("fetch", fetchMock);
    await run("approve", id, "--json");
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: "COMMAND_APPROVAL_UNKNOWN", message: expect.stringContaining(id) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    output = ""; await run("pending", id, "--json");
    expect(JSON.parse(output).requests[0].status).toBe("running"); expect(fetchMock.mock.calls[1]![1].method).toBe("GET");
  });
  it.each(["broken json", "null", "{}"])("an invalid successful approval response (%s) is also unknown", async (body) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    await run("approve", id, "--json"); expect(JSON.parse(output).error).toBe("COMMAND_APPROVAL_UNKNOWN"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["SIGINT", "SIGTERM"] as const)("%s during a dispatched approval reports unknown without retry or leaked signal handlers", async (signal) => {
    const before = process.listenerCount(signal);
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      queueMicrotask(() => process.emit(signal));
    })); vi.stubGlobal("fetch", fetchMock);
    await run("approve", id, "--json");
    expect(JSON.parse(output).error).toBe("COMMAND_APPROVAL_UNKNOWN"); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.listenerCount(signal)).toBe(before);
  });
  it("patch-only brokers retain pending discovery when command capability is absent", async () => {
    mockFetch((url) => url.pathname === "/admin/command-requests" ? new Response("", { status: 404 }) : { requests: [] });
    await run("pending", "--json"); expect(JSON.parse(output)).toEqual({ ok: true, requests: [] });
  });
  it("text output retains line boundaries but cannot execute terminal controls", () => {
    describeCommand({ ...record, stdout: "a\n\x1b[31m\x07\u202e", stderr: "b", output_incomplete: true }, true, true);
    expect(output).toContain("a\n\\u{001b}"); expect(output).not.toMatch(/[\x1b\x07\u202e]/u);
  });
});
