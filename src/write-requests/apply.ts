import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashBoundedFile, type PreparedPatch, type PreparedWriteFile } from "./patch.js";
import { WriteRequestError } from "./types.js";

export interface ApplyHooks {
  beforeCommit?(index: number, file: PreparedWriteFile): void | Promise<void>;
  afterCommit?(index: number, file: PreparedWriteFile): void | Promise<void>;
  beforeRollbackOwnershipCheck?(index: number, file: PreparedWriteFile): void | Promise<void>;
}

export interface RollbackResult {
  ok: boolean;
  unresolvedPaths: string[];
}

export interface ApplyTransaction {
  rollback(): Promise<RollbackResult>;
  cleanup(): Promise<void>;
}

interface StagedFile {
  file: PreparedWriteFile;
  tempPath: string;
  committed: boolean;
}

function applyError(error: unknown): WriteRequestError {
  if (error instanceof WriteRequestError) return error;
  return new WriteRequestError("WRITE_APPLY_FAILED", "Could not stage or commit the prepared patch.",
    error instanceof Error ? { cause: error } : undefined);
}

function tempPath(file: PreparedWriteFile, requestId: string): string {
  const targetHash = createHash("sha256").update(file.absolutePath).digest("hex").slice(0, 12);
  const id = requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return path.join(path.dirname(file.absolutePath), ".c2c-tmp-" + targetHash + "-" + id + "-" + randomBytes(8).toString("hex"));
}

function writeTemp(file: PreparedWriteFile, id: string, bytes: Buffer, mode: number, preserveMode: boolean): string {
  const temp = tempPath(file, id);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(descriptor, bytes);
    if (preserveMode) fs.fchmodSync(descriptor, mode);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temp;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw applyError(error);
  }
}

function removeKnownTemp(file: StagedFile): void {
  try {
    fs.unlinkSync(file.tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Temp cleanup is best-effort; normal commit/rollback remains authoritative.
    }
  }
}

function currentHashOrNull(file: PreparedWriteFile): string | null {
  try {
    return hashBoundedFile(file.absolutePath);
  } catch {
    return null;
  }
}

function restoreOne(staged: StagedFile): boolean {
  const { file } = staged;
  if (!staged.committed) return true;
  if (currentHashOrNull(file) !== file.resultSha256) return false;
  try {
    if (file.operation === "create") {
      fs.unlinkSync(file.absolutePath);
      staged.committed = false;
      return true;
    }
    if (!file.beforeBytes || file.beforeMode === undefined) return false;
    const restorePath = writeTemp(file, "rollback", file.beforeBytes, file.beforeMode, true);
    try {
      if (currentHashOrNull(file) !== file.resultSha256) return false;
      fs.renameSync(restorePath, file.absolutePath);
      staged.committed = false;
      return true;
    } finally {
      try { fs.unlinkSync(restorePath); } catch { /* renamed or best-effort cleanup */ }
    }
  } catch {
    return false;
  }
}

async function rollbackCommitted(staged: StagedFile[], hooks?: ApplyHooks): Promise<RollbackResult> {
  const unresolvedPaths: string[] = [];
  for (const [index, entry] of [...staged].reverse().entries()) {
    if (!entry.committed) continue;
    try {
      await hooks?.beforeRollbackOwnershipCheck?.(index, entry.file);
    } catch {
      unresolvedPaths.push(entry.file.path);
      continue;
    }
    if (!restoreOne(entry)) unresolvedPaths.push(entry.file.path);
  }
  return { ok: unresolvedPaths.length === 0, unresolvedPaths };
}

function assertStageMatches(staged: StagedFile): void {
  try {
    const stat = fs.lstatSync(staged.tempPath);
    if (stat.isSymbolicLink() || !stat.isFile() || hashBoundedFile(staged.tempPath) !== staged.file.resultSha256) {
      throw new Error("Staged patch content changed before commit.");
    }
  } catch (error) {
    throw new WriteRequestError("WRITE_APPLY_FAILED", "Staged patch content is unavailable or changed.",
      error instanceof Error ? { cause: error } : undefined);
  }
}

function assertUpdatePrecondition(file: PreparedWriteFile): void {
  try {
    if (hashBoundedFile(file.absolutePath) !== file.baseSha256) {
      throw new WriteRequestError("WRITE_STALE", "A patch target changed before commit.");
    }
  } catch (error) {
    if (error instanceof WriteRequestError && error.code === "WRITE_STALE") throw error;
    throw new WriteRequestError("WRITE_STALE", "A patch target could not be revalidated before commit.",
      error instanceof Error ? { cause: error } : undefined);
  }
}

function commitOne(staged: StagedFile): void {
  const { file, tempPath: stagedPath } = staged;
  assertStageMatches(staged);
  if (file.operation === "update") {
    assertUpdatePrecondition(file);
    fs.renameSync(stagedPath, file.absolutePath);
    staged.committed = true;
    return;
  }
  try {
    fs.linkSync(stagedPath, file.absolutePath);
    staged.committed = true;
    fs.unlinkSync(stagedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WriteRequestError("WRITE_STALE", "A create target appeared before commit.", { cause: error });
    }
    throw error;
  }
}

async function stageAll(prepared: PreparedPatch, requestId: string): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  try {
    for (const file of prepared.files) {
      const mode = file.operation === "update" ? file.beforeMode! : 0o666;
      staged.push({
        file,
        tempPath: writeTemp(file, requestId, file.resultBytes, mode, file.operation === "update"),
        committed: false,
      });
    }
    return staged;
  } catch (error) {
    for (const entry of staged) removeKnownTemp(entry);
    throw applyError(error);
  }
}

/** Stage every result, then commit under the caller's write-lifecycle mutex. */
export async function commitPreparedPatch(
  prepared: PreparedPatch,
  requestId: string,
  hooks?: ApplyHooks
): Promise<ApplyTransaction> {
  const staged = await stageAll(prepared, requestId);
  try {
    for (const [index, entry] of staged.entries()) {
      await hooks?.beforeCommit?.(index, entry.file);
      commitOne(entry);
      await hooks?.afterCommit?.(index, entry.file);
    }
  } catch (error) {
    const failure = applyError(error);
    const rollback = await rollbackCommitted(staged, hooks);
    for (const entry of staged) removeKnownTemp(entry);
    if (!rollback.ok) {
      throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Patch failed and one or more targets could not be safely restored.",
        failure);
    }
    throw failure;
  }

  let finished = false;
  return {
    async rollback() {
      if (finished) return { ok: true, unresolvedPaths: [] };
      const result = await rollbackCommitted(staged, hooks);
      for (const entry of staged) removeKnownTemp(entry);
      finished = true;
      return result;
    },
    async cleanup() {
      if (finished) return;
      for (const entry of staged) removeKnownTemp(entry);
      finished = true;
    },
  };
}
