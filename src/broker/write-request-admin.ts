import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import { WriteRequestService } from "../write-requests/service.js";
import { WriteRequestError, type WriteRequestStatus } from "../write-requests/types.js";

const VALID_STATUSES = new Set<WriteRequestStatus>([
  "pending",
  "applied",
  "rejected",
  "stale",
  "expired",
  "failed",
]);

const STATUS_BY_CODE: Record<string, number> = {
  PATCH_INVALID: 400,
  PATCH_UNSUPPORTED_OPERATION: 400,
  PATCH_DOES_NOT_APPLY: 400,
  WRITE_ACCESS_DENIED: 403,
  WRITE_PROTECTED_PATH: 403,
  WRITE_SYMLINK_DENIED: 403,
  WRITE_REQUEST_NOT_FOUND: 404,
  WORKSPACE_UNAVAILABLE: 404,
  WORKTREE_UNAVAILABLE: 404,
  WRITE_STALE: 409,
  WRITE_TARGET_EXISTS: 409,
  WRITE_TARGET_NOT_FILE: 409,
  WRITE_PARENT_MISSING: 409,
  WRITE_REQUEST_NOT_PENDING: 409,
  WRITE_REQUEST_EXPIRED: 409,
  PATCH_TOO_LARGE: 413,
  PATCH_TOO_MANY_FILES: 413,
  WRITE_FILE_TOO_LARGE: 413,
  WRITE_APPLY_FAILED: 500,
  WRITE_RECEIPT_PERSIST_FAILED: 500,
  WRITE_ROLLBACK_FAILED: 500,
};

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WriteRequestError("PATCH_INVALID", `Query parameter ${key} must appear once.`);
  }
  return value;
}

function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WriteRequestError("PATCH_INVALID", `${key} must be a non-empty string.`);
  }
  return value;
}

function errorPayload(error: unknown): { status: number; code: string; message: string } {
  const parseError = error as { type?: string } | null;
  if (parseError?.type === "entity.too.large") {
    return { status: 413, code: "PATCH_TOO_LARGE", message: "Patch request exceeds the transport limit." };
  }
  if (error instanceof SyntaxError && "body" in error) {
    return { status: 400, code: "PATCH_INVALID", message: "Request body must be valid JSON." };
  }
  if (error instanceof WriteRequestError) {
    return {
      status: STATUS_BY_CODE[error.code] ?? 500,
      code: error.code,
      message: STATUS_BY_CODE[error.code] ? error.message : "Write request operation failed.",
    };
  }
  return { status: 500, code: "WRITE_APPLY_FAILED", message: "Write request operation failed." };
}

/** Local-only broker routes backed by the single broker-owned write lifecycle. */
export function createWriteRequestAdminRouter(
  service: WriteRequestService,
  adminGuard: RequestHandler
): express.Router {
  const router = express.Router();
  router.use(adminGuard);
  // The patch cap is 1 MiB. JSON escaping can roughly double newline-heavy patches.
  router.use(express.json({ limit: "3mb" }));

  router.post("/", async (req, res) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WriteRequestError("PATCH_INVALID", "Request body must be a JSON object.");
    }
    const workspaceId = requireBodyString(body, "workspaceId");
    const patch = requireBodyString(body, "patch");
    const worktreeId = body.worktreeId;
    if (worktreeId !== undefined && (typeof worktreeId !== "string" || worktreeId.length === 0)) {
      throw new WriteRequestError("PATCH_INVALID", "worktreeId must be a non-empty string when supplied.");
    }
    res.json(await service.createManualRequest({ workspaceId, patch, ...(typeof worktreeId === "string" ? { worktreeId } : {}) }));
  });

  router.get("/", async (req, res) => {
    const workspaceId = queryString(req, "workspaceId");
    const worktreeParam = queryString(req, "worktreeId");
    const statusParam = queryString(req, "status");
    const limitParam = queryString(req, "limit");
    if (workspaceId === "") throw new WriteRequestError("PATCH_INVALID", "workspaceId cannot be empty.");
    if (statusParam !== undefined && !VALID_STATUSES.has(statusParam as WriteRequestStatus)) {
      throw new WriteRequestError("PATCH_INVALID", "status is not a supported write-request status.");
    }
    let limit: number | undefined;
    if (limitParam !== undefined) {
      limit = Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new WriteRequestError("PATCH_INVALID", "limit must be a positive integer.");
      }
    }
    res.json({
      requests: await service.listRequests({
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(worktreeParam !== undefined ? { worktreeId: worktreeParam === "" ? null : worktreeParam } : {}),
        ...(statusParam !== undefined ? { status: statusParam as WriteRequestStatus } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
  });

  router.get("/:id", async (req, res) => {
    const includePatch = queryString(req, "includePatch") === "true";
    res.json(await service.getRequest(req.params.id, includePatch));
  });

  router.post("/:id/approve", async (req, res) => {
    res.json(await service.approveManualRequest(req.params.id));
  });

  router.post("/:id/reject", async (req, res) => {
    res.json(await service.rejectManualRequest(req.params.id));
  });

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const result = errorPayload(error);
    res.status(result.status).json({ error: result.code, message: result.message });
  };
  router.use(handleError);
  return router;
}
