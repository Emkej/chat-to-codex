import { randomBytes } from "node:crypto";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { WorktreeError } from "../workspace/worktrees.js";
import { commitPreparedPatch, type ApplyHooks } from "./apply.js";
import { preparePatch, type PreparedPatch } from "./patch.js";
import {
  terminalExpired,
  terminalReceiptPastRetention,
  terminalRecord,
  WriteRequestStore,
} from "./store.js";
import {
  toReceipt,
  WriteRequestError,
  type WritePrecondition,
  type WriteRequestFile,
  type WriteRequestReceipt,
  type WriteRequestRecord,
  type WriteRequestStatus,
} from "./types.js";

export interface ResolvedWriteTarget {
  workspace: Workspace;
  workspaceId: string;
  worktreeId?: string;
}

export type ResolveWriteTarget = (workspaceId: string, worktreeId?: string) => ResolvedWriteTarget | Promise<ResolvedWriteTarget>;

export interface WriteRequestServiceOptions {
  store: WriteRequestStore;
  resolveTarget: ResolveWriteTarget;
  protectedRoots: readonly string[];
  now?: () => number;
  newId?: () => string;
  applyHooks?: ApplyHooks;
}

export interface ListWriteRequestsOptions {
  workspaceId?: string;
  /** undefined = any worktree, null = the registered main workspace, string = that derived worktree. */
  worktreeId?: string | null;
  status?: WriteRequestStatus;
  limit?: number;
}

export type WriteRequestDetails = WriteRequestReceipt & { patch?: string };

const PENDING_TTL_MS = 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class LifecycleMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function targetError(error: unknown): WriteRequestError {
  if (error instanceof WriteRequestError) return error;
  if (error instanceof WorktreeError) {
    return new WriteRequestError("WORKTREE_UNAVAILABLE", "Selected worktree is unavailable.", { cause: error });
  }
  if (error instanceof WorkspaceError) {
    return new WriteRequestError("WORKSPACE_UNAVAILABLE", "Selected workspace is unavailable.", { cause: error });
  }
  return new WriteRequestError("WORKSPACE_UNAVAILABLE", "Selected workspace is unavailable.",
    error instanceof Error ? { cause: error } : undefined);
}

function samePreparation(record: WriteRequestRecord, prepared: PreparedPatch): boolean {
  return JSON.stringify(record.files) === JSON.stringify(prepared.receiptFiles)
    && JSON.stringify(record.preconditions) === JSON.stringify(prepared.preconditions);
}

function requestId(): string {
  return "wr_" + randomBytes(12).toString("hex");
}

function initialRecord(
  id: string,
  target: ResolvedWriteTarget,
  approvalMode: "manual-local" | "host-confirmed",
  prepared: PreparedPatch,
  now: number,
  patch?: string
): WriteRequestRecord {
  const createdAt = new Date(now).toISOString();
  return {
    id,
    kind: "patch",
    status: approvalMode === "manual-local" ? "pending" : "failed",
    workspaceId: target.workspaceId,
    ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
    approvalMode,
    files: prepared.receiptFiles,
    preconditions: prepared.preconditions,
    ...(patch !== undefined ? { patch } : {}),
    createdAt,
    ...(approvalMode === "manual-local" ? { expiresAt: new Date(now + PENDING_TTL_MS).toISOString() } : {}),
  };
}

function hostReceipt(
  base: WriteRequestRecord,
  status: Exclude<WriteRequestStatus, "pending">,
  now: number,
  code?: string
): WriteRequestRecord {
  return terminalRecord(base, status, new Date(now).toISOString(), code);
}

/** The one write lifecycle shared by all broker adapters. */
export class WriteRequestService {
  private readonly mutex = new LifecycleMutex();
  private blockedByRollback = false;
  private readonly store: WriteRequestStore;
  private readonly resolveTarget: ResolveWriteTarget;
  private readonly protectedRoots: readonly string[];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly applyHooks?: ApplyHooks;

  constructor(options: WriteRequestServiceOptions) {
    this.store = options.store;
    this.resolveTarget = options.resolveTarget;
    this.protectedRoots = options.protectedRoots;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? requestId;
    this.applyHooks = options.applyHooks;
  }

