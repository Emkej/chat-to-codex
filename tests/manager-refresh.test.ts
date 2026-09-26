import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGER_REFRESH_INTERVAL_MS } from "../src/manager/constants.js";
import { RefreshCoordinator } from "../src/manager/refresh-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const coordinators: RefreshCoordinator<unknown>[] = [];

function makeCoordinator<T>(options: ConstructorParameters<typeof RefreshCoordinator<T>>[0]) {
  const coordinator = new RefreshCoordinator<T>(options);
  coordinators.push(coordinator as RefreshCoordinator<unknown>);
  return coordinator;
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  vi.useRealTimers();
});

describe("Manager refresh coordination", () => {
  it("deduplicates explicit refresh while one read is active", async () => {
    const read = vi.fn(async () => "status");
    const commit = vi.fn();
    const coordinator = makeCoordinator({ read, commit, fail: vi.fn() });
    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(second).toBe(first);
    await first;
    expect(read).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("status");
  });

  it("schedules the next poll only after a completed read and uses ten seconds", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => "status");
    const coordinator = makeCoordinator({ read, commit: vi.fn(), fail: vi.fn() });
    await coordinator.refresh();
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MANAGER_REFRESH_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not start the completion refresh until an obsolete read retires", async () => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    let readNumber = 0;
    let oldSignal: AbortSignal | undefined;
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => {
      readNumber += 1;
      if (readNumber === 1) {
        oldSignal = signal;
        return oldRead.promise;
      }
      return newRead.promise;
    });
    const commit = vi.fn();
    const coordinator = makeCoordinator({ read, commit, fail: vi.fn() });
    const originalRefresh = coordinator.refresh();
    await flushMicrotasks();
    expect(read).toHaveBeenCalledOnce();

    const retired = coordinator.beginForegroundAction();
    expect(oldSignal?.aborted).toBe(true);
    const completion = coordinator.refreshAfterAction(retired);
    await flushMicrotasks();
    expect(read).toHaveBeenCalledOnce();

    oldRead.resolve("obsolete");
    await retired;
    await flushMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
    newRead.resolve("fresh");
    await Promise.all([originalRefresh, completion]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("fresh");
  });

  it("lets the foreground action proceed without waiting for the obsolete read", async () => {
    const oldRead = deferred<string>();
    let signal: AbortSignal | undefined;
    const read = vi.fn(({ signal: readSignal }: { signal: AbortSignal }) => {
      signal = readSignal;
      return oldRead.promise;
    });
    const coordinator = makeCoordinator({ read, commit: vi.fn(), fail: vi.fn() });
    const refresh = coordinator.refresh();
    await flushMicrotasks();
    const retirement = coordinator.beginForegroundAction();
    expect(signal?.aborted).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(retirement).toBe(refresh);
    oldRead.resolve("retired");
    await retirement;
  });

  it("prevents overlap by retaining one read until its abort-aware promise settles", async () => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    let readNumber = 0;
    const read = vi.fn(() => {
      readNumber += 1;
      return readNumber === 1 ? oldRead.promise : newRead.promise;
    });
    const coordinator = makeCoordinator({ read, commit: vi.fn(), fail: vi.fn() });
    const initial = coordinator.refresh();
    await flushMicrotasks();
    const retired = coordinator.beginForegroundAction();
    const completion = coordinator.refreshAfterAction(retired);
    await flushMicrotasks();
    expect(read).toHaveBeenCalledOnce();
    oldRead.resolve("old");
    await retired;
    await flushMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
    newRead.resolve("new");
    await Promise.all([initial, completion]);
  });

  it("does not commit a late result after closing", async () => {
    const result = deferred<string>();
    const commit = vi.fn();
    const coordinator = makeCoordinator({
      read: vi.fn(() => result.promise),
      commit,
      fail: vi.fn(),
    });
    const refresh = coordinator.refresh();
    await flushMicrotasks();
    coordinator.close();
    result.resolve("late");
    await refresh;
    expect(commit).not.toHaveBeenCalled();
  });

  it("aborts the current read and prevents a scheduled poll on close", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pendingRead = deferred<string>();
    const read = vi.fn(({ signal: readSignal }: { signal: AbortSignal }) => {
      signal = readSignal;
      return pendingRead.promise;
    });
    const coordinator = makeCoordinator({ read, commit: vi.fn(), fail: vi.fn() });
    const refresh = coordinator.refresh();
    await flushMicrotasks();
    expect(signal).toBeDefined();
    coordinator.close();
    expect(signal?.aborted).toBe(true);
    pendingRead.resolve("status");
    await refresh;
    await vi.advanceTimersByTimeAsync(MANAGER_REFRESH_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledOnce();
  });

  it("turns a hung read into a bounded timeout and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fail = vi.fn();
    const coordinator = makeCoordinator({
      read: vi.fn(({ signal: readSignal }: { signal: AbortSignal }) => {
        signal = readSignal;
        return new Promise<string>(() => {});
      }),
      commit: vi.fn(),
      fail,
      timeoutMs: 500,
      refreshIntervalMs: 2_000,
    });
    const refresh = coordinator.refresh();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);
    await refresh;
    expect(signal?.aborted).toBe(true);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: "Installation status read timed out" }));
  });

  it("does not schedule a stale poll after foreground invalidation", async () => {
    vi.useFakeTimers();
    const oldRead = deferred<string>();
    let readNumber = 0;
    const coordinator = makeCoordinator({
      read: vi.fn(() => {
        readNumber += 1;
        return readNumber === 1 ? oldRead.promise : Promise.resolve("fresh");
      }),
      commit: vi.fn(),
      fail: vi.fn(),
      refreshIntervalMs: 100,
    });
    const initial = coordinator.refresh();
    await flushMicrotasks();
    const retired = coordinator.beginForegroundAction();
    oldRead.resolve("old");
    await Promise.all([initial, retired]);
    await vi.advanceTimersByTimeAsync(500);
    expect(readNumber).toBe(1);
  });
});
