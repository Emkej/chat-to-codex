import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { CommandRequestStore } from "../src/command-requests/store.js";
import { CommandRequestService } from "../src/command-requests/service.js";
import { runCommand, type RunnerOptions } from "../src/command-requests/runner.js";
import { OUTPUT_BYTES, WINDOW_MS } from "../src/command-requests/types.js";
import { utf8Tail } from "../src/command-requests/output.js";
import { makeTmpDir } from "./helpers.js";

async function fixture(extra: { now?: () => number; runnerOptions?: RunnerOptions } = {}) {
  const root = makeTmpDir("command-workspace"), state = makeTmpDir("commands-state");
  const store = new CommandRequestStore(state);
  const resolveTarget = vi.fn((workspaceId: string, worktreeId?: string) => ({ workspaceId, worktreeId, workspace: new Workspace(root) }));
  const service = new CommandRequestService({ store, resolveTarget, ...extra });
  await service.initialize();
  const create = (argv = [process.execPath, "-e", "process.stdout.write('ok')"]) => service.create({ workspaceId: "ws-one", argv, reason: "validation" });
  return { root, state, store, service, create, resolveTarget };
}
async function terminal(service: CommandRequestService, id: string) {
  await vi.waitFor(() => expect(service.get(id).status).not.toBe("running"), { timeout: 5000, interval: 10 });
  return service.get(id);
}
function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
  return { child, spawnProcess: vi.fn(() => child as unknown as ChildProcess) };
}