  async createManualRequest(input: { workspaceId: string; worktreeId?: string; patch: string }): Promise<WriteRequestReceipt> {
    const target = await this.resolve(input.workspaceId, input.worktreeId);
    const prepared = preparePatch(target.workspace, input.patch, this.protectedRoots);
    return this.mutex.run(async () => {
      this.assertWritable();
      this.expireAndPruneLocked();
      const record = initialRecord(this.newId(), target, "manual-local", prepared, this.now(), input.patch);
      this.store.create(record);
      return toReceipt(record);
    });
  }

  async approveManualRequest(id: string): Promise<WriteRequestReceipt> {
    return this.mutex.run(async () => {
      this.assertWritable();
      this.expireAndPruneLocked();
      const request = this.requireRequest(id);
      if (request.status === "expired") throw new WriteRequestError("WRITE_REQUEST_EXPIRED", "Write request has expired.");
      if (request.status !== "pending" || request.approvalMode !== "manual-local") {
        throw new WriteRequestError("WRITE_REQUEST_NOT_PENDING", "Write request is no longer pending.");
      }

      let prepared: PreparedPatch;
      try {
        const target = await this.resolve(request.workspaceId, request.worktreeId);
        prepared = preparePatch(target.workspace, request.patch!, this.protectedRoots);
        if (!samePreparation(request, prepared)) throw new WriteRequestError("WRITE_STALE", "A patch precondition changed.");
      } catch (error) {
        return this.persistStale(request, error);
      }

      let transaction;
      try {
        transaction = await commitPreparedPatch(prepared, request.id, this.applyHooks);
      } catch (error) {
        return this.persistApplyFailure(request, error);
      }

      const applied = terminalRecord(request, "applied", new Date(this.now()).toISOString());
      try {
        this.store.update(applied);
      } catch (error) {
        const rollback = await transaction.rollback();
        await transaction.cleanup();
        if (!rollback.ok) {
          this.blockedByRollback = true;
          throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Receipt persistence failed and workspace rollback was unresolved.",
            error instanceof Error ? { cause: error } : undefined);
        }
        throw error;
      }
      await transaction.cleanup();
      return toReceipt(applied);
    });
  }

  async rejectManualRequest(id: string): Promise<WriteRequestReceipt> {
    return this.mutex.run(async () => {
      this.assertWritable();
      this.expireAndPruneLocked();
      const request = this.requireRequest(id);
      if (request.status === "expired") throw new WriteRequestError("WRITE_REQUEST_EXPIRED", "Write request has expired.");
      if (request.status !== "pending" || request.approvalMode !== "manual-local") {
        throw new WriteRequestError("WRITE_REQUEST_NOT_PENDING", "Write request is no longer pending.");
      }
      const rejected = terminalRecord(request, "rejected", new Date(this.now()).toISOString());
      this.store.update(rejected);
      return toReceipt(rejected);
    });
  }

  async applyHostConfirmedPatch(input: { workspaceId: string; worktreeId?: string; patch: string }): Promise<WriteRequestReceipt> {
    const target = await this.resolve(input.workspaceId, input.worktreeId);
    const prepared = preparePatch(target.workspace, input.patch, this.protectedRoots);
    const base = initialRecord(this.newId(), target, "host-confirmed", prepared, this.now());
    return this.mutex.run(async () => {
      this.assertWritable();
      let current: PreparedPatch;
      try {
        const resolved = await this.resolve(input.workspaceId, input.worktreeId);
        current = preparePatch(resolved.workspace, input.patch, this.protectedRoots);
        if (!samePreparation(base, current)) throw new WriteRequestError("WRITE_STALE", "A patch precondition changed.");
      } catch (error) {
        const stale = hostReceipt(base, "stale", this.now(), this.underlyingCode(error));
        this.store.create(stale);
        throw new WriteRequestError("WRITE_STALE", "Patch target changed before commit.");
      }

      let transaction;
      try {
        transaction = await commitPreparedPatch(current, base.id, this.applyHooks);
      } catch (error) {
        return this.persistHostFailure(base, error);
      }

      const applied = hostReceipt(base, "applied", this.now());
      try {
        this.store.create(applied);
      } catch (error) {
        const rollback = await transaction.rollback();
        await transaction.cleanup();
        if (!rollback.ok) {
          this.blockedByRollback = true;
          throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Receipt persistence failed and workspace rollback was unresolved.",
            error instanceof Error ? { cause: error } : undefined);
        }
        throw error;
      }
      await transaction.cleanup();
      return toReceipt(applied);
    });
  }

  async listRequests(options: ListWriteRequestsOptions = {}): Promise<WriteRequestReceipt[]> {
    return this.mutex.run(async () => {
      if (!this.blockedByRollback) this.expireAndPruneLocked();
      const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
      return this.store.list()
        .filter((record) => options.workspaceId === undefined || record.workspaceId === options.workspaceId)
        .filter((record) => options.worktreeId === undefined || record.worktreeId === (options.worktreeId ?? undefined))
        .filter((record) => options.status === undefined || record.status === options.status)
        .sort(
          (a, b) =>
            Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt) ||
            a.id.localeCompare(b.id)
        )
        .slice(0, limit)
        .map(toReceipt);
    });
  }

  async getRequest(id: string, includePatch = false): Promise<WriteRequestDetails> {
    return this.mutex.run(async () => {
      if (!this.blockedByRollback) this.expireAndPruneLocked();
      const record = this.requireRequest(id);
      return { ...toReceipt(record), ...(includePatch && record.patch !== undefined ? { patch: record.patch } : {}) };
    });
  }

  private async resolve(workspaceId: string, worktreeId?: string): Promise<ResolvedWriteTarget> {
    try {
      return await this.resolveTarget(workspaceId, worktreeId);
    } catch (error) {
      throw targetError(error);
    }
  }

  private assertWritable(): void {
    if (this.blockedByRollback) {
      throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Broker writes are blocked after an unresolved rollback.");
    }
  }

  private requireRequest(id: string): WriteRequestRecord {
    const record = this.store.get(id);
    if (!record) throw new WriteRequestError("WRITE_REQUEST_NOT_FOUND", "Write request was not found.");
    return record;
  }

  private underlyingCode(error: unknown): string {
    if (error instanceof WriteRequestError) return error.code;
    return targetError(error).code;
  }

  private persistStale(request: WriteRequestRecord, cause: unknown): never {
    const stale = terminalRecord(request, "stale", new Date(this.now()).toISOString(), this.underlyingCode(cause));
    this.store.update(stale);
    throw new WriteRequestError("WRITE_STALE", "Write request is stale and was not applied.",
      cause instanceof Error ? { cause } : undefined);
  }

  private persistApplyFailure(request: WriteRequestRecord, error: unknown): never {
    const failure = error instanceof WriteRequestError ? error : new WriteRequestError("WRITE_APPLY_FAILED", "Patch application failed.",
      error instanceof Error ? { cause: error } : undefined);
    if (failure.code === "WRITE_STALE") return this.persistStale(request, failure);
    if (failure.code === "WRITE_ROLLBACK_FAILED") this.blockedByRollback = true;
    const failed = terminalRecord(request, "failed", new Date(this.now()).toISOString(), failure.code);
    try {
      this.store.update(failed);
    } catch (error) {
      if (failure.code === "WRITE_ROLLBACK_FAILED") {
        throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Rollback was unresolved and its failure receipt could not be persisted.",
          { cause: new AggregateError([failure, error], "Rollback and failure-receipt persistence both failed.") });
      }
      throw error;
    }
    throw failure;
  }

  private persistHostFailure(base: WriteRequestRecord, error: unknown): never {
    const failure = error instanceof WriteRequestError ? error : new WriteRequestError("WRITE_APPLY_FAILED", "Patch application failed.",
      error instanceof Error ? { cause: error } : undefined);
    const status = failure.code === "WRITE_STALE" ? "stale" : "failed";
    if (failure.code === "WRITE_ROLLBACK_FAILED") this.blockedByRollback = true;
    try {
      this.store.create(hostReceipt(base, status, this.now(), failure.code));
    } catch (error) {
      if (failure.code === "WRITE_ROLLBACK_FAILED") {
        throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Rollback was unresolved and its failure receipt could not be persisted.",
          { cause: new AggregateError([failure, error], "Rollback and failure-receipt persistence both failed.") });
      }
      throw error;
    }
    throw failure;
  }

  private expireAndPruneLocked(): void {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const cutoff = new Date(now - TERMINAL_RETENTION_MS).toISOString();
    for (const record of this.store.list()) {
      if (terminalExpired(record, nowIso)) {
        this.store.update(terminalRecord(record, "expired", nowIso, "WRITE_REQUEST_EXPIRED"));
      } else if (terminalReceiptPastRetention(record, cutoff)) {
        this.store.remove(record.id);
      }
    }
  }
}
