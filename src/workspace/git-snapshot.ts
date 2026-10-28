import { spawn, spawnSync } from "node:child_process";
import { IgnoreRules } from "./ignore.js";
import {
  gitPathsKey,
  gitSummaryForChange,
  gitSummaryLimits,
  paginateGitSummaries,
  parseGitNameStatus,
  parseGitNumstat,
  runGit,
  sanitizedGitEnvironment,
  type GitChangeRecord,
  type GitChangeSummary,
  type GitDiffView,
  type GitNumstatRecord,
  type GitSummaryTruncationReason,
} from "./git.js";
import {
  resolveLocalWorktree,
  type WorktreeRunner,
} from "./worktrees.js";

const DEFAULT_BRANCH_LIMIT = 200;
const MAX_BRANCH_LIMIT = 1000;
const DEFAULT_DIRECTORY_LIMIT = 200;
const MAX_DIRECTORY_LIMIT = 1000;
const DEFAULT_TEXT_LINES = 400;
const MAX_TEXT_LINES = 2000;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_RETURNED_TEXT_BYTES = 256 * 1024;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_MATCH_TEXT = 500;
const MAX_SEARCH_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMPARE_PAGE_BYTES = 64 * 1024;
const MAX_COMPARE_PAGE_BYTES = 256 * 1024;
const MAX_COMPARE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = MAX_COMPARE_BYTES + 1;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const MAX_HISTORY_OFFSET = 10_000;
const MAX_HISTORY_SCAN_COMMITS = 10_000;
const MAX_HISTORY_PATHS_PER_COMMIT = 50;
const MAX_HISTORY_SUBJECT_BYTES = 500;
const MAX_HISTORY_AUTHOR_BYTES = 200;
const MAX_HISTORY_OUTPUT_BYTES = 8 * 1024 * 1024;

export type SnapshotErrorCode =
  | "REPOSITORY_SCOPE_UNAVAILABLE"
  | "PROMISOR_REPOSITORY_UNSUPPORTED"
  | "INVALID_REF"
  | "REF_NOT_FOUND"
  | "REF_NOT_COMMIT"
  | "REF_CHANGED"
  | "CONTINUATION_PRECONDITION_REQUIRED"
  | "INVALID_PATH"
  | "INVALID_ARGUMENT"
  | "PATH_NOT_FOUND"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "NO_MERGE_BASE"
  | "DIFF_TOO_LARGE"
  | "HISTORY_TOO_LARGE"
  | "SEARCH_FAILED"
  | "GIT_READ_FAILED";

