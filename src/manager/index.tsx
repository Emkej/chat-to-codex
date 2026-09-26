import { render } from "ink";
import { ManagerController } from "./controller.js";
import { ManagerApp } from "./ui/manager-app.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** Start the TUI after the CLI's interactive-terminal guard has passed. */
export async function runManager(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The C2C Manager renderer must be launched from an interactive TTY.");
  }

  const controller = new ManagerController();
  let app: ReturnType<typeof render> | undefined;
  let exitRequested = false;
  let resolveExit!: () => void;
  const exitRequestedPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let alternateScreenActive = false;
  let managerFailure: { error: unknown } | null = null;
  let teardownFailure: { error: unknown } | null = null;
  const requestExit = () => {
    if (exitRequested) return;
    exitRequested = true;
    let requestFailure: { error: unknown } | null = null;

    try {
      controller.close();
    } catch (error) {
      requestFailure = { error };
    }

    try {
      app?.unmount();
    } catch (error) {
      requestFailure ??= { error };
    }

    try {
      resolveExit();
    } catch (error) {
      requestFailure ??= { error };
    }

    if (requestFailure && !teardownFailure) teardownFailure = requestFailure;
  };
  const onSigterm = () => requestExit();

  process.once("SIGTERM", onSigterm);
  try {
    process.stdout.write(ENTER_ALT_SCREEN);
    alternateScreenActive = true;
    app = render(<ManagerApp controller={controller} onQuit={requestExit} />, {
      stdin: process.stdin,
      stdout: process.stdout,
      exitOnCtrlC: false,
    });
    controller.start();
    await Promise.race([app.waitUntilExit(), exitRequestedPromise]);
  } catch (error) {
    managerFailure = { error };
  } finally {
    requestExit();

    try {
      if (alternateScreenActive && process.stdout.writable && !process.stdout.destroyed) {
        process.stdout.write(LEAVE_ALT_SCREEN);
      }
    } catch {
      // Terminal restoration is best-effort and must not mask Manager failures.
    } finally {
      alternateScreenActive = false;
      process.removeListener("SIGTERM", onSigterm);
    }
  }

  if (managerFailure) throw managerFailure.error;
  if (teardownFailure !== null) throw (teardownFailure as { error: unknown }).error;
}
