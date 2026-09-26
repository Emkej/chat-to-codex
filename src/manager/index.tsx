import { render } from "ink";
import { ManagerController } from "./controller.js";
import { ManagerApp } from "./ui/manager-app.js";

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
  const requestExit = () => {
    if (exitRequested) return;
    exitRequested = true;
    controller.close();
    app?.unmount();
    resolveExit();
  };
  const onSigterm = () => requestExit();

  process.once("SIGTERM", onSigterm);
  try {
    app = render(<ManagerApp controller={controller} onQuit={requestExit} />, {
      stdin: process.stdin,
      stdout: process.stdout,
      exitOnCtrlC: false,
    });
    controller.start();
    await Promise.race([app.waitUntilExit(), exitRequestedPromise]);
  } finally {
    requestExit();
    process.removeListener("SIGTERM", onSigterm);
  }
}