export class SnapshotError extends Error {
  constructor(public readonly code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface RepositorySnapshotOwner {
  root: string;
  repositoryIdentity: string;
  ignoreRules: IgnoreRules;
}

export interface RepositorySnapshotOwnerOptions {
  runner?: WorktreeRunner;
  ignoreRules?: IgnoreRules;
}

export type PublicRefKind = "local" | "remote_tracking";

export interface PublicRef {
  ref: string;
  name: string;
  kind: PublicRefKind;
}

export interface ResolvedPublicRef extends PublicRef {
  commit: string;
}

export interface ListBranchesOptions {
  offset?: number;
  limit?: number;
}

export interface ListBranchesResult {
  branches: ResolvedPublicRef[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export type SnapshotEntryType = "file" | "directory" | "symlink" | "gitlink";

export interface SnapshotDirectoryEntry {
  path: string;
  type: SnapshotEntryType;
  oid: string;
  sizeBytes?: number;
}

export interface BrowseDirectoryResult {
  ref: string;
  commit: string;
  path: string;
  kind: "directory";
  entries: SnapshotDirectoryEntry[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface BrowseFileResult {
  ref: string;
  commit: string;
  path: string;
  kind: "file";
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

export interface BrowseSymlinkResult {
  ref: string;
  commit: string;
  path: string;
  kind: "symlink";
  target: string;
}

export interface BrowseGitlinkResult {
  ref: string;
  commit: string;
  path: string;
  kind: "gitlink";
  oid: string;
}

export type BrowseSnapshotResult =
  | BrowseDirectoryResult
  | BrowseFileResult
  | BrowseSymlinkResult
  | BrowseGitlinkResult;

export interface BrowseSnapshotOptions {
  ref: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  offset?: number;
  limit?: number;
  expectedCommit?: string;
}

export interface SearchSnapshotOptions {
  ref: string;
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SnapshotSearchMatch {
  path: string;
  line: number;
  text: string;
}

export type SearchTruncationReason = "match_limit" | "output_limit" | null;

export interface SearchSnapshotResult {
  ref: string;
  commit: string;
  matches: SnapshotSearchMatch[];
  matchCount: number;
  truncated: boolean;
  truncationReason: SearchTruncationReason;
}

export interface CompareSnapshotOptions {
  baseRef: string;
  targetRef: string;
  path?: string;
  offset?: number;
  maxBytes?: number;
  view?: GitDiffView;
  summaryOffset?: number;
  expectedBaseCommit?: string;
  expectedTargetCommit?: string;
}

export interface CompareSnapshotResult {
  comparison: "merge_base_to_target";
  baseRef: string;
  targetRef: string;
  baseCommit: string;
  targetCommit: string;
  mergeBase: string;
  view: GitDiffView;
  offset: number;
  maxBytes: number;
  totalBytes: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
  summary?: GitChangeSummary[];
  summaryOffset?: number;
  summaryLimit?: number;
  summaryCount?: number;
  totalSummaryFiles?: number;
  nextSummaryOffset?: number | null;
  summaryTruncated?: boolean;
  truncationReason?: GitSummaryTruncationReason;
}

export interface HistorySnapshotOptions {
  ref: string;
  path?: string;
  limit?: number;
  offset?: number;
  expectedCommit?: string;
}

export type HistoryChangeType = "add" | "modify" | "delete" | "rename" | "copy" | "typechange" | "unmerged" | "unknown";

export interface HistoryPathChange {
  path: string;
  changeType: HistoryChangeType;
}

export interface HistoryEntry {
  commit: string;
  timestamp: string;
  author: string;
  subject: string;
  paths: HistoryPathChange[];
  pathsTruncated: boolean;
}

export interface HistorySnapshotResult {
  ref: string;
  commit: string;
  offset: number;
  limit: number;
  entries: HistoryEntry[];
  hasMore: boolean;
  nextOffset: number | null;
  truncated: boolean;
  truncationReason: "scan_limit" | "output_limit" | null;
}

interface RawGitResult {
  ok: boolean;
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  overflow: boolean;
}

interface ParsedTreeEntry {
  mode: string;
  gitType: string;
  oid: string;
  path: string;
  sizeBytes?: number;
}

interface ParsedSearchRecord {
  path: string;
  line: number;
  text: string;
}

function rawBuffer(value: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value ?? "", "utf8");
}

function runSnapshotGit(root: string, args: string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): RawGitResult {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    env: sanitizedGitEnvironment(),
    encoding: null,
    maxBuffer,
    timeout: 30_000,
  });
  const errorText = result.error?.message ?? "";
  return {
    ok: result.status === 0,
    stdout: rawBuffer(result.stdout),
    stderr: rawBuffer(result.stderr),
    code: result.status,
    overflow: errorText.includes("maxBuffer") || errorText.includes("ENOBUFS"),
  };
}

function snapshotText(result: RawGitResult): string {
  return result.stdout.toString("utf8");
}

function commandFailure(code: SnapshotErrorCode = "GIT_READ_FAILED"): never {
  throw new SnapshotError(code, "Repository snapshot read failed.");
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new SnapshotError("INVALID_ARGUMENT", "Invalid numeric argument.");
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const result = boundedInteger(value, fallback, maximum);
  return Math.max(1, result);
}

function assertSnapshotRepositorySupported(owner: RepositorySnapshotOwner): void {
  const result = runSnapshotGit(
    owner.root,
    ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"],
    64 * 1024
  );
  if (!result.ok && result.code !== 1) {
    throw new SnapshotError(
      "PROMISOR_REPOSITORY_UNSUPPORTED",
      "Repository snapshot inspection is unavailable for this repository."
    );
  }

  for (const line of snapshotText(result).split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, rawKey, value] = match;
    const key = rawKey.toLowerCase();
    if (
      key === "extensions.partialclone" ||
      (/^remote\..+\.promisor$/.test(key) && /^(true|yes|on|1)$/i.test(value))
    ) {
      throw new SnapshotError(
        "PROMISOR_REPOSITORY_UNSUPPORTED",
        "Repository snapshot inspection is unavailable for partial or promisor repositories."
      );
    }
  }
}

/** Resolve repository-wide authority only from a registered main worktree root. */
export function resolveRepositoryOwner(
  root: string,
  options: RepositorySnapshotOwnerOptions = {}
): RepositorySnapshotOwner {
  const target = resolveLocalWorktree(root, options.runner ?? ((candidate, args, gitDir) => runGit(candidate, args, gitDir)));
  if (!target || target.kind !== "main") {
    throw new SnapshotError(
      "REPOSITORY_SCOPE_UNAVAILABLE",
      "Repository snapshot inspection requires a registered main worktree."
    );
  }
  return {
    root: target.root,
    repositoryIdentity: target.repositoryIdentity,
    ignoreRules: options.ignoreRules ?? new IgnoreRules(target.root),
  };
}

function validRefComponent(component: string): boolean {
  return (
    component.length > 0 &&
    component !== "." &&
    component !== ".." &&
    !component.startsWith(".") &&
    !component.endsWith(".") &&
    !component.endsWith(".lock")
  );
}

function validRefName(ref: string): boolean {
  if (!ref || ref === "@" || ref.includes("..") || ref.includes("@{")) return false;
  if (/[\x00-\x20~^:?*\[\\]/.test(ref)) return false;
  if (ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) return false;
  return ref.split("/").every(validRefComponent);
}

/** Validate the deliberately narrow public ref namespace without parsing a revspec. */
export function validatePublicRef(ref: string): PublicRef {
  if (typeof ref !== "string" || !validRefName(ref)) {
    throw new SnapshotError("INVALID_REF", "Only exact local or remote-tracking branch refs are allowed.");
  }
  if (ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length) {
    return { ref, name: ref.slice("refs/heads/".length), kind: "local" };
  }
  if (ref.startsWith("refs/remotes/") && ref.length > "refs/remotes/".length && !ref.endsWith("/HEAD")) {
    return { ref, name: ref.slice("refs/remotes/".length), kind: "remote_tracking" };
  }
  throw new SnapshotError("INVALID_REF", "Only exact local or remote-tracking branch refs are allowed.");
}

function assertExpectedCommit(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new SnapshotError("REF_CHANGED", "The referenced branch changed during pagination.");
  }
}

/** Resolve an allowed ref to a server-selected commit OID. */
export function resolveBranchRef(owner: RepositorySnapshotOwner, ref: string): ResolvedPublicRef {
  assertSnapshotRepositorySupported(owner);
  const publicRef = validatePublicRef(ref);
  const metadata = runSnapshotGit(owner.root, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)",
    publicRef.ref,
  ], 64 * 1024);
  if (!metadata.ok) throw new SnapshotError("REF_NOT_FOUND", "The requested branch ref was not found.");
  const metadataLine = snapshotText(metadata).split(/\r?\n/).find(Boolean);
  const [resolvedRef, symbolicTarget = ""] = metadataLine?.split("\0") ?? [];
  if (resolvedRef !== publicRef.ref) {
    throw new SnapshotError("REF_NOT_FOUND", "The requested branch ref was not found.");
  }
  if (symbolicTarget) {
    throw new SnapshotError("INVALID_REF", "Symbolic branch aliases are not allowed.");
  }
  const resolved = runSnapshotGit(owner.root, ["show-ref", "--verify", "--hash", publicRef.ref], 64 * 1024);
  if (!resolved.ok) throw new SnapshotError("REF_NOT_FOUND", "The requested branch ref was not found.");
  const lines = snapshotText(resolved).split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !lines[0]) throw new SnapshotError("REF_NOT_FOUND", "The requested branch ref was not found.");

  const commit = lines[0];
  const type = runSnapshotGit(owner.root, ["cat-file", "-t", commit], 64 * 1024);
  if (!type.ok || snapshotText(type).trim() !== "commit") {
    throw new SnapshotError("REF_NOT_COMMIT", "The requested branch ref does not point to a commit.");
  }
  return { ...publicRef, commit };
}

function parseBranchPage(
  output: Buffer,
  offset: number,
  limit: number
): { branches: ResolvedPublicRef[]; hasMore: boolean } {
  const branches: ResolvedPublicRef[] = [];
  let remainingOffset = offset;
  let hasMore = false;
  for (const line of output.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("\0");
    if (fields.length < 4) continue;
    const [ref, commit, symref, type] = fields;
    if (!ref || !commit || symref || type !== "commit") continue;
    if (ref.startsWith("refs/heads/")) {
      if (remainingOffset > 0) {
        remainingOffset--;
        continue;
      }
      if (branches.length >= limit) {
        hasMore = true;
        break;
      }
      branches.push({ ref, name: ref.slice("refs/heads/".length), kind: "local", commit });
    } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      if (remainingOffset > 0) {
        remainingOffset--;
        continue;
      }
      if (branches.length >= limit) {
        hasMore = true;
        break;
      }
      branches.push({ ref, name: ref.slice("refs/remotes/".length), kind: "remote_tracking", commit });
    }
  }
  return { branches, hasMore };
}

