import express, { type Request } from "express";
import type { WriteRequestService } from "../write-requests/service.js";
import { WriteRequestError } from "../write-requests/types.js";
import { WRITE_OBSERVATION_TIMEOUT_MS } from "../write-requests/read-budget.js";

function parameter(req: Request, key: string, required = false): string | undefined {
  const value = req.query[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value) throw new WriteRequestError("PATCH_INVALID", `${key} must be a non-empty string.`);
  return value;
}

/** Mounted inside the existing local admin guard, before /:id. */
export function createWriteObservationRouter(service: WriteRequestService): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const deadline = Number(parameter(req, "deadline"));
    const timeoutMs = Number.isFinite(deadline) ? Math.min(WRITE_OBSERVATION_TIMEOUT_MS, Math.max(0, deadline - Date.now())) : WRITE_OBSERVATION_TIMEOUT_MS;
    res.locals.observation = { signal: controller.signal, timeoutMs };
    req.once("aborted", abort);
    res.once("close", abort);
    res.once("finish", () => {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    });
    next();
  });
  router.get("/", async (req, res) => {
    const workspaceId = parameter(req, "workspaceId");
    const rawLimit = parameter(req, "limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WriteRequestError("PATCH_INVALID", "limit must be between 1 and 100.");
    const result = await service.observePending(workspaceId, limit, res.locals.observation);
    // A selected workspace never receives other workspaces' counts.
    res.json(workspaceId === undefined ? result : { ...result, counts: { [workspaceId]: result.counts[workspaceId] ?? 0 } });
  });
  router.get("/:id", async (req, res) => {
    const workspaceId = parameter(req, "workspaceId", true)!;
    const patch = parameter(req, "includePatch");
    if (patch !== undefined && patch !== "true" && patch !== "false") throw new WriteRequestError("PATCH_INVALID", "includePatch must be true or false.");
    res.json(await service.observeRequest(req.params.id, workspaceId, patch === "true", res.locals.observation));
  });
  return router;
}
