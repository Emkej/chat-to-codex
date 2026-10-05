import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverDerivedWorktreesAsync } from "../src/workspace/worktree-read.js";
import { discoverDerivedWorktrees } from "../src/workspace/worktrees.js";
import { ManagerController } from "../src/manager/controller.js";
import { managerServices } from "../src/manager/services.js";
import { git, makeGitRepo, makeTmpDir } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());

function read(root: string, options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return discoverDerivedWorktreesAsync(root, { signal: options.signal ?? new AbortController().signal, timeoutMs: options.timeoutMs ?? 5_000, maxOutputBytes: options.maxOutputBytes, resolution: { allowCrossNamespace: true, wslDistro: "Ubuntu" } });
}

function command(dir: string, name: string, source: string) {
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test process.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("asynchronous canonical worktree reads", () => {
  it("matches synchronous ownership results for attached and detached worktrees", async () => {
    const base = makeTmpDir("async-worktrees");
    const main = path.join(base, "main");
    fs.mkdirSync(main);
    makeGitRepo(main);
    git(main, "worktree", "add", "-b", "feature/async", path.join(base, "attached"));
    git(main, "worktree", "add", "--detach", path.join(base, "detached"));
    const expected = discoverDerivedWorktrees(main);
    expect(await read(main)).toEqual(expected);
    expect(expected.map((entry) => entry.branch)).toEqual(["feature/async", null]);
    await expect(read(path.join(base, "attached"))).rejects.toThrow();
  });

  it("distinguishes an empty Git inventory from missing and non-Git roots", async () => {
    const root = makeTmpDir("async-empty");
    await expect(read(root)).rejects.toThrow();
    await expect(read(path.join(root, "missing"))).rejects.toThrow();
    makeGitRepo(root);
    expect(await read(root)).toEqual([]);
  });

  it("uses asynchronous WSL conversion and rejects invalid pointer ownership", async () => {
    const base = makeTmpDir("async-wsl");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    fs.mkdirSync(main); fs.mkdirSync(linked);
    makeGitRepo(main);
    const identity = path.join(main, ".git");
    const admin = path.join(identity, "worktrees", "linked");
    fs.mkdirSync(admin, { recursive: true });
    const windowsRoot = "C:/test/linked";
    const output = [`worktree ${main}`, "HEAD 111", "branch refs/heads/main", "", `worktree ${windowsRoot}`, "HEAD 222", "branch refs/heads/linked", "prunable unavailable", ""].join("\0");
    command(base, "wslpath", `process.stdout.write(${JSON.stringify(linked)});`);
    command(base, "git", `
      const args = process.argv.slice(2);
      const explicit = args.includes('--git-dir');
      const cmd = args.slice(explicit ? 4 : 0).join(' ');
      const root = process.cwd();
      let output = '';
      if (cmd === 'rev-parse --is-inside-work-tree') output = 'true';
      else if (cmd.startsWith('worktree list')) output = ${JSON.stringify(output)};
      else if (cmd === 'rev-parse --show-toplevel') output = root;
      else if (cmd === 'rev-parse --git-common-dir') output = ${JSON.stringify(identity)};
      else process.exit(1);
      process.stdout.write(output);
    `);
    vi.stubEnv("PATH", `${base}:${process.env.PATH}`);
    const setPointers = (forward: string, reverse: string) => {
      fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${forward}\n`);
      fs.writeFileSync(path.join(admin, "gitdir"), `${reverse}\n`);
    };
    setPointers(`//wsl$/Ubuntu${admin}`, `//wsl$/Ubuntu${linked}/.git`);
    const [candidate] = await read(main);
    expect(candidate).toMatchObject({ root: linked, gitDir: admin, branch: "linked", commit: "222" });
    for (const [forward, reverse] of [
      [`//wsl$/Other${admin}`, `//wsl$/Ubuntu${linked}/.git`],
      [admin, `${linked}/.git`],
      [`//wsl$/Ubuntu${admin}`, `//wsl$/Other${linked}/.git`],
      [`//wsl$/Ubuntu${admin}`, `//wsl$/Ubuntu${main}/.git/config`],
      [`//wsl$/Ubuntu${identity}`, `//wsl$/Ubuntu${linked}/.git`],
    ]) {
      setPointers(forward, reverse);
      expect(await read(main)).toEqual([]);
    }
    fs.rmSync(path.join(linked, ".git"));
    expect(await read(main)).toEqual([]);
  });

  it.each(["cancel", "deadline"] as const)("reaps a real slow command and its child on %s", async (mode) => {
    const root = makeTmpDir("async-slow");
    const marker = path.join(root, "pids.json");
    command(root, "git", `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.on('SIGTERM', () => {});
      child.on('exit', () => fs.writeFileSync(${JSON.stringify(marker + ".reaped")}, 'yes'));
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    const controller = new AbortController();
    const started = Date.now();
    const result = read(root, { signal: controller.signal, timeoutMs: mode === "deadline" ? 400 : 5_000 });
    const rejection = expect(result).rejects.toThrow();
    await until(() => fs.existsSync(marker));
    const [parent, child] = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (mode === "cancel") controller.abort();
    await rejection;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(alive(parent)).toBe(false);
    expect(alive(child)).toBe(false);
    expect(fs.existsSync(marker + ".reaped")).toBe(true);
  });

  it("bounds the entire read across commands and rejects excessive output", async () => {
    const root = makeTmpDir("async-total-budget");
    makeGitRepo(root);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    command(root, "git", `setTimeout(() => { const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { encoding: 'utf8' }); process.stdout.write(result.stdout || ''); process.exit(result.status ?? 1); }, 150);`);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    await expect(read(root, { timeoutMs: 350 })).rejects.toThrow();
    command(root, "git", "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000);");
    await expect(read(root, { maxOutputBytes: 1024 })).rejects.toThrow("output limit");
  });

  it("keeps the Manager foreground guard until the real cancelled command is reaped", async () => {
    const root = makeTmpDir("async-manager-guard");
    const marker = path.join(root, "pid");
    command(root, "git", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    const restart = vi.fn();
    const controller = new ManagerController({ ...managerServices,
      readStatus: async () => ({ installation: { state: "ready", id: "c2c_inst_test", version: "0.2.0", profile: null }, broker: { state: "running" }, authorization: { state: "unknown" }, tunnel: { state: "stopped", provider: null, preference: "unset" }, workspaces: [{ id: "test", name: "Test", liveSessionCount: null }], observedAt: new Date().toISOString() }),
      readInstruction: () => ({ kind: "none" }), restartBroker: restart,
      readWorkspaceDetail: async (_id, { signal }) => read(root, { signal }),
    });
    try {
      await controller.refresh();
      const opening = controller.openWorkspaceDetail();
      await until(() => fs.existsSync(marker));
      const pid = Number(fs.readFileSync(marker, "utf8"));
      controller.closeWorkspaceDetail();
      expect(controller.getSnapshot().activeAction).toBe("detail");
      expect(alive(pid)).toBe(true);
      expect(await controller.perform("restart")).toBe(false);
      expect(restart).not.toHaveBeenCalled();
      await opening;
      expect(alive(pid)).toBe(false);
      expect(controller.getSnapshot().activeAction).toBeNull();
      expect(controller.getSnapshot().workspaceDetail).toBeNull();
    } finally { controller.close(); }
  });
});