export function listBranches(
  owner: RepositorySnapshotOwner,
  options: ListBranchesOptions = {}
): ListBranchesResult {
  assertSnapshotRepositorySupported(owner);
  const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedPositiveInteger(options.limit, DEFAULT_BRANCH_LIMIT, MAX_BRANCH_LIMIT);
  const result = runSnapshotGit(owner.root, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!result.ok) commandFailure();
  const page = parseBranchPage(result.stdout, offset, limit);
  return {
    branches: page.branches,
    offset,
    limit,
    hasMore: page.hasMore,
  };
}

export function normalizeRepositoryPath(requested: string | undefined): string {
  if (requested === undefined || requested === "" || requested === ".") return "";
  if (typeof requested !== "string" || requested.includes("\0")) {
    throw new SnapshotError("INVALID_PATH", "Invalid repository path.");
  }
  const value = requested.replace(/\\/g, "/");
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.startsWith("//")) {
    throw new SnapshotError("INVALID_PATH", "Repository paths must be relative.");
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new SnapshotError("INVALID_PATH", "Repository paths cannot traverse upward.");
    parts.push(part);
  }
  return parts.join("/");
}

function assertReadablePath(owner: RepositorySnapshotOwner, path: string): void {
  if (path && owner.ignoreRules.isSensitive(path)) {
    throw new SnapshotError(
      "ACCESS_DENIED_SENSITIVE_FILE",
      "The requested repository path is denied by the sensitive-file policy."
    );
  }
}

function treeEntryType(mode: string, gitType: string): SnapshotEntryType {
  if (mode === "040000" || gitType === "tree") return "directory";
  if (mode === "120000") return "symlink";
  if (mode === "160000" || gitType === "commit") return "gitlink";
  return "file";
}