describe("command domain and exact runner", () => {
  it("creation does not execute; records are owner-only and immutable copies", async () => {
    const f = await fixture();
    const marker = path.join(f.root, "executed");
    const argv = [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`];
    const r = await f.create(argv); argv[0] = "changed"; r.argv[1] = "changed";
    expect(fs.existsSync(marker)).toBe(false);
    expect(f.service.get(r.id).argv[0]).toBe(process.execPath);
    expect(fs.statSync(f.store.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.store.directory, r.id + ".json")).mode & 0o777).toBe(0o600);
    await f.service.approve(r.id); await terminal(f.service, r.id);
    expect(fs.readFileSync(marker, "utf8")).toBe("yes");
  });
  it("preserves literal argv boundaries, no stdin/TTY, and nonzero outcomes", async () => {
    const f = await fixture();
    const args = ["a b", "$(touch injected)", "semi;colon", "", "quote'\"", "λ"];
    const r = await f.create([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1))); console.error(String(process.stdin.isTTY)); process.stdin.on('end',()=>process.exit(3)); process.stdin.resume()", ...args]);
    const started = await f.service.approve(r.id);
    expect(started.status).toBe("running"); expect(started.startedAt).toBeDefined();
    const done = await terminal(f.service, r.id);
    expect(done.status).toBe("completed"); expect(done.result?.exitCode).toBe(3);
    expect(JSON.parse(done.result!.stdout)).toEqual(args);
    expect(done.result!.stderr.trim()).toBe("undefined"); expect(done.result!.outputIncomplete).toBe(false);
  });
  it("drains multi-MiB output and retains bounded independent tails", async () => {
    const f = await fixture();
    const r = await f.create([process.execPath, "-e", "process.stdout.write('a'.repeat(4*1024*1024)+'OUT'); process.stderr.write('b'.repeat(3*1024*1024)+'ERR')"]);
    await f.service.approve(r.id);
    const done = await terminal(f.service, r.id), out = done.result!;
    expect(Buffer.byteLength(out.stdout)).toBe(OUTPUT_BYTES); expect(out.stdout.endsWith("OUT")).toBe(true);
    expect(Buffer.byteLength(out.stderr)).toBe(OUTPUT_BYTES); expect(out.stderr.endsWith("ERR")).toBe(true);
    expect(out.stdoutTruncated && out.stderrTruncated).toBe(true); expect(out.outputIncomplete).toBe(false);
  });
  it("durably claims before spawn; concurrent approval/reject cannot repeat the attempt", async () => {
    const fake = childFixture();
    const f = await fixture({ runnerOptions: { spawnProcess: fake.spawnProcess } });
    const r = await f.create();
    fake.spawnProcess.mockImplementation(() => {
      expect(f.store.get(r.id)?.status).toBe("running");
      queueMicrotask(() => fake.child.emit("spawn"));
      return fake.child as unknown as ChildProcess;
    });
    const a = f.service.approve(r.id), b = f.service.approve(r.id), c = f.service.reject(r.id);
    await a;
    await expect(b).rejects.toMatchObject({ code: "COMMAND_REQUEST_NOT_PENDING" });
    await expect(c).rejects.toMatchObject({ code: "COMMAND_REQUEST_NOT_PENDING" });
    expect(fake.spawnProcess).toHaveBeenCalledTimes(1);
    await f.service.close();
  });
  it("does not accept before spawn; pre-spawn error is a persisted failure", async () => {
    const fake = childFixture(), f = await fixture({ runnerOptions: { spawnProcess: fake.spawnProcess } });
    const r = await f.create(); let accepted = false;
    const approval = f.service.approve(r.id).then((v) => { accepted = true; return v; });
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalled());
    expect(accepted).toBe(false); expect(f.service.get(r.id).startedAt).toBeUndefined();
    fake.child.emit("error", new Error("untrusted host details"));
    const result = await approval;
    expect(result.status).toBe("failed"); expect(result.resolutionCode).toBe("COMMAND_SPAWN_FAILED");
    expect(result.result).toMatchObject({ exitCode: null, signal: null, stdout: "", stderr: "", outputIncomplete: false });
  });
  it("real nonexistent executable fails without a started timestamp", async () => {
    const f = await fixture(), r = await f.create(["/nonexistent-c2c-executable"]);
    const result = await f.service.approve(r.id);
    expect(result.status).toBe("failed"); expect(result.startedAt).toBeUndefined();
  });
  it("exit alone remains busy until delayed natural EOF and close", async () => {
    const fake = childFixture(), f = await fixture({ runnerOptions: { spawnProcess: fake.spawnProcess } });
    const r = await f.create(), second = await f.create();
    const approval = f.service.approve(r.id);
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalled());
    fake.child.emit("spawn"); await approval;
    fake.child.emit("exit", 7, null);
    expect(f.service.get(r.id).status).toBe("running");
    await expect(f.service.approve(second.id)).rejects.toMatchObject({ code: "COMMAND_BUSY" });
    expect(f.service.get(second.id).status).toBe("pending");
    fake.child.stdout.end("late stdout"); fake.child.stderr.end("late stderr");
    await new Promise((r) => setImmediate(r));
    expect(f.service.get(r.id).status).toBe("running");
    fake.child.emit("close");
    const result = await terminal(f.service, r.id);
    expect(result.result).toMatchObject({ exitCode: 7, stdout: "late stdout", stderr: "late stderr", outputIncomplete: false });
  });
  it.each(["timeout", "capture"])("bounded %s cleanup survives missing leader and late callbacks", async (kind) => {
    const fake = childFixture(), terminate = vi.fn();
    const f = await fixture({ runnerOptions: { spawnProcess: fake.spawnProcess, timeoutMs: kind === "timeout" ? 150 : 5000, terminate } });
    const r = await f.create(), approval = f.service.approve(r.id);
    await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalled());
    fake.child.emit("spawn"); await approval; fake.child.emit("exit", 0, null);
    if (kind === "capture") fake.child.stdout.emit("error", new Error("capture failed"));
    const result = await terminal(f.service, r.id);
    expect(result.status).toBe("interrupted"); expect(result.result).toMatchObject({ exitCode: 0, outputIncomplete: true });
    expect(result.resolutionCode).toBe(kind === "timeout" ? "COMMAND_TIMEOUT" : "COMMAND_OUTPUT_INCOMPLETE");
    expect(terminate).not.toHaveBeenCalled(); expect(fake.child.stdout.destroyed && fake.child.stderr.destroyed).toBe(true);
    expect(fake.child.unref).toHaveBeenCalled();
    const bytes = fs.readFileSync(path.join(f.store.directory, r.id + ".json"));
    fake.child.emit("close"); fake.child.emit("exit", 9, "SIGKILL");
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(path.join(f.store.directory, r.id + ".json"))).toEqual(bytes);
    const next = await f.create(); await f.service.reject(next.id);
    // Completion released the slot, not merely exit/forced pipe close.
    fake.spawnProcess.mockImplementation(() => { throw new Error("expected probe"); });
    const probe = await f.create(); expect((await f.service.approve(probe.id)).status).toBe("failed");
  });
  it("terminal persistence failure leaves durable running and blocks further approvals", async () => {
    const f = await fixture(), r = await f.create(), second = await f.create();
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation((r) => { if (r.status === "completed") throw new Error("disk failed"); update(r); });
    await f.service.approve(r.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(f.service.get(r.id).status).toBe("running");
    await expect(f.service.approve(second.id)).rejects.toMatchObject({ code: "COMMAND_BUSY" });
    await f.service.close();
  });
  it("a write then persistence error cannot expose terminal success or prune the pinned claim", async () => {
    const f = await fixture(), r = await f.create(), second = await f.create();
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation((r) => { update(r); if (r.status === "completed") throw new Error("directory fsync failed"); });
    await f.service.approve(r.id);
    await vi.waitFor(() => expect(f.store.get(r.id)?.status).toBe("completed"));
    expect(f.service.get(r.id).status).toBe("running");
    await expect(f.service.approve(second.id)).rejects.toMatchObject({ code: "COMMAND_BUSY" });
    await f.service.close();
  });
  it("reads project expiry and exact availability cutoff without changing bytes", async () => {
    let now = Date.now(); const f = await fixture({ now: () => now }), r = await f.create();
    const file = path.join(f.store.directory, r.id + ".json"), bytes = fs.readFileSync(file);
    now += WINDOW_MS;
    expect(f.service.get(r.id)).toMatchObject({ status: "expired", resolvedAt: r.expiresAt });
    expect(f.service.listPending()).toEqual([]); expect(fs.readFileSync(file)).toEqual(bytes);
    now += WINDOW_MS - 1; expect(f.service.get(r.id).status).toBe("expired");
    now++; expect(() => f.service.get(r.id)).toThrow(expect.objectContaining({ code: "COMMAND_RESULT_UNAVAILABLE" }));
    expect(fs.readFileSync(file)).toEqual(bytes);
    await f.create(); expect(fs.existsSync(file)).toBe(false);
  });
  it("restart signals only stored leader and never respawns; running is never pruned", async () => {
    const f = await fixture(), r = await f.create();
    f.store.update({ ...r, status: "running", leader: { pid: 123, startTimeTicks: "456" } });
    const signalLeader = vi.fn(async () => "different" as const), spawnProcess = vi.fn();
    const restarted = new CommandRequestService({ store: f.store, resolveTarget: f.resolveTarget, signalLeader, runnerOptions: { spawnProcess } });
    await restarted.initialize();
    expect(signalLeader).toHaveBeenCalledWith({ pid: 123, startTimeTicks: "456" });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(restarted.get(r.id)).toMatchObject({ status: "interrupted", resolutionCode: "BROKER_RESTART", result: { outputIncomplete: true, termination: "different" } });
    await expect(restarted.approve(r.id)).rejects.toMatchObject({ code: "COMMAND_REQUEST_NOT_PENDING" });
  });
  it("validates bounds and revalidates cwd symlinks immediately before approval", async () => {
    const f = await fixture();
    for (const argv of [[], [""], ["a\0b"], Array(65).fill("x"), ["x".repeat(32769)]]) {
      await expect(f.create(argv)).rejects.toMatchObject({ code: "COMMAND_INVALID" });
    }
    for (const cwd of ["/tmp", "../", "C:\\Windows", "workspace:/", "missing"]) {
      await expect(f.service.create({ workspaceId: "one", argv: ["true"], cwd, reason: "test" })).rejects.toMatchObject({ code: "COMMAND_INVALID" });
    }
    fs.mkdirSync(path.join(f.root, "sub"));
    const r = await f.service.create({ workspaceId: "one", argv: ["true"], cwd: "sub", reason: "test" });
    fs.rmdirSync(path.join(f.root, "sub")); fs.symlinkSync(makeTmpDir("outside"), path.join(f.root, "sub"));
    await expect(f.service.approve(r.id)).rejects.toMatchObject({ code: "COMMAND_INVALID" });
    expect(f.service.get(r.id).status).toBe("pending");
    expect(() => f.service.get(r.id, { workspaceId: "another" })).toThrow(expect.objectContaining({ code: "COMMAND_REQUEST_NOT_FOUND" }));
  });
  it("rejects malformed stored records and preserves a valid record on invalid update", async () => {
    const f = await fixture(), r = await f.create();
    expect(() => f.store.update({ ...r, status: "completed" })).toThrow();
    expect(f.store.get(r.id)).toEqual(r);
    fs.writeFileSync(path.join(f.store.directory, r.id + ".json"), JSON.stringify({ ...r, env: { SECRET: "bad" } }));
    expect(() => f.store.get(r.id)).toThrow();
    expect(() => f.store.get("../secret")).toThrow(expect.objectContaining({ code: "COMMAND_REQUEST_NOT_FOUND" }));
  });
  it("UTF-8 projection remains within the encoded-byte cap", () => {
    expect(utf8Tail("a🙂λ", 5)).toEqual({ text: "λ", truncated: true });
    expect(utf8Tail("λ", 0)).toEqual({ text: "", truncated: true });
  });
});
