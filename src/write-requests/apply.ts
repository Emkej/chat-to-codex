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

function tempPath(file: PreparedWriteFile, requestId: string, stagingDirectory = path.dirname(file.absolutePath)): string {
  const targetHash = createHash("sha256").update(file.absolutePath).digest("hex").slice(0, 12);
  const id = requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return path.join(stagingDirectory, ".c2c-tmp-" + targetHash + "-" + id + "-" + randomBytes(8).toString("hex"));
}

function writeTemp(
  file: PreparedWriteFile,
  id: string,
  bytes: Buffer,
  mode: number,
  preserveMode: boolean,
  stagingDirectory = path.dirname(file.absolutePath)
): string {
  const temp = tempPath(file, id, stagingDirectory);
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

function assertExistingDirectoryPath(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WriteRequestError("WRITE_ACCESS_DENIED", "Create path is outside the selected workspace.");
  }
  let current = workspaceRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      throw new WriteRequestError("WRITE_STALE", "A create parent changed before commit.",
        error instanceof Error ? { cause: error } : undefined);
    }
    if (stat.isSymbolicLink()) throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Create parents cannot use symbolic links.");
    if (!stat.isDirectory()) throw new WriteRequestError("WRITE_STALE", "A create parent is no longer a directory.");
  }
}

function assertCreateTargetReady(file: PreparedWriteFile): void {
  const relative = path.relative(file.workspaceRoot, file.absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WriteRequestError("WRITE_ACCESS_DENIED", "Create target is outside the selected workspace.");
  }
  let current = file.workspaceRoot;
  const components = relative.split(path.sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === components.length - 1) return;
      throw new WriteRequestError("WRITE_STALE", "A create ancestor changed before commit.",
        error instanceof Error ? { cause: error } : undefined);
    }
    if (index === components.length - 1) {
      if (stat.isSymbolicLink()) throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Create targets cannot use symbolic links.");
      throw new WriteRequestError("WRITE_STALE", "A create target appeared before commit.");
    }
    if (stat.isSymbolicLink()) throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Create parents cannot use symbolic links.");
    if (!stat.isDirectory()) throw new WriteRequestError("WRITE_STALE", "A create parent is no longer a directory.");
  }
}

function plannedCreateDirectories(prepared: PreparedPatch): string[] {
  const paths = new Map<string, string>();
  for (const file of prepared.files) {
    for (const directory of file.createDirectories ?? []) {
      const key = process.platform === "win32" || process.platform === "darwin" ? directory.toLowerCase() : directory;
      paths.set(key, directory);
    }
  }
  return [...paths.values()].sort((left, right) => {
    const leftDepth = left.split(path.sep).length;
    const rightDepth = right.split(path.sep).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
}

function createDirectories(prepared: PreparedPatch): string[] {
  const created: string[] = [];
  for (const directory of plannedCreateDirectories(prepared)) {
    const owner = prepared.files.find((file) => (file.createDirectories ?? []).includes(directory));
    if (!owner) throw new WriteRequestError("WRITE_STALE", "Create directory ownership could not be revalidated.");
    assertExistingDirectoryPath(owner.workspaceRoot, path.dirname(directory));
    try {
      const existing = fs.lstatSync(directory);
      if (existing.isSymbolicLink()) throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Create parents cannot use symbolic links.");
      if (!existing.isDirectory()) throw new WriteRequestError("WRITE_STALE", "A create parent is no longer a directory.");
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      fs.mkdirSync(directory, { mode: 0o777 });
      created.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = fs.lstatSync(directory);
      if (existing.isSymbolicLink()) throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Create parents cannot use symbolic links.");
      if (!existing.isDirectory()) throw new WriteRequestError("WRITE_STALE", "A create parent is no longer a directory.");
    }
  }
  return created;
}

function removeCreatedDirectories(directories: string[]): RollbackResult {
  const unresolvedPaths: string[] = [];
  for (const directory of [...directories].reverse()) {
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(directory).length > 0) {
        unresolvedPaths.push(directory);
        continue;
      }
      fs.rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unresolvedPaths.push(directory);
    }
  }
  return { ok: unresolvedPaths.length === 0, unresolvedPaths };
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
    assertCreateTargetReady(file);
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
      const stagingDirectory = file.operation === "create" ? file.stagingDirectory : undefined;
      if (stagingDirectory) assertExistingDirectoryPath(file.workspaceRoot, stagingDirectory);
      staged.push({
        file,
        tempPath: writeTemp(file, requestId, file.resultBytes, mode, file.operation === "update", stagingDirectory),
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
  let createdDirectories: string[] = [];
  try {
    createdDirectories = createDirectories(prepared);
    for (const [index, entry] of staged.entries()) {
      await hooks?.beforeCommit?.(index, entry.file);
      commitOne(entry);
      await hooks?.afterCommit?.(index, entry.file);
    }
  } catch (error) {
    const failure = applyError(error);
    const rollback = await rollbackCommitted(staged, hooks);
    const directoryRollback = removeCreatedDirectories(createdDirectories);
    for (const entry of staged) removeKnownTemp(entry);
    if (!rollback.ok || !directoryRollback.ok) {
      throw new WriteRequestError("WRITE_ROLLBACK_FAILED", "Patch failed and one or more targets could not be safely restored.",
        new AggregateError([failure, ...rollback.unresolvedPaths.map((value) => new Error(value)), ...directoryRollback.unresolvedPaths.map((value) => new Error(value))]));
    }
    throw failure;
  }

  let finished = false;
  return {
    async rollback() {
      if (finished) return { ok: true, unresolvedPaths: [] };
      const files = await rollbackCommitted(staged, hooks);
      const directories = removeCreatedDirectories(createdDirectories);
      for (const entry of staged) removeKnownTemp(entry);
      finished = true;
      return {
        ok: files.ok && directories.ok,
        unresolvedPaths: [...files.unresolvedPaths, ...directories.unresolvedPaths],
      };
    },
    async cleanup() {
      if (finished) return;
      for (const entry of staged) removeKnownTemp(entry);
      finished = true;
    },
  };
}
