import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBroker } from "../src/broker/server.js";
import { ensureWorkspaceSession, endWorkspaceSession } from "../src/broker/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import type { WorktreeRunner } from "../src/workspace/worktrees.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

describe("CLI session binding lifecycle", () => {
  it("reuses the registered main workspace for a covered linked worktree", async () => {
    const stateDir = isolateStateDir();
    const main = makeTmpDir("session-linked-main");
    const linked = makeTmpDir("session-linked-root");
    fs.mkdirSync(path.join(main, ".git"));
    dirs.push(main, linked);

    const broker = await startBroker({
      stateDir,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(makeTmpDir("session-linked-auth"), "store.json"),
    });
    try {
      const parent = broker.registry.register({ root: main, displayName: "Main" });
      const repositoryIdentity = path.join(main, ".git");
      const listing = [
        `worktree ${main}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        `worktree ${linked}`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feature/example",
        "",
      ].join("\0");
      const runner: WorktreeRunner = (root, args) => {
        const command = args.join(" ");
        if (command === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n", stderr: "", code: 0 };
        if (command === "worktree list --porcelain -z") return { ok: true, stdout: listing, stderr: "", code: 0 };
        if (command === "rev-parse --show-toplevel") return { ok: true, stdout: `${root}\n`, stderr: "", code: 0 };
        if (command === "rev-parse --git-common-dir") {
          return { ok: true, stdout: `${repositoryIdentity}\n`, stderr: "", code: 0 };
        }
        return { ok: false, stdout: "", stderr: "", code: 1 };
      };

      const { findLiveBridge } = await import("../src/bridge/runtime.js");
      const runtime = await findLiveBridge(broker.installation.installationId);
      if (!runtime) throw new Error("broker runtime not persisted");
      const session = await ensureWorkspaceSession(runtime, linked, {
        stateDir,
        pid: process.pid,
        worktreeRunner: runner,
      });

      expect(session.workspaceId).toBe(parent.id);
      expect(session.worktreeId).toMatch(/^wt-[0-9a-f]{16}$/);
      expect(broker.registry.getByRoot(linked)).toBeNull();
      expect(broker.registry.list()).toHaveLength(1);
      await expect(
        ensureWorkspaceSession(runtime, linked, {
          stateDir,
          displayName: "Do not rename parent",
          worktreeRunner: runner,
        })
      ).rejects.toThrow("--name cannot rename a derived worktree");

      const ended = await endWorkspaceSession(linked, { stateDir });
      expect(ended).toMatchObject({ ended: true, sessionId: session.sessionId });
      expect(broker.sessions.resolve(session.sessionId)).toBeNull();
    } finally {
      await broker.close();
    }
  });

  it("registers only the exact linked root when its main worktree is not registered", async () => {
    const stateDir = isolateStateDir();
    const main = makeTmpDir("session-uncovered-main");
    const linked = makeTmpDir("session-uncovered-linked");
    fs.mkdirSync(path.join(main, ".git"));
    dirs.push(main, linked);

    const broker = await startBroker({
      stateDir,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(makeTmpDir("session-uncovered-auth"), "store.json"),
    });
    try {
      const { findLiveBridge } = await import("../src/bridge/runtime.js");
      const runtime = await findLiveBridge(broker.installation.installationId);
      if (!runtime) throw new Error("broker runtime not persisted");
      const repositoryIdentity = path.join(main, ".git");
      const listing = [
        `worktree ${main}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        `worktree ${linked}`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feature/example",
        "",
      ].join("\0");
      const runner: WorktreeRunner = (root, args) => {
        const command = args.join(" ");
        if (command === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n", stderr: "", code: 0 };
        if (command === "worktree list --porcelain -z") return { ok: true, stdout: listing, stderr: "", code: 0 };
        if (command === "rev-parse --show-toplevel") return { ok: true, stdout: `${root}\n`, stderr: "", code: 0 };
        if (command === "rev-parse --git-common-dir") {
          return { ok: true, stdout: `${repositoryIdentity}\n`, stderr: "", code: 0 };
        }
        return { ok: false, stdout: "", stderr: "", code: 1 };
      };

      const session = await ensureWorkspaceSession(runtime, linked, { stateDir, worktreeRunner: runner });
      const linkedRegistration = broker.registry.getByRoot(linked);
      expect(linkedRegistration).not.toBeNull();
      expect(broker.registry.getByRoot(main)).toBeNull();
      expect(broker.registry.list()).toHaveLength(1);
      expect(session.workspaceId).toBe(linkedRegistration?.id);
      expect(session.worktreeId).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it("endWorkspaceSession removes the binding file and ends the broker session", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("session-cli");
    write(root, "hello.txt", "hello");
    dirs.push(root);

    const broker = await startBroker({
      stateDir,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(makeTmpDir("session-cli-auth"), "store.json"),
    });
    try {
      const { findLiveBridge } = await import("../src/bridge/runtime.js");
      const runtime = await findLiveBridge(broker.installation.installationId);
      if (!runtime) throw new Error("broker runtime not persisted");
      const session = await ensureWorkspaceSession(runtime, root, { stateDir, pid: process.pid });
      expect(broker.sessions.resolve(session.sessionId)).not.toBeNull();

      const bindingFile = path.join(stateDir, "agent-sessions", `${new Workspace(root).id}.json`);
      expect(fs.existsSync(bindingFile)).toBe(true);

      const ended = await endWorkspaceSession(root, { stateDir });
      expect(ended.ended).toBe(true);
      expect(ended.sessionId).toBe(session.sessionId);
      expect(fs.existsSync(bindingFile)).toBe(false);
      expect(broker.sessions.resolve(session.sessionId)).toBeNull();
    } finally {
      await broker.close();
    }
  });
});
