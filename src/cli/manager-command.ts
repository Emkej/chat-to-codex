import type { Command } from "commander";

/** Register the interactive command without loading the TUI in other CLI paths. */
export function registerManagerCommand(program: Command): void {
  program
    .command("manager")
    .description("Open the interactive C2C installation manager")
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write("c2c manager requires an interactive terminal (TTY).\n");
        process.exitCode = 1;
        return;
      }

      const { runManager } = await import("../manager/index.js");
      await runManager();
    });
}
