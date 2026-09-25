import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import {
  WriteRequestError,
  type WriteOperation,
  type WritePrecondition,
  type WriteRequestFile,
} from "./types.js";

export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_PATCH_FILES = 50;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024;

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
  noNewline: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

interface PatchSection {
  path: string;
  operation: WriteOperation;
  hunks: Hunk[];
}

interface TextLine {
  text: string;
  eol: "\n" | "\r\n" | "";
}

export interface PreparedWriteFile extends WriteRequestFile {
  absolutePath: string;
  beforeBytes: Buffer | null;
  beforeMode?: number;
  resultBytes: Buffer;
}

export interface PreparedPatch {
  files: PreparedWriteFile[];
  receiptFiles: WriteRequestFile[];
  preconditions: WritePrecondition[];
}

function fail(code: ConstructorParameters<typeof WriteRequestError>[0], message: string): never {
  throw new WriteRequestError(code, message);
}

function unsupported(message: string): never {
  return fail("PATCH_UNSUPPORTED_OPERATION", message);
}

function parseHeaderPath(line: string, marker: "--- " | "+++ "): string {
  if (!line.startsWith(marker)) return fail("PATCH_INVALID", "Unified diff file headers are invalid.");
  const value = line.slice(marker.length).split("\t", 1)[0];
  if (!value || value.startsWith('"') || value.includes("\0")) {
    return fail("PATCH_INVALID", "Quoted or empty patch paths are unsupported.");
  }
  return value;
}

function parseRange(value: string | undefined): number {
  const count = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return fail("PATCH_INVALID", "Unified diff hunk ranges are invalid.");
  return count;
}

function parseHunk(lines: string[], index: number): { hunk: Hunk; next: number } {
  const match = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
  if (!match) return fail("PATCH_INVALID", "Unified diff hunk header is invalid.");
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) {
    return fail("PATCH_INVALID", "Unified diff hunk positions are invalid.");
  }
  const hunk: Hunk = {
    oldStart,
    oldCount: parseRange(match[2]),
    newStart,
    newCount: parseRange(match[4]),
    lines: [],
  };
  let oldSeen = 0;
  let newSeen = 0;
  let cursor = index + 1;

  while (oldSeen < hunk.oldCount || newSeen < hunk.newCount) {
    const line = lines[cursor];
    if (line === undefined) return fail("PATCH_INVALID", "Unified diff hunk is incomplete.");
    if (line === "\\ No newline at end of file") {
      markNoNewline(hunk.lines);
      cursor++;
      continue;
    }
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") {
      return fail("PATCH_INVALID", "Unified diff hunk contains an invalid line.");
    }
    const kind = prefix === " " ? "context" : prefix === "+" ? "add" : "remove";
    if ((kind !== "add" && oldSeen >= hunk.oldCount) || (kind !== "remove" && newSeen >= hunk.newCount)) {
      return fail("PATCH_INVALID", "Unified diff hunk counts do not match its lines.");
    }
    hunk.lines.push({ kind, text: line.slice(1), noNewline: false });
    if (kind !== "add") oldSeen++;
    if (kind !== "remove") newSeen++;
    cursor++;
  }

  while (lines[cursor] === "\\ No newline at end of file") {
    markNoNewline(hunk.lines);
    cursor++;
  }
  if (hunk.lines.length === 0) return fail("PATCH_INVALID", "Empty unified diff hunks are not supported.");
  return { hunk, next: cursor };
}

function markNoNewline(lines: HunkLine[]): void {
  const previous = lines.at(-1);
  if (!previous || previous.noNewline) fail("PATCH_INVALID", "Newline markers must follow one patch line.");
  previous.noNewline = true;
}

function isForbiddenMetadata(line: string): boolean {
  return /^(?:new file mode |deleted file mode |old mode |new mode |rename from |rename to |copy from |copy to |similarity index |GIT binary patch|Binary files |Subproject commit )/.test(line)
    || (/^index /.test(line) && /\s160000$/.test(line));
}

function isAllowedMetadata(line: string): boolean {
  return line === "" || line.startsWith("diff --git ") || line.startsWith("index ");
}

