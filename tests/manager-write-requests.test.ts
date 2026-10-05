import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString, type Key } from "ink";
import { ManagerController } from "../src/manager/controller.js";
import { managerServices, type ManagerServices } from "../src/manager/services.js";
import type { ManagerStatus, ManagerWriteRequestServices } from "../src/manager/write-request-service.js";
import type { WriteRequestReceipt } from "../src/write-requests/types.js";
import { escapeReviewText, requestReviewLines } from "../src/manager/request-review-layout.js";
import { detailViewport } from "../src/manager/workspace-detail-layout.js";
import { RequestReview } from "../src/manager/ui/request-review.js";
import { WorkspacePanel } from "../src/manager/ui/workspace-panel.js";
import { handleManagerInput, type ManagerInputState } from "../src/manager/ui/manager-input.js";

const controllers: ManagerController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.close()); vi.restoreAllMocks(); });

function receipt(): WriteRequestReceipt {
  return { id: "wr_000000000000000000000001", kind: "patch", status: "pending", workspaceId: "one", worktreeId: "wt_test", approvalMode: "manual-local", files: [{ path: "file.txt", operation: "update", additions: 1, deletions: 1, resultSha256: "hash" }], preconditions: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}
function status(counts: Record<string, number> | null = { one: 1, two: 0 }): ManagerStatus {
  return {
    installation: { state: "ready", id: "c2c_inst_test", version: "0.2.0", profile: null },
    broker: { state: "running" }, authorization: { state: "unknown" }, tunnel: { state: "stopped", provider: null, preference: "unset" },
    workspaces: [{ id: "one", name: "One", liveSessionCount: 0 }, { id: "two", name: "Two", liveSessionCount: null }], observedAt: new Date().toISOString(), pendingCounts: counts,
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

async function fixture(overrides: Partial<ManagerWriteRequestServices> = {}, statusRead = vi.fn(async () => status())) {
  const request = receipt();
  const writes: ManagerWriteRequestServices = {
    list: vi.fn(async () => ({ counts: { one: 1 }, requests: [request], overflow: false })),
    detail: vi.fn(async () => ({ ...request, patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n" })),
    receipt: vi.fn(async () => request),
    approve: vi.fn(async (_id, _signal, dispatch) => { dispatch(); return { ...request, status: "applied", resolvedAt: new Date().toISOString() }; }),
    ...overrides,
  };
  const services: ManagerServices = { ...managerServices, readStatus: statusRead, readInstruction: () => ({ kind: "none" }), writeRequests: writes };
  const controller = new ManagerController(services); controllers.push(controller);
  await controller.refresh();
  return { controller, writes, services, request };
}

describe("Manager request review lifecycle", () => {
  it("shows exact zero/positive/unavailable counts and keeps workspace selection after review", async () => {
    const { controller, writes } = await fixture();
    const render = () => renderToString(createElement(WorkspacePanel, { snapshot: controller.getSnapshot() }), { columns: 80 });
    expect(render()).toContain("pending 1"); expect(render()).toContain("pending 0");
    await controller.requests.openQueue(); await controller.requests.openDetail();
    expect(writes.approve).not.toHaveBeenCalled();
    controller.requests.back(); controller.requests.back();
    expect(controller.getSnapshot().selectedWorkspaceId).toBe("one");
    const other = await fixture({}, vi.fn(async () => status(null)));
    expect(renderToString(createElement(WorkspacePanel, { snapshot: other.controller.getSnapshot() }))).toContain("pending unavailable");
  });

  it("requires detail review and confirmation; cancelling sends no approval", async () => {
    const { controller, writes } = await fixture();
    await controller.requests.openQueue();
    expect(controller.requests.requestApproval()).toBe(false);
    await controller.requests.openDetail();
    expect(controller.requests.requestApproval()).toBe(true);
    controller.cancelConfirmation();
    expect(writes.approve).not.toHaveBeenCalled();
    expect(controller.requests.requestApproval()).toBe(true);
    await controller.confirmPendingAction();
    expect(writes.approve).toHaveBeenCalledTimes(1);
    expect(writes.approve).toHaveBeenCalledWith(receipt().id, expect.any(AbortSignal), expect.any(Function));
    expect(controller.getSnapshot().approvalAttempt).toMatchObject({ state: "resolved", receipt: { status: "applied" } });
    expect(controller.requests.requestApproval()).toBe(false);
  });

  it.each(["pending", "missing", "unavailable", "projected-expiry"])("keeps %s reconciliation unknown and never repeats POST", async (outcome) => {
    const request = receipt();
    const { controller, writes } = await fixture({
      approve: vi.fn(async (_id, _signal, dispatch) => { dispatch(); throw new Error("Response lost"); }),
      receipt: vi.fn(async () => {
        if (outcome === "missing" || outcome === "unavailable") throw new Error(outcome);
        return outcome === "projected-expiry" ? { ...request, status: "expired" } : request;
      }),
    });
    await controller.requests.openQueue(); await controller.requests.openDetail();
    controller.requests.requestApproval(); await controller.confirmPendingAction();
    expect(controller.getSnapshot().approvalAttempt?.state).toBe("unknown");
    expect(controller.requests.requestApproval()).toBe(false);
    await controller.refresh();
    expect(writes.approve).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().approvalAttempt?.state).toBe("unknown");
    expect(requestReviewLines(controller.getSnapshot(), 78).join("\n")).toContain("UNKNOWN approval outcome");
  });

  it("reconciles an uncertain attempt after navigation via explicit refresh", async () => {
    const request = receipt();
    const read = vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ ...request, status: "applied", resolvedAt: new Date().toISOString() });
    const { controller, writes } = await fixture({ approve: vi.fn(async (_id, _signal, dispatch) => { dispatch(); throw new Error("Response lost"); }), receipt: read });
    await controller.requests.openQueue(); await controller.requests.openDetail(); controller.requests.requestApproval();
    await controller.confirmPendingAction(); controller.requests.back(); controller.requests.back();
    await controller.refresh();
    expect(controller.getSnapshot().approvalAttempt).toMatchObject({ state: "resolved", receipt: { status: "applied" } });
    expect(writes.approve).toHaveBeenCalledTimes(1);
  });

  it("invalidates late list/detail results after target changes or back navigation", async () => {
    const pending = deferred<Awaited<ReturnType<ManagerWriteRequestServices["list"]>>>(); let signal!: AbortSignal;
    const { controller } = await fixture({ list: vi.fn(async (_workspace, owned) => { signal = owned; return pending.promise; }) });
    const operation = controller.requests.openQueue(); await flush();
    controller.selectWorkspace("two"); expect(signal.aborted).toBe(true);
    pending.resolve({ counts: {}, requests: [receipt()], overflow: false }); await operation;
    expect(controller.getSnapshot().requestReview).toBeNull();
    const detail = deferred<Awaited<ReturnType<ManagerWriteRequestServices["detail"]>>>();
    const other = await fixture({ detail: vi.fn(() => detail.promise) });
    await other.controller.requests.openQueue(); const opened = other.controller.requests.openDetail(); await flush();
    other.controller.requests.back(); detail.resolve({ ...receipt(), patch: "patch" }); await opened;
    expect(other.controller.getSnapshot().requestReview?.detail).toBeNull();
  });

  it("starts approval immediately despite an obsolete refresh, then waits before one completion refresh", async () => {
    const { controller, services, writes } = await fixture();
    await controller.requests.openQueue(); await controller.requests.openDetail();
    const oldRead = deferred<ManagerStatus>(); let oldSignal!: AbortSignal;
    const read = vi.fn().mockImplementationOnce(({ signal }) => { oldSignal = signal; return oldRead.promise; }).mockResolvedValue(status({ one: 0, two: 0 }));
    services.readStatus = read;
    // Refresh coordinator calls through services, so this is a real active status read.
    controller.requests.back(); controller.requests.back();
    const refreshing = controller.refresh(); await flush();
    const queue = controller.requests.openQueue(); await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(controller.getSnapshot().requestReview?.state).toBe("ready");
    expect(read).toHaveBeenCalledTimes(1);
    oldRead.resolve(status({ one: 999 })); await refreshing; await queue;
    expect(read).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().pendingCounts?.one).toBe(0);
    expect(writes.list).toHaveBeenCalledTimes(2);
  });

  it("cancels dispatched approval wait on navigation while retaining its unresolved id", async () => {
    let owned!: AbortSignal;
    const { controller, writes } = await fixture({ approve: vi.fn(async (_id, signal, dispatch) => {
      owned = signal; dispatch();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Wait cancelled")), { once: true }));
    }) });
    await controller.requests.openQueue(); await controller.requests.openDetail(); controller.requests.requestApproval();
    const operation = controller.confirmPendingAction(); await flush(); controller.requests.back(); await operation;
    expect(owned.aborted).toBe(true); expect(controller.getSnapshot().approvalAttempt).toMatchObject({ id: receipt().id, state: "unknown" });
    expect(writes.approve).toHaveBeenCalledTimes(1);
  });
});

describe("safe request presentation and input", () => {
  it("keeps an unresolved attempt visible at the end of a long diff", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const viewport = detailViewport(lines.length, 24, 1000);
    const screen = renderToString(createElement(RequestReview, { lines, ...viewport, detail: true, unknownId: receipt().id, canApprove: false }), { columns: 80 });
    expect(screen).toContain("UNKNOWN approval outcome: " + receipt().id);
    expect(screen).toContain("Approval unavailable");
    expect(screen).not.toContain("[v] Approve");
    expect(screen.split("\n").length).toBeLessThanOrEqual(24);
  });
  it("renders valid newline-heavy patches beyond the engine argument limit", async () => {
    const patch = "--- /dev/null\n+++ b/empty-lines.txt\n@@ -0,0 +1,150000 @@\n" + "+\n".repeat(150_000);
    const { controller } = await fixture({ detail: vi.fn(async () => ({ ...receipt(), patch })) });
    await controller.requests.openQueue(); await controller.requests.openDetail();
    expect(Buffer.byteLength(patch)).toBeLessThan(1024 * 1024);
    const lines = requestReviewLines(controller.getSnapshot(), 78);
    expect(lines.filter((line) => line === "+")).toHaveLength(150_000);
  });
  it.each([80, 120])("keeps all escaped hunks and filenames reachable at %s columns", async (columns) => {
    const patch = Array.from({ length: 80 }, (_, index) => `@@ hunk ${index} @@\n+\x1b[31m\x07\t\r\\u{001b} END-${index}\n`).join("");
    const request = { ...receipt(), files: [{ ...receipt().files[0]!, path: "evil\x1b[2J\n\\u{001b}" }], patch };
    const { controller } = await fixture({ detail: vi.fn(async () => request) });
    await controller.requests.openQueue(); await controller.requests.openDetail();
    const lines = requestReviewLines(controller.getSnapshot(), columns - 2), seen: string[] = [];
    for (let offset = 0; offset < lines.length; offset += 20) {
      const viewport = detailViewport(lines.length, 24, offset);
      const screen = renderToString(createElement(RequestReview, { lines, ...viewport, detail: true }), { columns });
      expect(screen.split("\n").length).toBeLessThanOrEqual(24);
      seen.push(screen);
    }
    const text = seen.join("\n");
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text).toContain("\\u{001b}[31m"); expect(text).toContain("\\\\u{001b}");
    for (let i = 0; i < 80; i++) expect(text).toContain(`END-${i}`);
    expect(request.patch).toBe(patch);
    expect(escapeReviewText("x\n", true)).toBe("x\n");
  });

  it("routes queue/detail/approval keys without applying on Enter", async () => {
    const { controller, writes } = await fixture();
    const ui: ManagerInputState = { menuOpen: false, menuIndex: 0, helpOpen: false, setMenuOpen: vi.fn(), setMenuIndex: vi.fn(), setHelpOpen: vi.fn(), scroll: vi.fn(), pageHeight: 20, resetScroll: vi.fn(), onQuit: vi.fn() };
    const input = (text: string, key: Partial<Key> = {}) => handleManagerInput(text, key as Key, controller.getSnapshot(), controller, ui);
    input("w"); await flush(); await new Promise((resolve) => setTimeout(resolve, 0));
    input("", { return: true }); await flush(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.approve).not.toHaveBeenCalled(); input("v"); input("n");
    expect(writes.approve).not.toHaveBeenCalled(); input("q"); expect(ui.onQuit).toHaveBeenCalledTimes(1);
  });
});