function parseTreeEntry(record: string): ParsedTreeEntry | null {
  const separator = record.indexOf("\t");
  if (separator < 0) return null;
  const metadata = record.slice(0, separator).trim().split(/\s+/);
  if (metadata.length < 3) return null;
  const [mode, gitType, oid, rawSize] = metadata;
  const sizeBytes = rawSize && rawSize !== "-" ? Number(rawSize) : undefined;
  return {
    mode,
    gitType,
    oid,
    path: record.slice(separator + 1),
    ...(sizeBytes !== undefined && Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
  };
}

function listTreePage(
  owner: RepositorySnapshotOwner,
  commit: string,
  path: string,
  offset: number,
  limit: number
): { entries: SnapshotDirectoryEntry[]; hasMore: boolean } {
  const args = ["ls-tree", "-z", "-l", commit, "--"];
  if (path) args.push(`:(literal)${path}/`);
  const result = runSnapshotGit(owner.root, args);
  if (!result.ok) commandFailure();
  const entries: SnapshotDirectoryEntry[] = [];
  let remainingOffset = offset;
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const entry = parseTreeEntry(record);
    if (!entry) continue;
    const visible = publicDirectoryEntry(owner, entry);
    if (!visible) continue;
    if (remainingOffset > 0) {
      remainingOffset--;
      continue;
    }
    if (entries.length >= limit) return { entries, hasMore: true };
    entries.push(visible);
  }
  return { entries, hasMore: false };
}

function findTreeEntry(owner: RepositorySnapshotOwner, commit: string, path: string): ParsedTreeEntry | null {
  if (!path) return { mode: "040000", gitType: "tree", oid: commit, path: "" };
  const result = runSnapshotGit(owner.root, ["ls-tree", "-z", "-l", commit, "--", `:(literal)${path}`]);
  if (!result.ok) commandFailure();
  const entries = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(parseTreeEntry)
    .filter((entry): entry is ParsedTreeEntry => entry !== null);
  return entries[0] ?? null;
}

function publicDirectoryEntry(owner: RepositorySnapshotOwner, entry: ParsedTreeEntry): SnapshotDirectoryEntry | null {
  if (owner.ignoreRules.isHidden(entry.path) || owner.ignoreRules.isHidden(`${entry.path}/`)) return null;
  return {
    path: entry.path,
    type: treeEntryType(entry.mode, entry.gitType),
    oid: entry.oid,
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
  };
}

function readBlob(owner: RepositorySnapshotOwner, oid: string, expectedSize?: number): Buffer {
  const sizeResult = expectedSize === undefined
    ? runSnapshotGit(owner.root, ["cat-file", "-s", oid], 64 * 1024)
    : null;
  const size = expectedSize ?? Number(snapshotText(sizeResult!).trim());
  if (!Number.isFinite(size) || size < 0) commandFailure();
  if (size > MAX_BLOB_BYTES) {
    throw new SnapshotError("FILE_TOO_LARGE", "The requested repository blob exceeds the 1 MiB limit.");
  }
  const result = runSnapshotGit(owner.root, ["cat-file", "blob", oid], MAX_BLOB_BYTES + 64 * 1024);
  if (!result.ok || result.stdout.length > MAX_BLOB_BYTES) {
    if (result.overflow || result.stdout.length > MAX_BLOB_BYTES) {
      throw new SnapshotError("FILE_TOO_LARGE", "The requested repository blob exceeds the 1 MiB limit.");
    }
    commandFailure();
  }
  return result.stdout;
}

function decodeUtf8(data: Buffer): string {
  if (data.includes(0)) throw new SnapshotError("BINARY_FILE", "Binary repository content is not returned.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new SnapshotError("BINARY_FILE", "Binary repository content is not returned.");
  }
}

function decodeTextLines(data: Buffer): string[] {
  const decoded = decodeUtf8(data);
  const text = decoded.replace(/\r\n/g, "\n");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function browseFile(
  owner: RepositorySnapshotOwner,
  publicRef: ResolvedPublicRef,
  entry: ParsedTreeEntry,
  path: string,
  options: BrowseSnapshotOptions
): BrowseFileResult {
  const data = readBlob(owner, entry.oid, entry.sizeBytes);
  const lines = decodeTextLines(data);
  const requestedStart = boundedPositiveInteger(options.startLine, 1, Number.MAX_SAFE_INTEGER);
  const startLine = lines.length === 0 ? 1 : Math.min(requestedStart, lines.length);
  const endLimit = options.endLine === undefined
    ? startLine + DEFAULT_TEXT_LINES - 1
    : Math.min(
        Math.max(startLine, Math.floor(options.endLine)),
        startLine + MAX_TEXT_LINES - 1
      );
  const hardEnd = Math.min(endLimit, startLine + MAX_TEXT_LINES - 1);
  const selected: string[] = [];
  let endLine = startLine - 1;
  let returnedBytes = 0;

  if (requestedStart > lines.length && lines.length > 0) endLine = lines.length;
  for (let lineNumber = startLine; lineNumber <= hardEnd && lineNumber <= lines.length; lineNumber++) {
    const line = lines[lineNumber - 1];
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_RETURNED_TEXT_BYTES) {
      throw new SnapshotError("FILE_TOO_LARGE", "An individual repository line exceeds the 256 KiB response limit.");
    }
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (selected.length > 0 && returnedBytes + separatorBytes + lineBytes > MAX_RETURNED_TEXT_BYTES) break;
    selected.push(line);
    returnedBytes += separatorBytes + lineBytes;
    endLine = lineNumber;
  }

  const remainingLines = Math.max(0, lines.length - endLine);
  return {
    ref: publicRef.ref,
    commit: publicRef.commit,
    path,
    kind: "file",
    sizeBytes: data.length,
    totalLines: lines.length,
    startLine,
    endLine,
    truncated: remainingLines > 0,
    remainingLines,
    nextStartLine: remainingLines > 0 ? endLine + 1 : null,
    content: selected.join("\n"),
  };
}