function normalizedPair(oldPath: string, newPath: string): { path: string; operation: WriteOperation } {
  if (oldPath === "/dev/null") {
    if (newPath === "/dev/null") return fail("PATCH_INVALID", "A patch must target a workspace-relative path.");
    const pathValue = newPath.startsWith("b/") ? newPath.slice(2) : newPath;
    return { path: pathValue, operation: "create" };
  }
  if (newPath === "/dev/null") return unsupported("Delete patches are not supported.");
  if (oldPath.startsWith("a/") && newPath.startsWith("b/") && oldPath.slice(2) === newPath.slice(2)) {
    return { path: oldPath.slice(2), operation: "update" };
  }
  if (oldPath === newPath) return { path: oldPath, operation: "update" };
  return fail("PATCH_INVALID", "Update patches must name the same logical path.");
}

function validateRelativePatchPath(input: string): string {
  if (input.trim() !== input) return fail("PATCH_INVALID", "Patch paths cannot have surrounding whitespace.");
  const value = input.replace(/\\/g, "/");
  if (
    !value ||
    value.startsWith("/") ||
    /^workspace:\/*/i.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return fail("PATCH_INVALID", "Patch paths must be normal workspace-relative paths.");
  }
  return value;
}

function parsePatch(patch: string): PatchSection[] {
  if (typeof patch !== "string") return fail("PATCH_INVALID", "Patch must be text.");
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) return fail("PATCH_TOO_LARGE", "Patch exceeds the 1 MiB limit.");
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const sections: PatchSection[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (isForbiddenMetadata(line)) return unsupported("Mode, rename, binary, and submodule patches are not supported.");
    if (isAllowedMetadata(line)) {
      cursor++;
      continue;
    }
    if (!line.startsWith("--- ")) return fail("PATCH_INVALID", "Patch must use standard unified diff file headers.");

    const oldPath = parseHeaderPath(line, "--- ");
    const nextHeader = lines[cursor + 1];
    if (!nextHeader?.startsWith("+++ ")) return fail("PATCH_INVALID", "Unified diff file headers are incomplete.");
    const newPath = parseHeaderPath(nextHeader, "+++ ");
    const normalized = normalizedPair(oldPath, newPath);
    const pathValue = validateRelativePatchPath(normalized.path);
    cursor += 2;
    const hunks: Hunk[] = [];
    while (lines[cursor]?.startsWith("@@")) {
      const parsed = parseHunk(lines, cursor);
      hunks.push(parsed.hunk);
      cursor = parsed.next;
    }
    if (normalized.operation === "update" && hunks.length === 0) {
      return fail("PATCH_INVALID", "Update patches must contain at least one hunk.");
    }
    sections.push({ path: pathValue, operation: normalized.operation, hunks });
    if (sections.length > MAX_PATCH_FILES) return fail("PATCH_TOO_MANY_FILES", "Patch exceeds the 50-file limit.");
  }
  if (sections.length === 0) return fail("PATCH_INVALID", "Patch contains no file operations.");
  return sections;
}

function pathCase(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(pathCase(root), pathCase(candidate));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalizeExistingAncestor(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertNoSymlinkComponents(workspace: Workspace, candidate: string): void {
  const relative = path.relative(workspace.root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return fail("WRITE_ACCESS_DENIED", "Patch target is outside the selected workspace.");
  }
  let current = workspace.root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return fail("WRITE_SYMLINK_DENIED", "Patch targets cannot use symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function resolveWritePath(workspace: Workspace, requestedPath: string): { abs: string; rel: string } {
  try {
    return workspace.resolve(requestedPath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "ACCESS_DENIED_SENSITIVE_FILE") {
      return fail("WRITE_ACCESS_DENIED", "Sensitive workspace files cannot be patched.");
    }
    if (error instanceof WorkspaceError) return fail("WRITE_ACCESS_DENIED", "Patch target is outside the selected workspace.");
    throw error;
  }
}

function assertWritablePathPolicy(
  workspace: Workspace,
  rel: string,
  abs: string,
  protectedRoots: readonly string[],
  requestedPath = rel
): void {
  const parts = rel.split("/").map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".git" || part === ".c2c" || part === ".c2c.json" || part === ".c2cignore")) {
    return fail("WRITE_PROTECTED_PATH", "Git and C2C control paths cannot be patched.");
  }
  for (const root of protectedRoots) {
    if (isWithin(abs, canonicalizeExistingAncestor(root))) {
      return fail("WRITE_PROTECTED_PATH", "C2C installation and state paths cannot be patched.");
    }
  }
  resolveWritePath(workspace, rel);
  assertNoSymlinkComponents(workspace, path.resolve(workspace.root, requestedPath));
}

function splitTextLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    const hasCr = index > start && text[index - 1] === "\r";
    lines.push({
      text: text.slice(start, hasCr ? index - 1 : index),
      eol: hasCr ? "\r\n" : "\n",
    });
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

function decodeSource(raw: Buffer): { text: string; bom: boolean } {
  if (raw.includes(0)) return unsupported("Binary files cannot be patched.");
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? raw.subarray(3) : raw), bom };
  } catch (error) {
    throw new WriteRequestError("PATCH_UNSUPPORTED_OPERATION", "Only valid UTF-8 text files can be patched.", { cause: error });
  }
}

function preferredEol(lines: TextLine[]): "\n" | "\r\n" {
  return lines.find((line) => line.eol !== "")?.eol as "\n" | "\r\n" | undefined ?? "\n";
}

function applyHunks(sourceText: string, hunks: Hunk[]): string {
  const source = splitTextLines(sourceText);
  const result: TextLine[] = [];
  let sourceCursor = 0;

  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const resultStart = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    const untouchedCount = start - sourceCursor;
    if (untouchedCount < 0 || start > source.length || resultStart !== result.length + untouchedCount) {
      return fail("PATCH_DOES_NOT_APPLY", "Patch hunk positions do not match the source text.");
    }
    result.push(...source.slice(sourceCursor, start));
    sourceCursor = start;
    const outputStart = result.length;
    const relevant = source.slice(start, start + hunk.oldCount);
    const hunkEol = relevant.find((line) => line.eol !== "")?.eol
      ?? result.at(-1)?.eol
      ?? source[start]?.eol
      ?? preferredEol(source);

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        result.push({ text: line.text, eol: line.noNewline ? "" : hunkEol });
        continue;
      }
      const current = source[sourceCursor];
      if (!current || current.text !== line.text || (current.eol === "") !== line.noNewline) {
        return fail("PATCH_DOES_NOT_APPLY", "Patch hunk does not exactly match the source text.");
      }
      if (line.kind === "context") result.push(current);
      sourceCursor++;
    }
    const consumed = sourceCursor - start;
    const produced = result.length - outputStart;
    if (consumed !== hunk.oldCount || produced !== hunk.newCount) {
      return fail("PATCH_INVALID", "Unified diff hunk counts do not match its lines.");
    }
  }
  result.push(...source.slice(sourceCursor));
  if (result.some((line, index) => line.eol === "" && index !== result.length - 1)) {
    return fail("PATCH_DOES_NOT_APPLY", "A no-newline marker may appear only at end of file.");
  }
  return result.map((line) => line.text + line.eol).join("");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readBoundedSource(file: string): { bytes: Buffer; mode: number } {
  let descriptor: number;
  try {
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WriteRequestError("WRITE_TARGET_NOT_FILE", "Update target no longer exists.", { cause: error });
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WriteRequestError("WRITE_SYMLINK_DENIED", "Patch targets cannot use symbolic links.", { cause: error });
    }
    throw new WriteRequestError("WRITE_ACCESS_DENIED", "Could not read the patch source file.", { cause: error });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return fail("WRITE_TARGET_NOT_FILE", "Update targets must be regular files.");
    if (stat.size > MAX_SOURCE_BYTES) return fail("WRITE_FILE_TOO_LARGE", "Source file exceeds the 1 MiB limit.");
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_SOURCE_BYTES) return fail("WRITE_FILE_TOO_LARGE", "Source file exceeds the 1 MiB limit.");
    return { bytes: buffer.subarray(0, bytesRead), mode: stat.mode & 0o7777 };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function hashBoundedFile(file: string): string {
  return sha256(readBoundedSource(file).bytes);
}

function buildResult(beforeBytes: Buffer, operation: PatchSection): Buffer {
  const { text, bom } = decodeSource(beforeBytes);
  const resultText = applyHunks(text, operation.hunks);
  const encoded = new TextEncoder().encode(resultText);
  const result = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encoded)]) : Buffer.from(encoded);
  if (result.includes(0)) return unsupported("NUL bytes are not supported in text patches.");
  if (result.length > MAX_RESULT_BYTES) return fail("WRITE_FILE_TOO_LARGE", "Result file exceeds the 1 MiB limit.");
  return result;
}

function targetExists(abs: string): fs.Stats | null {
  try {
    return fs.lstatSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function checkWritableParent(abs: string): void {
  const parent = path.dirname(abs);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail("WRITE_PARENT_MISSING", "Create target parent directory does not exist.");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("WRITE_PARENT_MISSING", "Create target parent must be a real directory.");
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch (error) {
    throw new WriteRequestError("WRITE_ACCESS_DENIED", "Target parent is not writable.", { cause: error });
  }
}

/** Parse, secure, and prepare every file entirely in memory before any write. */
export function preparePatch(
  workspace: Workspace,
  patch: string,
  protectedRoots: readonly string[] = []
): PreparedPatch {
  const sections = parsePatch(patch);
  const resolved = sections.map((section) => {
    assertNoSymlinkComponents(workspace, path.resolve(workspace.root, section.path));
    const target = resolveWritePath(workspace, section.path);
    assertWritablePathPolicy(workspace, target.rel, target.abs, protectedRoots, section.path);
    return { section, ...target };
  });

  const seen = new Set<string>();
  for (const target of resolved) {
    const key = pathCase(path.resolve(target.abs));
    if (seen.has(key)) return fail("PATCH_INVALID", "Patch contains duplicate normalized target paths.");
    seen.add(key);
  }

  const files: PreparedWriteFile[] = [];
  const preconditions: WritePrecondition[] = [];
  for (const target of resolved) {
    const exists = targetExists(target.abs);
    let beforeBytes: Buffer | null = null;
    let beforeMode: number | undefined;
    if (target.section.operation === "update") {
      if (!exists || exists.isSymbolicLink() || !exists.isFile()) {
        return fail("WRITE_TARGET_NOT_FILE", "Update targets must be existing regular files.");
      }
      assertWritablePathPolicy(workspace, target.rel, target.abs, protectedRoots, target.section.path);
      checkWritableParent(target.abs);
      const source = readBoundedSource(target.abs);
      beforeBytes = source.bytes;
      beforeMode = source.mode;
      const resultBytes = buildResult(beforeBytes, target.section);
      const baseSha256 = sha256(beforeBytes);
      const resultSha256 = sha256(resultBytes);
      const additions = target.section.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length;
      const deletions = target.section.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "remove").length;
      files.push({
        path: target.rel,
        operation: "update",
        additions,
        deletions,
        baseSha256,
        resultSha256,
        absolutePath: target.abs,
        beforeBytes,
        beforeMode,
        resultBytes,
      });
      preconditions.push({ path: target.rel, expected: "sha256", baseSha256 });
      continue;
    }

    if (exists) {
      if (exists.isSymbolicLink()) return fail("WRITE_SYMLINK_DENIED", "Patch targets cannot use symbolic links.");
      return fail("WRITE_TARGET_EXISTS", "Create target already exists.");
    }
    assertWritablePathPolicy(workspace, target.rel, target.abs, protectedRoots, target.section.path);
    checkWritableParent(target.abs);
    const resultBytes = buildResult(Buffer.alloc(0), target.section);
    const resultSha256 = sha256(resultBytes);
    const additions = target.section.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length;
    const deletions = target.section.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "remove").length;
    files.push({
      path: target.rel,
      operation: "create",
      additions,
      deletions,
      resultSha256,
      absolutePath: target.abs,
      beforeBytes: null,
      resultBytes,
    });
    preconditions.push({ path: target.rel, expected: "absent" });
  }

  return {
    files,
    receiptFiles: files.map(({ absolutePath: _absolutePath, beforeBytes: _beforeBytes, beforeMode: _beforeMode, resultBytes: _resultBytes, ...record }) => record),
    preconditions,
  };
}
