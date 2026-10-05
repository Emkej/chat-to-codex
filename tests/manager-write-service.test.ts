import { afterEach, describe, expect, it, vi } from "vitest";
import { managerWriteRequestServices } from "../src/manager/write-request-service.js";
import { adminFetch } from "../src/process/daemon.js";

vi.mock("../src/broker/daemon.js", () => ({ installationRuntime: vi.fn(() => ({ port: 1234, adminToken: "fixture" })) }));
vi.mock("../src/process/daemon.js", () => ({ adminFetch: vi.fn(async () => ({})) }));
afterEach(() => vi.clearAllMocks());

describe("Manager broker transport", () => {
  it("uses one inventory read, deadlines, workspace filters and patch-only detail", async () => {
    const signal = new AbortController().signal;
    await managerWriteRequestServices.list("one", signal);
    expect(adminFetch).toHaveBeenCalledTimes(1);
    const args = vi.mocked(adminFetch).mock.calls[0]!;
    expect(args[1]).toBe("GET"); expect(args[2]).toContain("workspaceId=one&limit=100&deadline=");
    expect(args[3]).toBeLessThanOrEqual(5000); expect(args[5]).toBe(signal);
    await managerWriteRequestServices.detail("one", "wr_test", signal);
    expect(vi.mocked(adminFetch).mock.calls[1]![2]).toContain("includePatch=true");
    await managerWriteRequestServices.receipt("one", "wr_test", signal);
    expect(vi.mocked(adminFetch).mock.calls[2]![2]).not.toContain("includePatch");
  });
  it("sends no POST before dispatch when already cancelled; dispatched waits retain 60s limit", async () => {
    const abort = new AbortController(), dispatch = vi.fn(); abort.abort();
    await expect(managerWriteRequestServices.approve("wr_test", abort.signal, dispatch)).rejects.toThrow();
    expect(adminFetch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await managerWriteRequestServices.approve("wr_test", signal, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(adminFetch).toHaveBeenCalledWith(expect.anything(), "POST", "/admin/write-requests/wr_test/approve", 60_000, undefined, signal);
  });
});