export function browseSnapshot(
  owner: RepositorySnapshotOwner,
  options: BrowseSnapshotOptions
): BrowseSnapshotResult {
  const path = normalizeRepositoryPath(options.path);
  const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER);
  const startLine = boundedPositiveInteger(options.startLine, 1, Number.MAX_SAFE_INTEGER);
  if (offset > 0 || startLine > 1) {
    if (!options.expectedCommit) {
      throw new SnapshotError(
        "CONTINUATION_PRECONDITION_REQUIRED",
        "Continuation requests must include the resolved commit precondition."
      );
    }
  }
  const publicRef = resolveBranchRef(owner, options.ref);
  assertExpectedCommit(options.expectedCommit, publicRef.commit);
  assertReadablePath(owner, path);
  if (path && owner.ignoreRules.isNoise(path)) {
    throw new SnapshotError("PATH_NOT_FOUND", "The requested repository path is unavailable.");
  }

  const entry = findTreeEntry(owner, publicRef.commit, path);
  if (!entry) throw new SnapshotError("PATH_NOT_FOUND", "The requested repository path was not found.");
  const type = treeEntryType(entry.mode, entry.gitType);
  if (type === "file") return browseFile(owner, publicRef, entry, path, options);
  if (type === "symlink") {
    const target = decodeUtf8(readBlob(owner, entry.oid, entry.sizeBytes));
    return { ref: publicRef.ref, commit: publicRef.commit, path, kind: "symlink", target };
  }
  if (type === "gitlink") {
    return { ref: publicRef.ref, commit: publicRef.commit, path, kind: "gitlink", oid: entry.oid };
  }

  const limit = boundedPositiveInteger(options.limit, DEFAULT_DIRECTORY_LIMIT, MAX_DIRECTORY_LIMIT);
  const page = listTreePage(owner, publicRef.commit, path, offset, limit);
  return {
    ref: publicRef.ref,
    commit: publicRef.commit,
    path: path || ".",
    kind: "directory",
    entries: page.entries,
    offset,
    limit,
    hasMore: page.hasMore,
  };
}

