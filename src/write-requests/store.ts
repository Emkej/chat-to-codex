import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WriteReadBudget } from "./read-budget.js";
import { MAX_PATCH_BYTES } from "./patch.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { isTerminal, WriteRequestError, type WriteRequestRecord, type WriteRequestStatus } from "./types.js";

const REQUEST_ID = /^wr_[a-f0-9]{24}$/;
const TERMINAL_STATUSES = new Set<WriteRequestStatus>(["applied", "rejected", "stale", "expired", "failed"]);

function storageError(cause: unknown): WriteRequestError {
  return new WriteRequestError("WRITE_RECEIPT_PERSIST_FAILED", "Could not read or persist write-request state.",
    cause instanceof Error ? { cause } : undefined);
}

function isRecord(value: unknown): value is WriteRequestRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WriteRequestRecord>;
  if (
    typeof record.id !== "string" || !REQUEST_ID.test(record.id) ||
    record.kind !== "patch" ||
    !["pending", "applied", "rejected", "stale", "expired", "failed"].includes(record.status ?? "") ||
    typeof record.workspaceId !== "string" ||
    !["manual-local", "host-confirmed"].includes(record.approvalMode ?? "") ||
    !Array.isArray(record.files) || !Array.isArray(record.preconditions) ||
    typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))
  ) return false;
  if (typeof record.status !== "string") return false;
  if (record.status === "pending") return record.approvalMode === "manual-local" && typeof record.patch === "string"
    && Buffer.byteLength(record.patch, "utf8") <= MAX_PATCH_BYTES
    && typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt));
  return isTerminal(record.status) && record.patch === undefined && typeof record.resolvedAt === "string";
}

function decodeRecord(text: string, id: string): WriteRequestRecord {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.id !== id) throw new Error("Invalid write-request record.");
    return value;
  } catch (error) {
    throw storageError(error);
  }
}

/** Atomic, owner-only JSON storage. Lifecycle and approval policy stay in the service. */
export class WriteRequestStore {
  readonly directory: string;

  constructor(stateDir = getStateDir()) {
    try {
      const canonicalStateDir = fs.realpathSync.native(ensureDir(path.resolve(stateDir)));
      this.directory = ensureDir(path.join(canonicalStateDir, "write-requests"));
      fs.chmodSync(this.directory, 0o700);
    } catch (error) {
      throw storageError(error);
    }
  }

  private filePath(id: string): string {
    if (!REQUEST_ID.test(id)) throw new WriteRequestError("WRITE_REQUEST_NOT_FOUND", "Write request was not found.");
    return path.join(this.directory, id + ".json");
  }

  create(record: WriteRequestRecord): void {
    const file = this.filePath(record.id);
    if (fs.existsSync(file)) throw storageError(new Error("Write request id already exists."));
    this.writeAtomic(file, record, true);
  }

  get(id: string): WriteRequestRecord | null {
    const file = this.filePath(id);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw storageError(error);
    }
    return decodeRecord(text, id);
  }

  async getObserved(id: string, budget: WriteReadBudget): Promise<WriteRequestRecord | null> {
    budget.check();
    const file = this.filePath(id);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file, "r");
      budget.check();
      // JSON escaping can expand a 1 MiB patch sixfold; metadata is separately bounded.
      if ((await handle.stat()).size > MAX_PATCH_BYTES * 6 + 1024 * 1024) {
        throw new Error("Write-request record exceeds the storage read limit.");
      }
      budget.check();
      const text = await handle.readFile({ encoding: "utf8", signal: budget.signal });
      budget.check();
      return decodeRecord(text, id);
    } catch (error) {
      budget.check();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw storageError(error);
    } finally {
      await handle?.close();
    }
  }

  /** Sequential traversal; each record and patch die before the next read starts. */
  async visitObserved(budget: WriteReadBudget, visit: (record: WriteRequestRecord) => void): Promise<void> {
    budget.check();
    let directory: fs.Dir | undefined;
    try {
      directory = await fs.promises.opendir(this.directory);
      budget.check();
      for (;;) {
        budget.check();
        const entry = await directory.read();
        budget.check();
        if (!entry) break;
        if (!entry.name.endsWith(".json")) continue;
        await this.visitObservedFile(entry.name.slice(0, -5), budget, visit);
      }
    } catch (error) {
      budget.check();
      throw storageError(error);
    } finally {
      await directory?.close();
    }
  }

  private async visitObservedFile(id: string, budget: WriteReadBudget, visit: (record: WriteRequestRecord) => void): Promise<void> {
    const record = await this.getObserved(id, budget);
    if (!record) throw storageError(new Error("Write-request record disappeared while observing."));
    budget.check();
    visit(record);
  }

  list(): WriteRequestRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory).filter((name) => name.endsWith(".json"));
    } catch (error) {
      throw storageError(error);
    }
    return names.map((name) => {
      const id = name.slice(0, -5);
      const record = this.get(id);
      if (!record) throw storageError(new Error("Write-request record disappeared while listing."));
      return record;
    });
  }

  update(record: WriteRequestRecord): void {
    const file = this.filePath(record.id);
    if (!fs.existsSync(file)) throw new WriteRequestError("WRITE_REQUEST_NOT_FOUND", "Write request was not found.");
    this.writeAtomic(file, record, false);
  }

  remove(id: string): boolean {
    const file = this.filePath(id);
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw storageError(error);
    }
  }

  private writeAtomic(file: string, record: WriteRequestRecord, createOnly: boolean): void {
    const temp = path.join(this.directory, "." + record.id + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp");
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(record, null, 2), "utf8");
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (createOnly) {
        fs.linkSync(temp, file);
        try { fs.unlinkSync(temp); } catch { /* persisted record is already complete */ }
      } else {
        fs.renameSync(temp, file);
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
      }
      try { fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
      throw storageError(error);
    }
  }
}

export function terminalRecord(record: WriteRequestRecord, status: Exclude<WriteRequestStatus, "pending">, now: string, code?: string): WriteRequestRecord {
  const { patch: _patch, expiresAt: _expiresAt, resolutionCode: _oldCode, ...rest } = record;
  return {
    ...rest,
    status,
    resolvedAt: now,
    ...(code ? { resolutionCode: code } : {}),
  };
}

export function terminalExpired(record: WriteRequestRecord, now: string): boolean {
  return record.status === "pending" && Date.parse(record.expiresAt ?? "") <= Date.parse(now);
}

export function terminalReceiptPastRetention(record: WriteRequestRecord, cutoff: string): boolean {
  return TERMINAL_STATUSES.has(record.status) && Date.parse(record.resolvedAt ?? "") < Date.parse(cutoff);
}
