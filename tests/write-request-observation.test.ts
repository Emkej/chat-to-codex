import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { WriteRequestStore, terminalRecord } from "../src/write-requests/store.js";
import { WriteRequestService } from "../src/write-requests/service.js";
import { LifecycleMutex } from "../src/write-requests/lifecycle-mutex.js";
import { MAX_PATCH_BYTES } from "../src/write-requests/patch.js";
import type { WriteRequestRecord } from "../src/write-requests/types.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) cleanup(dir); });
const now = Date.parse("2026-10-05T12:00:00Z");

function record(index: number, workspaceId = "one"): WriteRequestRecord {
  return {
    id: "wr_" + index.toString(16).padStart(24, "0"), kind: "patch", status: "pending",
    workspaceId, ...(index % 2 ? { worktreeId: "wt_test" } : {}), approvalMode: "manual-local",
    files: [], preconditions: [], patch: "x".repeat(200_000),
    createdAt: new Date(now - index * 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString(),
  };
}

function fixture() {
  const dir = makeTmpDir("write-observation"); dirs.push(dir);
  const store = new WriteRequestStore(dir);
  const service = new WriteRequestService({ store, resolveTarget: () => { throw new Error("Observation must not resolve targets."); }, protectedRoots: [], now: () => now });
  return { store, service };
}

function snapshot(store: WriteRequestStore) {
  return Object.fromEntries(fs.readdirSync(store.directory).map((name) => [name,
    createHash("sha256").update(fs.readFileSync(path.join(store.directory, name))).digest("hex")]));
}

describe("broker-owned observational write reads", () => {
  it("counts >100 requests exactly, keeps <=100 metadata entries and never calls whole-store list", async () => {
    const { store, service } = fixture();
    for (let i = 0; i < 130; i++) store.create(record(i));
    store.create(record(130, "two"));
    store.create({ ...record(131), expiresAt: new Date(now - 1).toISOString() });
    store.create(terminalRecord(record(132), "applied", new Date(now - 8 * 86400_000).toISOString()));
    const before = snapshot(store);
    vi.spyOn(store, "list").mockImplementation(() => { throw new Error("Forbidden materialization"); });
    let inFlight = 0, maximum = 0;
    const original = store.getObserved.bind(store);
    vi.spyOn(store, "getObserved").mockImplementation(async (...args) => {
      inFlight++; maximum = Math.max(maximum, inFlight);
      try { return await original(...args); } finally { inFlight--; }
    });
    let retainedMetadata = 0;
    const push = Array.prototype.push, splice = Array.prototype.splice;
    const inspectPage = (array: unknown[], entries: unknown[]) => {
      if (entries.some((entry) => entry && typeof entry === "object" && "kind" in entry && entry.kind === "patch" && !("patch" in entry))) {
        retainedMetadata = Math.max(retainedMetadata, array.length + entries.length);
      }
    };
    Array.prototype.push = function (this: unknown[], ...entries: unknown[]) {
      inspectPage(this, entries); return push.apply(this, entries);
    };
    Array.prototype.splice = function (this: unknown[], start: number, remove: number, ...entries: unknown[]) {
      inspectPage(this, entries); return splice.call(this, start, remove, ...entries);
    };
    let result: Awaited<ReturnType<WriteRequestService["observePending"]>>;
    try { result = await service.observePending("one"); }
    finally { Array.prototype.push = push; Array.prototype.splice = splice; }
    expect(result.counts).toEqual({ one: 130, two: 1 });
    expect(result.requests).toHaveLength(100);
    expect(result.overflow).toBe(true);
    expect(maximum).toBe(1);
    expect(retainedMetadata).toBe(100);
    expect(result.requests.map((entry) => entry.id)).toEqual(Array.from({ length: 100 }, (_, i) => record(i).id));
    expect(result.requests.every((entry) => !("patch" in entry))).toBe(true);
    expect(await service.observeRequest(record(0).id, "one", true)).toMatchObject({ patch: record(0).patch });
    expect(await service.observeRequest(record(131).id, "one", true)).toMatchObject({ status: "expired" });
    expect(await service.observeRequest(record(132).id, "one")).toMatchObject({ status: "applied" });
    expect(snapshot(store)).toEqual(before);
  });

  it("isolates detail, exposes no patch in reconciliation and accepts a maximum-size patch", async () => {
    const { store, service } = fixture();
    store.create({ ...record(0), patch: "x".repeat(MAX_PATCH_BYTES) });
    await expect(service.observeRequest(record(0).id, "two", true)).rejects.toMatchObject({ code: "WRITE_REQUEST_NOT_FOUND" });
    expect(await service.observeRequest(record(0).id, "one")).not.toHaveProperty("patch");
    expect((await service.observeRequest(record(0).id, "one", true)).patch?.length).toBe(MAX_PATCH_BYTES);
    expect((await service.observePending()).requests).toEqual([]);
  });

  it("returns unavailable on corruption rather than a partial projection", async () => {
    const { store, service } = fixture();
    store.create(record(0));
    fs.writeFileSync(path.join(store.directory, record(1).id + ".json"), "{}");
    await expect(service.observePending("one")).rejects.toMatchObject({ code: "WRITE_RECEIPT_PERSIST_FAILED" });
  });

  it("enforces one traversal deadline, closes owned handles, and allows a later read", async () => {
    const { store, service } = fixture();
    for (let i = 0; i < 6; i++) store.create(record(i));
    const opened: fs.promises.FileHandle[] = [];
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args); opened.push(handle);
      const readFile = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs: Parameters<typeof readFile>) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return readFile(...readArgs);
      });
      return handle;
    });
    const started = Date.now();
    await expect(service.observePending("one", 100, { timeoutMs: 35 })).rejects.toMatchObject({ code: "WRITE_READ_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(250);
    expect(opened.length).toBeLessThan(6);
    expect(opened.every((handle) => handle.fd === -1)).toBe(true);
    vi.restoreAllMocks();
    expect((await service.observePending()).counts.one).toBe(6);
  });

  it("cancels queued lifecycle reads without scanning later or breaking writer ordering", async () => {
    const mutex = new LifecycleMutex();
    let release!: () => void;
    const held = mutex.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    const scan = vi.fn();
    const abort = new AbortController();
    const queued = mutex.run(scan, abort.signal);
    abort.abort();
    await expect(queued).rejects.toMatchObject({ code: "WRITE_READ_UNAVAILABLE" });
    const writer = vi.fn();
    const next = mutex.run(writer);
    await Promise.resolve();
    expect(writer).not.toHaveBeenCalled();
    release(); await held; await next;
    expect(scan).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("a cancelled service read queued behind an observation never visits storage", async () => {
    const { store, service } = fixture(); store.create(record(0));
    const visit = store.visitObserved.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(store, "visitObserved").mockImplementationOnce(async (...args) => { await gate; return visit(...args); });
    const held = service.observePending();
    await Promise.resolve(); await Promise.resolve();
    const abort = new AbortController();
    const queued = service.observePending(undefined, 100, { signal: abort.signal });
    abort.abort();
    await expect(queued).rejects.toMatchObject({ code: "WRITE_READ_UNAVAILABLE" });
    release(); await held;
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
