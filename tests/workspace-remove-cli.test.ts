import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { RuntimeState } from "../src/bridge/runtime.js";

const mocks = vi.hoisted(() => ({
  ensureBroker: vi.fn(),
  adminFetch: vi.fn(),
}));

vi.mock("../src/broker/daemon.js", () => ({ ensureBroker: mocks.ensureBroker }));
vi.mock("../src/process/daemon.js", () => ({ adminFetch: mocks.adminFetch }));

import { registerWorkspaceRemoveCommand } from "../src/cli/workspace-remove.js";

const projectRoot = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const runtime = {
  service: "chat-to-codex",
  version: "0.2.0",
  workspaceId: "installation-1",
  workspaceRoot: projectRoot,
  pid: process.pid,
  port: 32123,
  adminToken: "local-test-token",
  publicUrl: null,
  startedAt: "2026-10-06T00:00:00.000Z",
} satisfies RuntimeState;

async function runCommand(args: string[]): Promise<string> {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const program = new Command();
  program.exitOverride();
  registerWorkspaceRemoveCommand(program);
  await program.parseAsync(["node", "c2c", ...args]);
  return output;
}

describe("workspace remove CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureBroker.mockResolvedValue(runtime);
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("removes an explicit workspace id without resolving cwd", async () => {
    mocks.adminFetch.mockResolvedValue({ removed: true, sessionsEnded: 2 });

    const output = await runCommand(["remove", "workspace-explicit", "--json"]);

    expect(JSON.parse(output)).toEqual({
      ok: true,
      workspaceId: "workspace-explicit",
      removed: true,
      sessionsEnded: 2,
    });
    expect(mocks.adminFetch).toHaveBeenCalledTimes(1);
    expect(mocks.adminFetch).toHaveBeenCalledWith(
      runtime,
      "POST",
      "/admin/workspace/remove",
      60_000,
      { id: "workspace-explicit" }
    );
  });

  it("resolves the containing registered target when no id is supplied", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(path.join(projectRoot, "src"));
    mocks.adminFetch.mockImplementation(async (_runtime: RuntimeState, method: string, route: string) => {
      if (method === "GET" && route === "/admin/workspaces") {
        return {
          workspaces: [{ id: "workspace-current", displayName: "Current", canonicalRoot: projectRoot }],
        };
      }
      if (method === "POST" && route === "/admin/workspace/remove") {
        return { removed: true, sessionsEnded: 0 };
      }
      throw new Error(`Unexpected admin call: ${method} ${route}`);
    });

    const output = await runCommand(["remove", "--json"]);

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      workspaceId: "workspace-current",
      removed: true,
      sessionsEnded: 0,
    });
    expect(mocks.adminFetch).toHaveBeenNthCalledWith(1, runtime, "GET", "/admin/workspaces");
    expect(mocks.adminFetch).toHaveBeenNthCalledWith(
      2,
      runtime,
      "POST",
      "/admin/workspace/remove",
      60_000,
      { id: "workspace-current" }
    );
  });

  it("fails closed when cwd is outside every registered target", async () => {
    mocks.adminFetch.mockResolvedValue({ workspaces: [] });

    const output = await runCommand(["remove", "--json"]);

    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: "Current directory is not inside a registered workspace or valid linked worktree.",
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.adminFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a non-zero failure for an unknown explicit workspace id", async () => {
    mocks.adminFetch.mockResolvedValue({ removed: false, sessionsEnded: 0 });

    const output = await runCommand(["remove", "missing-workspace", "--json"]);

    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: "Workspace is not registered: missing-workspace",
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.adminFetch).toHaveBeenCalledTimes(1);
  });
});
