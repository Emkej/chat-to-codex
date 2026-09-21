import { describe, expect, it, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorktreeRunner, worktreeIdFor } from "../src/workspace/worktrees.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const clients: Client[] = [];
const servers: Awaited<ReturnType<typeof createMcpServer>>[] = [];
const dirs: string[] = [];

function result(stdout = ""): { ok: true; stdout: string; stderr: string; code: number } {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function jsonOf<T>(result: { content?: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content?.[0]?.text ?? "") as T;
}

async function connectServer(ctx: Parameters<typeof createMcpServer>[0]): Promise<Client> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-worktree-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  servers.push(server);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

describe("MCP worktree routing", () => {
  it("lists opaque derived targets and selects them without exposing paths", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const main = makeTmpDir("mcp-worktree-main");
    const linked = makeTmpDir("mcp-worktree-linked");
    dirs.push(main, linked);
    makeGitRepo(main);
    write(main, "main-marker.txt", "main-only\n");
    write(linked, "linked-marker.txt", "linked-only\n");
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const worktreeId = worktreeIdFor(repositoryIdentity, linked);
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${linked}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/example",
    ].join("\0");
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
      if (args.join(" ") === "rev-parse --git-common-dir") return result(`${repositoryIdentity}\n`);
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    const registry = WorkspaceRegistry.load(stateDir);
    const registration = registry.register({ root: main, displayName: "Main" });
    const client = await connectServer({ registry, worktreeRunner: runner, logger: nullLogger });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("list_worktrees");

    const listed = jsonOf<{ worktrees: { worktree_id: string; branch: string | null; commit: string }[] }>(
      await client.callTool({ name: "list_worktrees", arguments: { workspace: registration.id } })
    );
    expect(listed.worktrees).toEqual([
      { worktree_id: worktreeId, branch: "feature/example", commit: "2222222222222222222222222222222222222222" },
    ]);
    const listedText = JSON.stringify(listed);
    expect(listedText).not.toContain(main);
    expect(listedText).not.toContain(linked);

    const info = jsonOf<{ workspaceId: string; worktreeId: string; workspaceName: string }>(
      await client.callTool({
        name: "workspace_info",
        arguments: { workspace: registration.id, worktree: worktreeId },
      })
    );
    expect(info).toMatchObject({ workspaceId: registration.id, worktreeId, workspaceName: "Main" });

    const selected = jsonOf<{ content: string }>(
      await client.callTool({
        name: "read_file",
        arguments: { workspace: registration.id, worktree: worktreeId, path: "linked-marker.txt" },
      })
    );
    expect(selected.content).toContain("linked-only");

    write(linked, ".env", "LINKED_SECRET=do-not-return\n");
    const traversal = await client.callTool({
      name: "read_file",
      arguments: { workspace: registration.id, worktree: worktreeId, path: "../main-marker.txt" },
    });
    expect(jsonOf<{ error: string }>(traversal).error).toBe("PATH_OUTSIDE_WORKSPACE");

    const sensitive = await client.callTool({
      name: "read_file",
      arguments: { workspace: registration.id, worktree: worktreeId, path: ".env" },
    });
    expect(jsonOf<{ error: string }>(sensitive).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const invented = await client.callTool({
      name: "read_file",
      arguments: { workspace: registration.id, worktree: "wt-invented", path: "main-marker.txt" },
    });
    expect(invented.isError).toBe(true);
    expect(jsonOf<{ error: string }>(invented).error).toBe("UNKNOWN_WORKTREE");
    expect(JSON.stringify(invented)).not.toContain(main);
    expect(JSON.stringify(invented)).not.toContain(linked);
  });

  it("sanitizes unexpected MCP errors without returning local details", async () => {
    const fakePath = "/private/c2c/unexpected/secret-worktree";
    const rawMessage = `unexpected filesystem failure at ${fakePath}`;
    const workspace = {
      id: "unexpected-error-workspace",
      name: "Unexpected error workspace",
      root: fakePath,
      detectProject: () => {
        throw new Error(rawMessage);
      },
    } as unknown as Workspace;
    const client = await connectServer({ workspace, logger: nullLogger });

    const response = await client.callTool({ name: "workspace_info", arguments: {} });
    const payload = jsonOf<{ error: string; message: string }>(response);
    expect(response.isError).toBe(true);
    expect(payload).toEqual({ error: "INTERNAL_ERROR", message: "An unexpected internal error occurred." });
    expect(JSON.stringify(response)).not.toContain(fakePath);
    expect(JSON.stringify(response)).not.toContain(rawMessage);
  });

  it("routes selected search, Git, and execution reads to the concrete worktree", async () => {
    const stateDir = isolateStateDir();
    const base = makeTmpDir("mcp-selected-readers");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    fs.mkdirSync(main, { recursive: true });
    makeGitRepo(main);
    let linkedAdded = false;
    dirs.push(stateDir, base);

    try {
      git(main, "worktree", "add", "-b", "selected", linked);
      linkedAdded = true;
      write(linked, "selected-note.txt", "needle in selected worktree\n");
      write(linked, "hello.txt", "selected change\n");

      const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
      const mainCommit = git(main, "rev-parse", "HEAD").trim();
      const linkedCommit = git(linked, "rev-parse", "HEAD").trim();
      const output = [
        `worktree ${main}`,
        `HEAD ${mainCommit}`,
        "branch refs/heads/main",
        "",
        `worktree ${linked}`,
        `HEAD ${linkedCommit}`,
        "branch refs/heads/selected",
        "",
      ].join("\0");
      const runner: WorktreeRunner = (root, args) => {
        const command = args.join(" ");
        if (command === "rev-parse --is-inside-work-tree") return result("true\n");
        if (command === "worktree list --porcelain -z") return result(output);
        if (command === "rev-parse --show-toplevel") return result(`${root}\n`);
        if (command === "rev-parse --git-common-dir") return result(`${repositoryIdentity}\n`);
        return { ok: false, stdout: "", stderr: "", code: 1 };
      };

      const registry = WorkspaceRegistry.load(stateDir);
      const registration = registry.register({ root: main, displayName: "Main" });
      const worktreeId = worktreeIdFor(repositoryIdentity, linked);
      appendExecutionRecord(new Workspace(main).id, {
        taskId: "main-record",
        iteration: 1,
        changedFiles: [],
        tests: "main",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
      appendExecutionRecord(new Workspace(linked).id, {
        taskId: "linked-record",
        iteration: 2,
        changedFiles: ["hello.txt"],
        tests: "linked",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });

      const client = await connectServer({ registry, worktreeRunner: runner, logger: nullLogger });
      const search = jsonOf<{ matches: { path: string }[] }>(
        await client.callTool({
          name: "search_workspace",
          arguments: { workspace: registration.id, worktree: worktreeId, query: "needle" },
        })
      );
      expect(search.matches.map((match) => match.path)).toContain("selected-note.txt");

      const status = jsonOf<{ untracked: string[] }>(
        await client.callTool({ name: "git_status", arguments: { workspace: registration.id, worktree: worktreeId } })
      );
      expect(status.untracked).toContain("selected-note.txt");

      const diff = jsonOf<{ diff: string }>(
        await client.callTool({ name: "git_diff", arguments: { workspace: registration.id, worktree: worktreeId } })
      );
      expect(diff.diff).toContain("selected change");

      const selectedStatus = jsonOf<{ taskId: string }>(
        await client.callTool({ name: "test_status", arguments: { workspace: registration.id, worktree: worktreeId } })
      );
      expect(selectedStatus.taskId).toBe("linked-record");
      const selectedSummary = jsonOf<{ records: { taskId: string }[] }>(
        await client.callTool({ name: "execution_summary", arguments: { workspace: registration.id, worktree: worktreeId } })
      );
      expect(selectedSummary.records.map((record) => record.taskId)).toEqual(["linked-record"]);
    } finally {
      if (linkedAdded) git(main, "worktree", "remove", "--force", linked);
    }
  });

  it("keeps the legacy bridge exact-root-only and at nine tools", async () => {
    const root = makeTmpDir("mcp-legacy-root");
    dirs.push(root);
    write(root, "hello.txt", "hello\n");
    const client = await connectServer({ workspace: new Workspace(root), logger: nullLogger });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((tool) => tool.name)).not.toContain("list_worktrees");

    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.txt", worktree: "wt-invented" },
    });
    expect(result.isError).toBe(true);
    expect(jsonOf<{ error: string }>(result).error).toBe("WORKTREE_UNSUPPORTED");
  });

  it("fails closed when the selected worktree changes identity before routing use", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const main = makeTmpDir("mcp-worktree-race-main");
    const linked = makeTmpDir("mcp-worktree-race-linked");
    const replacementIdentity = makeTmpDir("mcp-worktree-race-replacement");
    dirs.push(main, linked, replacementIdentity);
    makeGitRepo(main);
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const worktreeId = worktreeIdFor(repositoryIdentity, linked);
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${linked}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/example",
    ].join("\0");
    let linkedIdentityChecks = 0;
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
      if (args.join(" ") === "rev-parse --git-common-dir") {
        if (root === main) return result(`${repositoryIdentity}\n`);
        linkedIdentityChecks += 1;
        return result(`${linkedIdentityChecks === 1 ? repositoryIdentity : replacementIdentity}\n`);
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };
    const registry = WorkspaceRegistry.load(stateDir);
    const registration = registry.register({ root: main, displayName: "Main" });
    const client = await connectServer({ registry, worktreeRunner: runner, logger: nullLogger });

    const routed = await client.callTool({
      name: "read_file",
      arguments: { workspace: registration.id, worktree: worktreeId, path: "linked-marker.txt" },
    });
    expect(routed.isError).toBe(true);
    expect(jsonOf<{ error: string }>(routed).error).toBe("UNKNOWN_WORKTREE");
    expect(linkedIdentityChecks).toBe(2);
    expect(JSON.stringify(routed)).not.toContain(main);
    expect(JSON.stringify(routed)).not.toContain(linked);
  });
});
