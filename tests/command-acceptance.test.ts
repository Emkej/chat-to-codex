import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { runCommand } from "../src/command-requests/runner.js";
import { CommandRequestService } from "../src/command-requests/service.js";
import { CommandRequestStore } from "../src/command-requests/store.js";
import { WINDOW_MS } from "../src/command-requests/types.js";
import { readLinuxProcessIdentity, signalLinuxProcessIdentity } from "../src/broker/process-identity.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir } from "./helpers.js";

async function fixture() {
  const root = makeTmpDir("command-acceptance"), store = new CommandRequestStore(makeTmpDir("command-retention"));
  let now = Date.now();
  const options = { store, now: () => now, resolveTarget: () => ({ workspaceId: "one", workspace: new Workspace(root) }) };
  const service = new CommandRequestService(options); await service.initialize();
  const create = () => service.create({ workspaceId: "one", argv: [process.execPath, "-e", ""], reason: "acceptance" });
  return { root, store, options, service, create, advance: (ms: number) => { now += ms; } };
}

describe.skipIf(process.platform !== "linux")("Linux command acceptance", () => {
  it.each(["timeout", "shutdown", "immediate"])("performs bounded real %s cleanup with a verified pidfd", async (mode) => {
    const run = runCommand([process.execPath, "-e", "setInterval(()=>{}, 1000)"], makeTmpDir("command-live"), { timeoutMs: mode === "timeout" ? 200 : 5000 });
    const before = Date.now();
    if (mode === "immediate") await run.interrupt("BROKER_SHUTDOWN");
    else {
      expect(await run.started).not.toBeNull();
      if (mode === "shutdown") await run.interrupt("BROKER_SHUTDOWN");
    }
    const result = await run.done;
    expect(result.status).toBe("interrupted");
    expect(result.resolutionCode).toBe(mode === "timeout" ? "COMMAND_TIMEOUT" : "BROKER_SHUTDOWN");
    expect(["group", "leader"]).toContain(result.result.termination);
    expect(Date.now() - before).toBeLessThan(5000);
    // The real process may deliver spawn and both natural EOFs while pidfd cleanup
    // is awaited. In that case complete capture is valid even for immediate stop.
  });

  it("records a signal separately from an exit code", async () => {
    const run = runCommand([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], makeTmpDir("command-signal"));
    const result = await run.done;
    expect(result).toMatchObject({ status: "completed", result: { exitCode: null, signal: "SIGTERM", outputIncomplete: false } });
  });

  it("terminates a live inherited process group when the kernel supports it", async () => {
    const root = makeTmpDir("command-group"), marker = path.join(root, "child-pid");
    const source = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
    const run = runCommand([process.execPath, "-e", source], root, { timeoutMs: 700 });
    await run.started;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    const pid = Number(fs.readFileSync(marker, "utf8")), identity = readLinuxProcessIdentity(pid);
    expect(identity.kind).toBe("present");
    try {
      const result = await run.done;
      expect(result.status).toBe("interrupted");
      expect(["group", "leader"]).toContain(result.result.termination);
      if (result.result.termination === "group") {
        await vi.waitFor(() => {
          const stat = `/proc/${pid}/stat`;
          // Orphan zombies are already terminated; reaping belongs to init.
          let text: string;
          try { text = fs.readFileSync(stat, "utf8"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          expect(text.slice(text.lastIndexOf(")") + 1).trim().startsWith("Z ")).toBe(true);
        });
      }
    } finally {
      if (identity.kind === "present") await signalLinuxProcessIdentity(identity.identity);
    }
  });

  it("retains real descendant output after leader exit and bounds descendant-held pipes", async () => {
    for (const held of [false, true]) {
      const root = makeTmpDir("command-descendant"), marker = path.join(root, "leader-exited");
      // Descendant exits itself; no numeric process-group cleanup is used by the test.
      const descendant = `setTimeout(()=>{console.log('late');process.exit(0)}, ${held ? 1000 : 250})`;
      const source = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]}).unref();require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`;
      const run = runCommand([process.execPath, "-e", source], root, { timeoutMs: held ? 400 : 3000 });
      await run.started;
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
      const result = await run.done;
      if (held) expect(result).toMatchObject({ status: "interrupted", resolutionCode: "COMMAND_TIMEOUT", result: { exitCode: 0, outputIncomplete: true, termination: "absent" } });
      else expect(result).toMatchObject({ status: "completed", result: { exitCode: 0, stdout: "late\n", outputIncomplete: false } });
    }
  });

  it("reconciles a real surviving leader using only restart leader signaling, without respawn", async () => {
    const f = await fixture(), record = await f.create();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const identity = readLinuxProcessIdentity(child.pid!);
    expect(identity.kind).toBe("present");
    if (identity.kind !== "present") throw new Error("No leader identity");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      f.store.update({ ...record, status: "running", leader: identity.identity });
      const spawnProcess = vi.fn();
      const restarted = new CommandRequestService({ ...f.options, runnerOptions: { spawnProcess } });
      await restarted.initialize();
      expect(restarted.get(record.id)).toMatchObject({ status: "interrupted", resolutionCode: "BROKER_RESTART", result: { termination: "leader", outputIncomplete: true } });
      expect(spawnProcess).not.toHaveBeenCalled();
      await exited;
    } finally { await signalLinuxProcessIdentity(identity.identity); child.unref(); }
  });

  it.each(["startup", "create", "approve", "reject", "terminal"])("prunes unavailable terminal bytes at %s, while reads stay observational", async (trigger) => {
    const f = await fixture(), old = await f.create(), next = await f.create();
    await f.service.reject(old.id);
    const file = path.join(f.store.directory, old.id + ".json"), bytes = fs.readFileSync(file);
    // Keep the operation target pending across the retention cutoff.
    f.store.update({ ...next, expiresAt: new Date(Date.parse(next.expiresAt) + WINDOW_MS).toISOString() });
    if (trigger === "terminal") {
      f.store.update({ ...next, argv: [process.execPath, "-e", "setTimeout(()=>{},150)"] });
      await f.service.approve(next.id);
    }
    f.advance(WINDOW_MS - 1); expect(f.service.get(old.id).status).toBe("rejected");
    f.advance(1);
    expect(() => f.service.get(old.id)).toThrow(expect.objectContaining({ code: "COMMAND_RESULT_UNAVAILABLE" }));
    f.service.listPending(); expect(fs.readFileSync(file)).toEqual(bytes);
    if (trigger === "startup") await new CommandRequestService(f.options).initialize();
    if (trigger === "create") await f.create();
    if (trigger === "approve") await f.service.approve(next.id);
    if (trigger === "reject") await f.service.reject(next.id);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
    await f.service.close();
  });
});
