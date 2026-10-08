import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { COMMAND_SCOPE } from "../command-requests/types.js";
import { commandCreationReceipt, commandReceipt } from "../command-requests/receipt.js";
import type { CommandRequestService } from "../command-requests/service.js";
import type { Workspace } from "../workspace/manager.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Target = { workspace: Workspace; registration: { id: string } | null; worktreeId?: string };
interface Dependencies {
  service: CommandRequestService;
  resolveTarget: (args: { workspace?: string; worktree?: string }) => Target | Result;
  requireScope: (auth: AuthInfo | undefined, scope: string) => Result | null;
  ok: (value: unknown) => Result;
  fail: (code: string, message: string) => Result;
  mapError: (error: unknown) => Result;
}
/** Broker-only feature; reuses the broker resolver and existing JSON-text helpers. */
export function registerCommandTools(server: McpServer, deps: Dependencies): void {
  const selectors = {
    workspace: z.string().catch("").optional().describe("Opaque registered workspace id; omission requires exactly one registration"),
    worktree: z.string().catch("").optional().describe("Opaque worktree id from list_worktrees"),
  };
  function target(args: { workspace?: string; worktree?: string }): Target | Result {
    const resolved = deps.resolveTarget(args);
    if (!("content" in resolved)) return resolved;
    const code = JSON.parse(resolved.content[0]!.text).error as string;
    if (code === "WORKSPACE_REQUIRED") return resolved;
    return deps.fail(args.worktree !== undefined && code !== "UNKNOWN_WORKSPACE" && code !== "WORKSPACE_UNAVAILABLE"
      ? "WORKTREE_UNAVAILABLE" : "WORKSPACE_UNAVAILABLE", "Command target is unavailable.");
  }
  server.registerTool("request_command", {
    title: "Request a locally approved command",
    description: "Save exact argv/cwd for explicit local c2c approve cr_... approval. Creation starts no process. Approval is not sandboxing; output may disclose local data. Requires workspace.command.",
    // Invalid values reach domain validation instead of escaping as SDK-specific error text.
    inputSchema: { ...selectors, argv: z.array(z.string()).catch([]), cwd: z.string().catch("\0").optional(), reason: z.string().catch("") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, COMMAND_SCOPE); if (denied) return denied;
    const resolved = target(args); if ("content" in resolved) return resolved;
    try {
      const record = await deps.service.create({
        workspaceId: resolved.registration!.id, ...(resolved.worktreeId ? { worktreeId: resolved.worktreeId } : {}),
        argv: args.argv, cwd: args.cwd, reason: args.reason,
      });
      return deps.ok(commandCreationReceipt(record));
    } catch (error) { return deps.mapError(error); }
  });
  server.registerTool("get_command_request", {
    title: "Inspect one command request",
    description: "Observational receipt read for the selected target. running alone does not confirm spawn; inspect started_at. Nonzero exit remains completed. Inspect output_incomplete before claiming complete capture. Requires workspace.command.",
    inputSchema: { ...selectors, request_id: z.string().catch(""), max_output_bytes: z.number().catch(NaN).optional().describe("UTF-8 bytes per stream, default 8192, integer 0–65536") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, COMMAND_SCOPE); if (denied) return denied;
    const resolved = target(args); if ("content" in resolved) return resolved;
    try {
      return deps.ok(commandReceipt(deps.service.get(args.request_id, {
        workspaceId: resolved.registration!.id, ...(resolved.worktreeId ? { worktreeId: resolved.worktreeId } : {}),
      }), args.max_output_bytes));
    } catch (error) { return deps.mapError(error); }
  });
}
