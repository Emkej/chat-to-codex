import type { Command } from "commander";
import { ensureBroker } from "../broker/daemon.js";
import { adminFetch } from "../process/daemon.js";
import { resolveContainingLocalTarget, type LocalTargetRegistration } from "../workspace/local-target.js";

interface WorkspaceRemovalResponse {
  removed: boolean;
  sessionsEnded: number;
}

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function reportError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) say(JSON.stringify({ ok: false, error: message }));
  else say(`✗ ${message}`);
  process.exitCode = 1;
}

async function resolveRemovalWorkspaceId(
  runtime: Awaited<ReturnType<typeof ensureBroker>>,
  explicitId?: string
): Promise<string> {
  if (explicitId !== undefined) {
    const id = explicitId.trim();
    if (!id) throw new Error("Workspace id must not be empty.");
    return id;
  }

  const { workspaces } = await adminFetch<{ workspaces: LocalTargetRegistration[] }>(
    runtime,
    "GET",
    "/admin/workspaces"
  );
  const target = resolveContainingLocalTarget(process.cwd(), workspaces);
  if (target.kind === "unregistered" || !target.registration) {
    throw new Error("Current directory is not inside a registered workspace or valid linked worktree.");
  }
  return target.registration.id;
}

export function registerWorkspaceRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description("Unregister a workspace from the C2C installation")
    .argument("[workspace-id]", "registered workspace id; defaults to the current local target")
    .option("--json", "machine-readable output", false)
    .action(async (workspaceId: string | undefined, opts: { json: boolean }) => {
      try {
        const runtime = await ensureBroker();
        const targetId = await resolveRemovalWorkspaceId(runtime, workspaceId);
        const result = await adminFetch<WorkspaceRemovalResponse>(
          runtime,
          "POST",
          "/admin/workspace/remove",
          60_000,
          { id: targetId }
        );
        if (!result.removed) {
          throw new Error(`Workspace is not registered: ${targetId}`);
        }

        if (opts.json) {
          say(JSON.stringify({
            ok: true,
            workspaceId: targetId,
            removed: true,
            sessionsEnded: result.sessionsEnded,
          }));
          return;
        }

        say(`✓ Removed workspace ${targetId}`);
        if (result.sessionsEnded > 0) {
          say(`✓ Ended ${result.sessionsEnded} active Codex session${result.sessionsEnded === 1 ? "" : "s"}`);
        }
      } catch (error) {
        reportError(error, opts.json);
      }
    });
}
