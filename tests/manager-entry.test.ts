import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { ManagerController } from "../src/manager/controller.js";
import { ManagerApp } from "../src/manager/ui/manager-app.js";
import { runManager } from "../src/manager/index.js";

vi.mock("ink", () => ({
  render: vi.fn(),
}));

vi.mock("../src/manager/controller.js", () => ({
  ManagerController: vi.fn(),
}));

vi.mock("../src/manager/ui/manager-app.js", () => ({
  ManagerApp: vi.fn(() => null),
}));

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

interface FakeApp {
  waitUntilExit: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
}

interface FakeController {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface ManagerAppProps {
  controller: ManagerController;
  onQuit(): void;
}

const renderMock = vi.mocked(render);
const managerControllerMock = vi.mocked(ManagerController);
const managerAppMock = vi.mocked(ManagerApp);

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

let app: FakeApp;
let controller: FakeController;
let writes: string[];
let stdoutWrite: ReturnType<typeof vi.spyOn>;
let on: ReturnType<typeof vi.spyOn>;
let removeListener: ReturnType<typeof vi.spyOn>;
let quitCallback: (() => void) | undefined;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreTTY(): void {
  if (originalStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  if (originalStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  else Reflect.deleteProperty(process.stdout, "isTTY");
}

function expectSigtermListenerRemovedAfterRestoration(): void {
  const registration = on.mock.calls.find(([event]) => event === "SIGTERM");
  const handler = registration?.[1];
  expect(handler).toEqual(expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith("SIGTERM", handler);

  const leaveWriteIndex = stdoutWrite.mock.calls.findIndex(
    ([chunk]) => chunk?.toString() === LEAVE_ALT_SCREEN
  );
  const removeListenerIndex = removeListener.mock.calls.findIndex(
    ([event, listener]) => event === "SIGTERM" && listener === handler
  );
  expect(leaveWriteIndex).toBeGreaterThanOrEqual(0);
  expect(removeListenerIndex).toBeGreaterThanOrEqual(0);
  expect(removeListener.mock.invocationCallOrder[removeListenerIndex]).toBeGreaterThan(
    stdoutWrite.mock.invocationCallOrder[leaveWriteIndex]
  );
}

function configureSuccessfulRender(): void {
  app = {
    waitUntilExit: vi.fn(async () => undefined),
    unmount: vi.fn(),
  };
  controller = {
    start: vi.fn(),
    close: vi.fn(),
  };
  managerControllerMock.mockImplementation(() => controller as unknown as ManagerController);
  renderMock.mockReturnValue(app as unknown as ReturnType<typeof render>);
  managerAppMock.mockReturnValue(null);
  quitCallback = undefined;
}

beforeEach(() => {
  setTTY(true);
  configureSuccessfulRender();
  writes = [];
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write);
  on = vi.spyOn(process, "on");
  removeListener = vi.spyOn(process, "removeListener");
});

afterEach(() => {
  stdoutWrite.mockRestore();
  on.mockRestore();
  removeListener.mockRestore();
  renderMock.mockReset();
  managerControllerMock.mockReset();
  managerAppMock.mockReset();
  restoreTTY();
});

describe("C2C Manager terminal lifecycle", () => {
  it("enters before Ink render and leaves once after normal completion", async () => {
    const events: string[] = [];
    stdoutWrite.mockImplementation(((chunk: string | Uint8Array) => {
      const value = chunk.toString();
      writes.push(value);
      events.push("write:" + value);
      return true;
    }) as typeof process.stdout.write);
    renderMock.mockImplementation(() => {
      events.push("render");
      return app as unknown as ReturnType<typeof render>;
    });

    await runManager();

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expect(events.indexOf("write:" + ENTER_ALT_SCREEN)).toBeLessThan(events.indexOf("render"));
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.close).toHaveBeenCalledOnce();
    expect(app.unmount).toHaveBeenCalledOnce();
  });

  it("does not emit alternate-screen control when the renderer is not attached to a TTY", async () => {
    setTTY(false);

    await expect(runManager()).rejects.toThrow("interactive TTY");

    expect(writes).toEqual([]);
    expect(renderMock).not.toHaveBeenCalled();
    expect(managerControllerMock).not.toHaveBeenCalled();
  });

  it("restores the terminal after a render failure and preserves that Manager failure", async () => {
    const managerError = new Error("render failed");
    renderMock.mockImplementation(() => {
      throw managerError;
    });

    await expect(runManager()).rejects.toBe(managerError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("attempts restoration and propagates teardown failure when Manager execution succeeds", async () => {
    const teardownError = new Error("teardown failed");
    controller.close.mockImplementation(() => {
      throw teardownError;
    });

    await expect(runManager()).rejects.toBe(teardownError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps the onQuit callback synchronous while completing teardown after close fails", async () => {
    const teardownError = new Error("close failed from q");
    controller.close.mockImplementation(() => {
      throw teardownError;
    });
    app.waitUntilExit.mockImplementation(() => new Promise<void>(() => undefined));

    const managerPromise = runManager();
    const renderedElement = renderMock.mock.calls[0]?.[0] as
      | { props: ManagerAppProps }
      | undefined;
    quitCallback = renderedElement?.props.onQuit;
    expect(quitCallback).toEqual(expect.any(Function));
    expect(() => quitCallback!()).not.toThrow();

    await expect(managerPromise).rejects.toBe(teardownError);

    expect(controller.close).toHaveBeenCalledOnce();
    expect(app.unmount).toHaveBeenCalledOnce();
    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps SIGTERM ownership until the alternate screen has been restored", async () => {
    app.waitUntilExit.mockImplementation(() => new Promise<void>(() => undefined));
    const managerPromise = runManager();
    const registration = on.mock.calls.find(([event]) => event === "SIGTERM");
    const handler = registration?.[1] as (() => void);
    const raw = process.rawListeners("SIGTERM").find((listener) =>
      listener === handler || (listener as { listener?: unknown }).listener === handler
    );
    expect(raw).toEqual(expect.any(Function));
    raw!.call(process);
    // Ink's already-dispatched signal-exit listener runs before the finally
    // continuation. It must still observe a Manager listener at this point.
    expect(process.listeners("SIGTERM")).toContain(handler);
    await managerPromise;
    expect(process.listeners("SIGTERM")).not.toContain(handler);
    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps the SIGTERM callback synchronous while completing teardown after close fails", async () => {
    const teardownError = new Error("close failed from SIGTERM");
    controller.close.mockImplementation(() => {
      throw teardownError;
    });
    app.waitUntilExit.mockImplementation(() => new Promise<void>(() => undefined));

    const managerPromise = runManager();
    const registration = on.mock.calls.find(([event]) => event === "SIGTERM");
    const handler = registration?.[1] as (() => void) | undefined;
    expect(handler).toEqual(expect.any(Function));
    expect(() => handler!()).not.toThrow();

    await expect(managerPromise).rejects.toBe(teardownError);

    expect(controller.close).toHaveBeenCalledOnce();
    expect(app.unmount).toHaveBeenCalledOnce();
    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("restores the terminal after Manager startup fails", async () => {
    const managerError = new Error("startup failed");
    controller.start.mockImplementation(() => {
      throw managerError;
    });

    await expect(runManager()).rejects.toBe(managerError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps the original Manager failure when teardown fails too", async () => {
    const managerError = new Error("startup failed");
    const teardownError = new Error("close failed");
    renderMock.mockImplementation(() => {
      throw managerError;
    });
    controller.close.mockImplementation(() => {
      throw teardownError;
    });

    await expect(runManager()).rejects.toBe(managerError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps teardown failure precedence when restoration fails too", async () => {
    const teardownError = new Error("close failed");
    controller.close.mockImplementation(() => {
      throw teardownError;
    });
    stdoutWrite.mockImplementation(((chunk: string | Uint8Array) => {
      const value = chunk.toString();
      writes.push(value);
      if (value === LEAVE_ALT_SCREEN) throw new Error("stdout closed");
      return true;
    }) as typeof process.stdout.write);

    await expect(runManager()).rejects.toBe(teardownError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });

  it("keeps the original Manager failure when restoration fails after teardown", async () => {
    const managerError = new Error("runtime failed");
    const teardownError = new Error("close failed");
    renderMock.mockImplementation(() => {
      throw managerError;
    });
    controller.close.mockImplementation(() => {
      throw teardownError;
    });
    stdoutWrite.mockImplementation(((chunk: string | Uint8Array) => {
      const value = chunk.toString();
      writes.push(value);
      if (value === LEAVE_ALT_SCREEN) throw new Error("stdout closed");
      return true;
    }) as typeof process.stdout.write);

    await expect(runManager()).rejects.toBe(managerError);

    expect(writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expectSigtermListenerRemovedAfterRestoration();
  });
});