function globRegExp(glob: string): RegExp {
  if (!glob || glob.includes("\0")) throw new SnapshotError("INVALID_ARGUMENT", "Invalid search glob.");
  const value = glob.replace(/\\/g, "/");
  if (value.startsWith("/") || value.includes("..")) throw new SnapshotError("INVALID_ARGUMENT", "Invalid search glob.");
  const pattern = value.includes("/") ? value : `**/${value}`;
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index++;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function parseSearchRecord(data: Buffer): ParsedSearchRecord | null {
  const pathEnd = data.indexOf(0);
  if (pathEnd < 0) return null;
  const lineEnd = data.indexOf(0, pathEnd + 1);
  if (lineEnd < 0) return null;
  const recordEnd = data.indexOf(10, lineEnd + 1);
  if (recordEnd < 0) return null;
  const path = data.subarray(0, pathEnd).toString("utf8");
  const line = Number(data.subarray(pathEnd + 1, lineEnd).toString("utf8"));
  let text = data.subarray(lineEnd + 1, recordEnd).toString("utf8");
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (!path || !Number.isInteger(line)) return null;
  return { path, line, text };
}

function appendSearchData(
  pending: Buffer,
  chunk: Buffer,
  matches: SnapshotSearchMatch[],
  owner: RepositorySnapshotOwner,
  commit: string,
  glob: RegExp | null,
  limit: number
): { pending: Buffer; matchLimit: boolean } {
  let data = Buffer.concat([pending, chunk]);
  for (;;) {
    const parsed = parseSearchRecord(data);
    if (!parsed) return { pending: data, matchLimit: false };
    const pathEnd = data.indexOf(0);
    const lineEnd = data.indexOf(0, pathEnd + 1);
    const recordEnd = data.indexOf(10, lineEnd + 1);
    data = data.subarray(recordEnd + 1);
    const matchPath = parsed.path.startsWith(`${commit}:`)
      ? parsed.path.slice(commit.length + 1)
      : parsed.path;
    if (owner.ignoreRules.isHidden(matchPath) || (glob && !glob.test(matchPath))) continue;
    matches.push({
      path: matchPath,
      line: parsed.line,
      text: parsed.text.slice(0, MAX_SEARCH_MATCH_TEXT),
    });
    if (matches.length >= limit) return { pending: data, matchLimit: true };
  }
}

export async function searchSnapshot(
  owner: RepositorySnapshotOwner,
  options: SearchSnapshotOptions
): Promise<SearchSnapshotResult> {
  if (typeof options.query !== "string" || options.query.length === 0 || options.query.includes("\0")) {
    throw new SnapshotError("INVALID_ARGUMENT", "Search query must be a non-empty string.");
  }
  const path = normalizeRepositoryPath(options.path);
  assertReadablePath(owner, path);
  const limit = boundedPositiveInteger(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const glob = options.glob ? globRegExp(options.glob) : null;
  const publicRef = resolveBranchRef(owner, options.ref);
  const args = [
    "grep",
    "--full-name",
    "--line-number",
    "--null",
    "--no-color",
    "-I",
    options.regex ? "-E" : "-F",
    "-e",
    options.query,
    publicRef.commit,
    "--",
  ];
  if (path) args.push(`:(literal)${path}`);

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-replace-objects", ...args], {
      cwd: owner.root,
      env: sanitizedGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const matches: SnapshotSearchMatch[] = [];
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let rawBytes = 0;
    let truncationReason: SearchTruncationReason = null;
    let stderr = Buffer.alloc(0);

    const stop = (reason: SearchTruncationReason): void => {
      if (!truncationReason) truncationReason = reason;
      child.kill("SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncationReason) return;
      const available = MAX_SEARCH_OUTPUT_BYTES - rawBytes;
      if (chunk.length > available) {
        if (available > 0) {
          const consumed = appendSearchData(pending, chunk.subarray(0, available), matches, owner, publicRef.commit, glob, limit);
          pending = consumed.pending;
          if (consumed.matchLimit) {
            stop("match_limit");
            return;
          }
        }
        rawBytes = MAX_SEARCH_OUTPUT_BYTES;
        stop("output_limit");
        return;
      }
      rawBytes += chunk.length;
      const consumed = appendSearchData(pending, chunk, matches, owner, publicRef.commit, glob, limit);
      pending = consumed.pending;
      if (consumed.matchLimit) stop("match_limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr = Buffer.concat([stderr, chunk]).subarray(0, 4096);
    });
    child.on("error", () => reject(new SnapshotError("SEARCH_FAILED", "Repository snapshot search failed.")));
    child.on("close", (code) => {
      if (truncationReason) {
        resolve({
          ref: publicRef.ref,
          commit: publicRef.commit,
          matches,
          matchCount: matches.length,
          truncated: true,
          truncationReason,
        });
        return;
      }
      if (code !== 0 && code !== 1) {
        void stderr;
        reject(new SnapshotError("SEARCH_FAILED", "Repository snapshot search failed."));
        return;
      }
      resolve({
        ref: publicRef.ref,
        commit: publicRef.commit,
        matches,
        matchCount: matches.length,
        truncated: false,
        truncationReason: null,
      });
    });
  });
}

function comparePathMatches(candidate: string, requestedPath: string): boolean {
  return !requestedPath || candidate === requestedPath || candidate.startsWith(`${requestedPath}/`);
}

function chunkPaths(paths: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const value of paths) {
    const cost = Buffer.byteLength(value, "utf8") + 16;
    if (current.length > 0 && (current.length >= 50 || bytes + cost > 32 * 1024)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(value);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function chunkChangeGroups(changes: GitChangeRecord[]): GitChangeRecord[][] {
  const batches: GitChangeRecord[][] = [];
  let current: GitChangeRecord[] = [];
  let bytes = 0;
  for (const change of changes) {
    const cost = change.paths.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8") + 12, 0);
    if (current.length > 0 && (current.length >= 50 || bytes + cost > 32 * 1024)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(change);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function diffPage(data: Buffer, offset: number, maxBytes: number): {
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
} {
  const start = Math.min(offset, data.length);
  let end = Math.min(data.length, start + maxBytes);
  if (end < data.length) {
    const newline = data.subarray(start, end).lastIndexOf(10);
    if (newline > 0) end = start + newline + 1;
  }
  if (end === start && start < data.length) end = Math.min(data.length, start + maxBytes);
  const hasMore = end < data.length;
  return {
    returnedBytes: end - start,
    hasMore,
    nextOffset: hasMore ? end : null,
    diff: data.subarray(start, end).toString("utf8"),
  };
}

export function compareSnapshots(
  owner: RepositorySnapshotOwner,
  options: CompareSnapshotOptions
): CompareSnapshotResult {
  const view = options.view ?? "full";
  const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER);
  const summaryOffset = boundedInteger(options.summaryOffset, 0, Number.MAX_SAFE_INTEGER);
  if (view !== "full" && view !== "summary") {
    throw new SnapshotError("INVALID_ARGUMENT", "view must be either 'full' or 'summary'.");
  }
  if (view === "summary" && offset !== 0) {
    throw new SnapshotError("INVALID_ARGUMENT", "offset is byte-oriented and must be zero when view is 'summary'.");
  }
  if (view === "full" && summaryOffset !== 0) {
    throw new SnapshotError("INVALID_ARGUMENT", "summary_offset is only valid when view is 'summary'.");
  }
  const continuationOffset = view === "full" ? offset : summaryOffset;
  if (continuationOffset > 0 && (!options.expectedBaseCommit || !options.expectedTargetCommit)) {
    throw new SnapshotError(
      "CONTINUATION_PRECONDITION_REQUIRED",
      "Compare continuation requests must include both resolved commit preconditions."
    );
  }
  if (
    (options.expectedBaseCommit === undefined) !== (options.expectedTargetCommit === undefined)
  ) {
    throw new SnapshotError(
      "CONTINUATION_PRECONDITION_REQUIRED",
      "Compare commit preconditions must be supplied together."
    );
  }
  const path = normalizeRepositoryPath(options.path);
  assertReadablePath(owner, path);
  assertSnapshotRepositorySupported(owner);
  const base = resolveBranchRef(owner, options.baseRef);
  const target = resolveBranchRef(owner, options.targetRef);
  assertExpectedCommit(options.expectedBaseCommit, base.commit);
  assertExpectedCommit(options.expectedTargetCommit, target.commit);
  const mergeBaseResult = runSnapshotGit(owner.root, ["merge-base", base.commit, target.commit], 64 * 1024);
  if (!mergeBaseResult.ok || !snapshotText(mergeBaseResult).trim()) {
    throw new SnapshotError("NO_MERGE_BASE", "The compared branches have no merge base.");
  }
  const mergeBase = snapshotText(mergeBaseResult).trim().split(/\s+/)[0];

  const nameArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    "--no-ext-diff",
    "--no-textconv",
    mergeBase,
    target.commit,
    "--",
  ];
  const names = runSnapshotGit(owner.root, nameArgs, MAX_GIT_OUTPUT_BYTES);
  if (!names.ok) {
    if (names.overflow) throw new SnapshotError("DIFF_TOO_LARGE", "The comparison exceeds the 64 MiB limit.");
    commandFailure();
  }
  const safeChanges = parseGitNameStatus(names.stdout)
    .filter((change) => change.paths.every((candidate) => !owner.ignoreRules.isSensitive(candidate)))
    .filter((change) => change.paths.some((candidate) => comparePathMatches(candidate, path)));
  const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_COMPARE_PAGE_BYTES, MAX_COMPARE_PAGE_BYTES);
  if (view === "summary") {
    const summaryChanges = safeChanges.slice(0, gitSummaryLimits.maxFiles);
    const summaryTruncated = safeChanges.length > gitSummaryLimits.maxFiles;
    const summaryStart = Math.min(summaryOffset, summaryChanges.length);
    const pageChanges = summaryChanges.slice(summaryStart, summaryStart + gitSummaryLimits.pageSize);
    const stats = new Map<string, GitNumstatRecord>();
    for (const batch of chunkChangeGroups(pageChanges)) {
      const result = runSnapshotGit(owner.root, [
        "diff",
        "--numstat",
        "-z",
        "--find-renames=1%",
        "--no-ext-diff",
        "--no-textconv",
        mergeBase,
        target.commit,
        "--",
        ...batch.flatMap((change) => change.paths).map((candidate) => `:(literal)${candidate}`),
      ], MAX_GIT_OUTPUT_BYTES);
      if (!result.ok) {
        if (result.overflow) throw new SnapshotError("DIFF_TOO_LARGE", "The comparison exceeds the 64 MiB limit.");
        commandFailure();
      }
      for (const record of parseGitNumstat(result.stdout)) stats.set(gitPathsKey(record.paths), record);
    }
    const summaries = pageChanges.map((change) => gitSummaryForChange(change, stats));
    const page = paginateGitSummaries(summaries, 0, summaryTruncated);
    const hasMore = summaryStart + page.summaryCount < summaryChanges.length;
    return {
      comparison: "merge_base_to_target",
      baseRef: base.ref,
      targetRef: target.ref,
      baseCommit: base.commit,
      targetCommit: target.commit,
      mergeBase,
      view: "summary",
      offset: 0,
      maxBytes,
      totalBytes: 0,
      returnedBytes: 0,
      diff: "",
      nextOffset: null,
      ...page,
      summaryOffset: summaryStart,
      totalSummaryFiles: summaryChanges.length,
      hasMore,
      nextSummaryOffset: hasMore ? summaryStart + page.summaryCount : null,
    };
  }

  const safePaths = [...new Set(safeChanges.flatMap((change) => change.paths))];
  let full = Buffer.alloc(0);
  for (const batch of chunkPaths(safePaths)) {
    const result = runSnapshotGit(owner.root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames=1%",
      mergeBase,
      target.commit,
      "--",
      ...batch.map((candidate) => `:(literal)${candidate}`),
    ], MAX_GIT_OUTPUT_BYTES);
    if (!result.ok) {
      if (result.overflow) throw new SnapshotError("DIFF_TOO_LARGE", "The comparison exceeds the 64 MiB limit.");
      commandFailure();
    }
    full = Buffer.concat([full, result.stdout]);
    if (full.length > MAX_COMPARE_BYTES) {
      throw new SnapshotError("DIFF_TOO_LARGE", "The comparison exceeds the 64 MiB limit.");
    }
  }
  const page = diffPage(full, offset, maxBytes);
  return {
    comparison: "merge_base_to_target",
    baseRef: base.ref,
    targetRef: target.ref,
    baseCommit: base.commit,
    targetCommit: target.commit,
    mergeBase,
    view: "full",
    offset,
    maxBytes,
    totalBytes: full.length,
    ...page,
  };
}

interface RawHistoryPath {
  status: string;
  path: string;
}

interface RawHistoryEntry {
  commit: string;
  timestamp: string;
  author: string;
  subject: string;
  paths: RawHistoryPath[];
}

function boundedUtf8(value: string, maxBytes: number): string {
  const data = Buffer.from(value, "utf8");
  if (data.length <= maxBytes) return value;
  const suffix = "…";
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  while (end > 0) {
    const text = data.subarray(0, end).toString("utf8");
    if (!text.endsWith("�")) return text + suffix;
    end--;
  }
  return suffix;
}

function historyChangeType(status: string): HistoryChangeType {
  switch (status[0]) {
    case "A": return "add";
    case "M": return "modify";
    case "D": return "delete";
    case "R": return "rename";
    case "C": return "copy";
    case "T": return "typechange";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

function isCommitHash(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function stripHistoryPrefix(value: string): string {
  return value.replace(/^\n+/, "");
}

function parseHistoryLog(output: Buffer): RawHistoryEntry[] {
  const tokens = output.toString("utf8").split("\0");
  const entries: RawHistoryEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const commit = stripHistoryPrefix(tokens[index++]);
    if (!commit) continue;
    if (!isCommitHash(commit)) continue;
    const timestamp = tokens[index++] ?? "";
    const author = tokens[index++] ?? "";
    const subject = tokens[index++] ?? "";
    const paths: RawHistoryPath[] = [];
    while (index < tokens.length) {
      const rawStatus = tokens[index++];
      if (!rawStatus) continue;
      const status = stripHistoryPrefix(rawStatus);
      if (isCommitHash(status)) {
        index--;
        break;
      }
      const path = tokens[index++];
      if (path === undefined) break;
      paths.push({ status, path });
    }
    entries.push({ commit, timestamp, author, subject, paths });
  }
  return entries;
}

function historyTimestamp(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

function historyPage(
  entries: HistoryEntry[],
  offset: number,
  limit: number,
  scanTruncated: boolean
): {
  entries: HistoryEntry[];
  hasMore: boolean;
  nextOffset: number | null;
  truncated: boolean;
  truncationReason: "scan_limit" | "output_limit" | null;
} {
  const start = Math.min(offset, entries.length);
  const page: HistoryEntry[] = [];
  let outputTruncated = false;
  for (let index = start; index < entries.length && page.length < limit; index++) {
    const candidate = [...page, entries[index]];
    if (
      page.length > 0 &&
      Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RETURNED_TEXT_BYTES
    ) {
      outputTruncated = true;
      break;
    }
    page.push(entries[index]);
  }
  const hasMore = start + page.length < entries.length;
  return {
    entries: page,
    hasMore,
    nextOffset: hasMore ? start + page.length : null,
    truncated: outputTruncated || scanTruncated,
    truncationReason: outputTruncated ? "output_limit" : scanTruncated ? "scan_limit" : null,
  };
}

export function gitHistory(
  owner: RepositorySnapshotOwner,
  options: HistorySnapshotOptions
): HistorySnapshotResult {
  const path = normalizeRepositoryPath(options.path);
  assertReadablePath(owner, path);
  assertSnapshotRepositorySupported(owner);
  const publicRef = resolveBranchRef(owner, options.ref);
  const offset = boundedInteger(options.offset, 0, MAX_HISTORY_OFFSET);
  const limit = boundedPositiveInteger(options.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  if (offset > 0 && !options.expectedCommit) {
    throw new SnapshotError(
      "CONTINUATION_PRECONDITION_REQUIRED",
      "History continuation requests must include the resolved commit precondition."
    );
  }
  assertExpectedCommit(options.expectedCommit, publicRef.commit);

  const scanLimit = Math.min(MAX_HISTORY_SCAN_COMMITS + 1, offset + limit + 1);
  const args = [
    "log",
    "--no-renames",
    "--date-order",
    "--max-count=" + scanLimit,
    "--format=%H%x00%ct%x00%an%x00%s%x00",
    "--name-status",
    "-z",
    publicRef.commit,
    "--",
    ...(path ? [`:(literal)${path}`] : []),
  ];
  const result = runSnapshotGit(owner.root, args, MAX_HISTORY_OUTPUT_BYTES + 1);
  if (!result.ok) {
    if (result.overflow) throw new SnapshotError("HISTORY_TOO_LARGE", "The history result exceeds the bounded read limit.");
    commandFailure();
  }

  const rawEntries = parseHistoryLog(result.stdout);
  const scanTruncated = rawEntries.length > MAX_HISTORY_SCAN_COMMITS;
  const visibleEntries = rawEntries.slice(0, MAX_HISTORY_SCAN_COMMITS).map((entry) => {
    const paths: HistoryPathChange[] = [];
    let pathsTruncated = false;
    for (const changed of entry.paths) {
      if (owner.ignoreRules.isSensitive(changed.path)) continue;
      if (paths.length >= MAX_HISTORY_PATHS_PER_COMMIT) {
        pathsTruncated = true;
        continue;
      }
      const boundedPath = boundedUtf8(changed.path, 1024);
      if (boundedPath !== changed.path) pathsTruncated = true;
      paths.push({ path: boundedPath, changeType: historyChangeType(changed.status) });
    }
    if (entry.paths.length > paths.length && paths.length >= MAX_HISTORY_PATHS_PER_COMMIT) {
      pathsTruncated = true;
    }
    return {
      commit: entry.commit,
      timestamp: historyTimestamp(entry.timestamp),
      author: boundedUtf8(entry.author, MAX_HISTORY_AUTHOR_BYTES),
      subject: boundedUtf8(entry.subject, MAX_HISTORY_SUBJECT_BYTES),
      paths,
      pathsTruncated,
    } satisfies HistoryEntry;
  });
  const page = historyPage(visibleEntries, offset, limit, scanTruncated);
  return {
    ref: publicRef.ref,
    commit: publicRef.commit,
    offset,
    limit,
    ...page,
  };
}

export const snapshotLimits = {
  maxBlobBytes: MAX_BLOB_BYTES,
  maxReturnedTextBytes: MAX_RETURNED_TEXT_BYTES,
  maxSearchOutputBytes: MAX_SEARCH_OUTPUT_BYTES,
  maxCompareBytes: MAX_COMPARE_BYTES,
} as const;
