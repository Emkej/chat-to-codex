import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { CommandRequestService } from "../command-requests/service.js";
import { localCommandReceipt } from "../command-requests/receipt.js";
import { CommandRequestError } from "../command-requests/types.js";

/** Guard every route before parsing. No remote approval tool is registered. */
export function createCommandRequestAdminRouter(service: CommandRequestService, guard: RequestHandler): express.Router {
  const router = express.Router();
  router.use(guard);
  router.get("/", (req, res) => {
    const { workspaceId, worktreeId } = req.query;
    if ((workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId)) ||
      (worktreeId !== undefined && typeof worktreeId !== "string") || (worktreeId && !workspaceId)) {
      throw new CommandRequestError("COMMAND_INVALID", "Invalid command target filter.");
    }
    const target = typeof workspaceId === "string"
      ? { workspaceId, ...(worktreeId ? { worktreeId: worktreeId as string } : {}) } : undefined;
    res.json({ requests: service.listPending(target).map((r) => localCommandReceipt(r, false)) });
  });
  router.get("/:id", (req, res) => {
    const output = req.query.output;
    if (output !== undefined && output !== "true" && output !== "false") throw new CommandRequestError("COMMAND_INVALID", "Invalid output selector.");
    res.json(localCommandReceipt(service.get(req.params.id), output === "true"));
  });
  router.post("/:id/approve", async (req, res) => {
    res.json(localCommandReceipt(await service.approve(req.params.id), false));
  });
  router.post("/:id/reject", async (req, res) => {
    res.json(localCommandReceipt(await service.reject(req.params.id), false));
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof CommandRequestError) {
      const status = error.code === "COMMAND_INVALID" ? 400 :
        ["COMMAND_REQUEST_NOT_FOUND", "WORKSPACE_UNAVAILABLE", "WORKTREE_UNAVAILABLE"].includes(error.code) ? 404 :
        ["COMMAND_BUSY", "COMMAND_REQUEST_EXPIRED", "COMMAND_REQUEST_NOT_PENDING", "COMMAND_RESULT_UNAVAILABLE"].includes(error.code) ? 409 : 500;
      res.status(status).json({ error: error.code, message: error.message });
    } else res.status(500).json({ error: "INTERNAL_ERROR", message: "Command operation failed." });
  };
  router.use(errorHandler);
  return router;
}
