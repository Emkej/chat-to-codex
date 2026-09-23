import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGit, type GitCommandResult } from "./git.js";

export type WorktreeRunner = (root: string, args: string[], gitDir?: string) => GitCommandResult;
export type WslPathResolver = (windowsPath: string) => string | null;

export interface WorktreeResolutionOptions {
  /** Enable the constrained fallback only for broker-derived worktrees. */
  allowCrossNamespace?: boolean;
  /** Injectable for tests; production reads the active WSL distro environment. */
  wslDistro?: string;
  /** Injectable wrapper around the host's `wslpath -u` conversion. */
  resolveWslPath?: WslPathResolver;
}

export interface ParsedWorktree {
  root: string;
  commit: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface DerivedWorktree {
  worktreeId: string;
  branch: string | null;
  commit: string | null;
  /** Internal-only canonical path. Never return this through MCP. */
  root: string;
  /** Internal-only linked-worktree administrative directory. */
  gitDir?: string;
}

export interface WorktreeInventory {
  available: boolean;
  records: ParsedWorktree[];
  mainRoot: string | null;
  repositoryIdentity: string | null;
}

export interface LocalWorktreeTarget {
  kind: "main" | "linked";
  root: string;
  mainRoot: string;
  repositoryIdentity: string;
  worktreeId: string | null;
  branch: string | null;
  commit: string | null;
}

export type WorktreeErrorCode = "WORKTREE_DISCOVERY_FAILED" | "UNKNOWN_WORKTREE";

export class WorktreeError extends Error {
  constructor(public code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

function canonicalDirectory(input: string, base?: string): string | null {
  const resolved = path.isAbsolute(input) ? input : path.resolve(base ?? process.cwd(), input);
  try {
    const real = fs.realpathSync.native(resolved);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function canonicalFile(input: string): string | null {
  try {
    const real = fs.realpathSync.native(input);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function isWindowsDrivePath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input.trim());
}

function isUncPath(input: string): boolean {
  return input.trim().replace(/\\/g, "/").startsWith("//");
}

function currentWslDistro(options: WorktreeResolutionOptions): string | null {
  if (process.platform !== "linux") return null;
  const distro = (options.wslDistro ?? process.env.WSL_DISTRO_NAME)?.trim();
  return distro || null;
}

function defaultWslPathResolver(windowsPath: string): string | null {
  try {
    const result = spawnSync("wslpath", ["-u", windowsPath], {
      encoding: "utf8",
      env: { ...process.env },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    const converted = (result.stdout ?? "").trim();
    return converted.startsWith("/") ? converted : null;
  } catch {
    return null;
  }
}

function resolveWindowsDrivePath(input: string, options: WorktreeResolutionOptions): string | null {
  if (!options.allowCrossNamespace || !currentWslDistro(options) || !isWindowsDrivePath(input)) {
    return null;
  }
  const converted = (options.resolveWslPath ?? defaultWslPathResolver)(input.trim());
  return converted && converted.startsWith("/") ? converted : null;
}

function resolveWslUncPath(input: string, options: WorktreeResolutionOptions): string | null {
  const distro = currentWslDistro(options);
  if (!options.allowCrossNamespace || !distro) return null;
  const normalized = input.trim().replace(/\\/g, "/");
  const match = normalized.match(/^\/\/wsl\$\/([^/]+)(\/.*)?$/i);
  if (!match || match[1].toLowerCase() !== distro.toLowerCase()) return null;
  const suffix = match[2] ?? "/";
  return path.posix.normalize(suffix.startsWith("/") ? suffix : `/${suffix}`);
}

function canonicalNamespacePath(
  input: string,
  base: string,
  options: WorktreeResolutionOptions,
  kind: "file" | "directory"
): string | null {
  const value = input.trim();
  if (!value) return null;

  let resolved: string | null;
  const unc = resolveWslUncPath(value, options);
  if (unc) {
    resolved = unc;
  } else if (isUncPath(value)) {
    // Reject foreign-distro WSL paths and arbitrary network UNC paths alike.
    return null;
  } else if (isWindowsDrivePath(value)) {
    resolved = resolveWindowsDrivePath(value, options);
  } else {
    resolved = path.isAbsolute(value) ? value : path.resolve(base, value);
  }
  if (!resolved) return null;
  return kind === "file" ? canonicalFile(resolved) : canonicalDirectory(resolved);
}

function candidateRoot(
  input: string,
  options: WorktreeResolutionOptions
): { root: string; translated: boolean } | null {
  const normal = canonicalDirectory(input);
  if (normal) return { root: normal, translated: false };
  const translated = resolveWindowsDrivePath(input, options) ?? resolveWslUncPath(input, options);
  if (!translated) return null;
  const root = canonicalDirectory(translated);
  return root ? { root, translated: true } : null;
}

type GitdirPointerFormat = "prefixed" | "bare";

function readGitdirPointer(
  pointerFile: string,
  options: WorktreeResolutionOptions,
  targetKind: "file" | "directory",
  format: GitdirPointerFormat
): { raw: string; resolved: string } | null {
  try {
    if (!fs.lstatSync(pointerFile).isFile()) return null;
    const lines = fs.readFileSync(pointerFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1) return null;
    const line = lines[0];
    if (format === "bare" && /^gitdir:\s*/i.test(line)) return null;
    const raw = format === "bare" ? line : line.match(/^gitdir:\s*(.+)$/i)?.[1]?.trim();
    if (!raw) return null;
    const resolved = canonicalNamespacePath(raw, path.dirname(pointerFile), options, targetKind);
    return resolved ? { raw, resolved } : null;
  } catch {
    return null;
  }
}

function isInsideLinkedWorktreeAdminArea(repositoryIdentity: string, gitDir: string): boolean {
  const relative = path.relative(repositoryIdentity, gitDir);
  const parts = relative.split(path.sep);
  return parts.length >= 2 && parts[0] === "worktrees" && parts.every((part) => part !== ".." && part !== "");
}

function canonicalGitPath(root: string, output: string): string | null {
  const value = output.trim();
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(root, value);
  try {
    const real = fs.realpathSync.native(resolved);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function normalizeBranch(ref: string): string | null {
  const value = ref.trim();
  if (!value || value === "(detached)") return null;
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function flushRecord(fields: string[], records: ParsedWorktree[]): void {
  const values = fields.filter(Boolean);
  const worktree = values.find((field) => field.startsWith("worktree "));
  if (!worktree) return;
  const head = values.find((field) => field.startsWith("HEAD "));
  const branch = values.find((field) => field.startsWith("branch "));
  records.push({
    root: worktree.slice("worktree ".length),
    commit: head ? head.slice("HEAD ".length).trim() || null : null,
    branch: branch ? normalizeBranch(branch.slice("branch ".length)) : null,
    bare: values.includes("bare"),
    locked: values.some((field) => field === "locked" || field.startsWith("locked ")),
    prunable: values.some((field) => field === "prunable" || field.startsWith("prunable ")),
  });
}

/** Parse Git's machine-readable worktree format with either NUL or line delimiters. */
export function parseWorktreePorcelainZ(output: string): ParsedWorktree[] {
  const records: ParsedWorktree[] = [];
  let fields: string[] = [];
  const fieldsInOutput = output.includes("\0") ? output.split("\0") : output.split(/\r?\n/);
  for (const field of fieldsInOutput) {
    if (field === "") {
      flushRecord(fields, records);
      fields = [];
    } else {
      fields.push(field);
    }
  }
  flushRecord(fields, records);
  return records;
}

export function worktreeIdFor(repositoryIdentity: string, canonicalRoot: string): string {
  return `wt-${createHash("sha256").update(`${repositoryIdentity}\0${canonicalRoot}`).digest("hex").slice(0, 16)}`;
}

function gitTopLevel(root: string, runner: WorktreeRunner, gitDir?: string): string | null {
  const result = runner(root, ["rev-parse", "--show-toplevel"], gitDir);
  if (!result.ok) return null;
  return canonicalGitPath(root, result.stdout);
}

function gitCommonDirectory(root: string, runner: WorktreeRunner, gitDir?: string): string | null {
  const result = runner(root, ["rev-parse", "--git-common-dir"], gitDir);
  if (!result.ok) return null;
  return canonicalGitPath(root, result.stdout);
}

function isInsideWorkTree(root: string, runner: WorktreeRunner): boolean {
  const result = runner(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

const defaultWorktreeRunner: WorktreeRunner = (root, args, gitDir) => runGit(root, args, gitDir);

function readInventory(root: string, runner: WorktreeRunner): WorktreeInventory {
  const canonicalRoot = canonicalDirectory(root);
  if (!canonicalRoot || !isInsideWorkTree(canonicalRoot, runner)) {
    return { available: true, records: [], mainRoot: null, repositoryIdentity: null };
  }

  let result = runner(canonicalRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (!result.ok) {
    // Git 2.34 and some vendor builds do not support -z for `worktree list`.
    // Keep the NUL-delimited form when available, then fall back to the
    // machine-readable porcelain form supported by those installations.
    result = runner(canonicalRoot, ["worktree", "list", "--porcelain"]);
  }
  if (!result.ok) {
    throw new WorktreeError("WORKTREE_DISCOVERY_FAILED", "Git worktree discovery is unavailable.");
  }

  const records = parseWorktreePorcelainZ(result.stdout);
  const main = records[0];
  const mainRoot = main && !main.bare ? canonicalDirectory(main.root, canonicalRoot) : null;
  const repositoryIdentity =
    mainRoot && gitTopLevel(mainRoot, runner) === mainRoot
      ? gitCommonDirectory(mainRoot, runner)
      : null;
  return { available: true, records, mainRoot, repositoryIdentity };
}

function validateExplicitWorktreeTarget(
  workTree: string,
  gitDir: string,
  repositoryIdentity: string,
  runner: WorktreeRunner,
  options: WorktreeResolutionOptions
): string | null {
  const canonicalGitDir = canonicalDirectory(gitDir);
  if (!canonicalGitDir || !isInsideLinkedWorktreeAdminArea(repositoryIdentity, canonicalGitDir)) return null;
  if (gitTopLevel(workTree, runner, canonicalGitDir) !== workTree) return null;
  if (gitCommonDirectory(workTree, runner, canonicalGitDir) !== repositoryIdentity) return null;

  const expectedPointer = canonicalFile(path.join(workTree, ".git"));
  const forwardPointer = readGitdirPointer(path.join(workTree, ".git"), options, "directory", "prefixed");
  const reversePointer = readGitdirPointer(path.join(canonicalGitDir, "gitdir"), options, "file", "bare");
  if (
    !expectedPointer ||
    !forwardPointer ||
    forwardPointer.resolved !== canonicalGitDir ||
    !reversePointer ||
    reversePointer.resolved !== expectedPointer
  ) {
    return null;
  }
  return canonicalGitDir;
}

function validateCandidate(
  record: ParsedWorktree,
  repositoryIdentity: string,
  runner: WorktreeRunner,
  options: WorktreeResolutionOptions
): DerivedWorktree | null {
  if (record.bare || !record.commit) return null;
  const rootInfo = candidateRoot(record.root, options);
  if (!rootInfo) return null;
  const { root } = rootInfo;

  if (!record.prunable && gitTopLevel(root, runner) === root && gitCommonDirectory(root, runner) === repositoryIdentity) {
    return {
      worktreeId: worktreeIdFor(repositoryIdentity, root),
      branch: record.branch,
      commit: record.commit,
      root,
    };
  }

  if (!options.allowCrossNamespace || !currentWslDistro(options)) return null;
  const pointer = readGitdirPointer(path.join(root, ".git"), options, "directory", "prefixed");
  if (!pointer) return null;
  // The compatibility path is intentionally limited to the documented
  // current-distro WSL UNC pointer. A translated root alone must never make
  // a prunable candidate eligible.
  if (!resolveWslUncPath(pointer.raw, options)) return null;
  const gitDir = validateExplicitWorktreeTarget(root, pointer.resolved, repositoryIdentity, runner, options);
  if (!gitDir) return null;
  return {
    worktreeId: worktreeIdFor(repositoryIdentity, root),
    branch: record.branch,
    commit: record.commit,
    root,
    gitDir,
  };
}

function candidateRootForId(
  record: ParsedWorktree,
  repositoryIdentity: string,
  worktreeId: string,
  options: WorktreeResolutionOptions
): string | null {
  if (record.bare || !record.commit) return null;
  const root = candidateRoot(record.root, options)?.root;
  return root && worktreeIdFor(repositoryIdentity, root) === worktreeId ? root : null;
}

/** Discover current eligible linked worktrees owned by a registered main root. */
export function discoverDerivedWorktrees(
  mainRoot: string,
  runner: WorktreeRunner = defaultWorktreeRunner,
  options: WorktreeResolutionOptions = {}
): DerivedWorktree[] {
  const inventory = readInventory(mainRoot, runner);
  if (!inventory.mainRoot || !inventory.repositoryIdentity) return [];
  const canonicalRoot = canonicalDirectory(mainRoot);
  if (!canonicalRoot || canonicalRoot !== inventory.mainRoot) return [];
  return inventory.records
    .slice(1)
    .map((record) => validateCandidate(record, inventory.repositoryIdentity!, runner, options))
    .filter((candidate): candidate is DerivedWorktree => candidate !== null);
}

/** Resolve one opaque linked-worktree id without accepting a client-supplied path. */
export function resolveDerivedWorktree(
  mainRoot: string,
  worktreeId: string,
  runner: WorktreeRunner = defaultWorktreeRunner,
  options: WorktreeResolutionOptions = {}
): DerivedWorktree {
  const inventory = readInventory(mainRoot, runner);
  if (!inventory.mainRoot || !inventory.repositoryIdentity) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }
  const canonicalRoot = canonicalDirectory(mainRoot);
  if (!canonicalRoot || canonicalRoot !== inventory.mainRoot) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }

  const record = inventory.records.slice(1).find((candidate) =>
    candidateRootForId(candidate, inventory.repositoryIdentity!, worktreeId, options)
  );
  if (!record) throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");

  const root = candidateRootForId(record, inventory.repositoryIdentity, worktreeId, options);
  const candidate = root
    ? validateCandidate({ ...record, root }, inventory.repositoryIdentity, runner, options)
    : null;
  if (!candidate || candidate.worktreeId !== worktreeId) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }
  return candidate;
}

/** Recheck a selected linked root after resolution and immediately before use. */
export function assertDerivedWorktreeCurrent(
  mainRoot: string,
  candidate: DerivedWorktree,
  runner: WorktreeRunner = defaultWorktreeRunner,
  options: WorktreeResolutionOptions = {}
): void {
  const canonicalMainRoot = canonicalDirectory(mainRoot);
  const canonicalCandidateRoot = canonicalDirectory(candidate.root);
  if (
    !canonicalMainRoot ||
    canonicalMainRoot !== mainRoot ||
    !canonicalCandidateRoot ||
    canonicalCandidateRoot !== candidate.root
  ) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }

  const repositoryIdentity =
    gitTopLevel(canonicalMainRoot, runner) === canonicalMainRoot
      ? gitCommonDirectory(canonicalMainRoot, runner)
      : null;
  if (!repositoryIdentity || worktreeIdFor(repositoryIdentity, canonicalCandidateRoot) !== candidate.worktreeId) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }

  if (candidate.gitDir) {
    if (
      validateExplicitWorktreeTarget(
        canonicalCandidateRoot,
        candidate.gitDir,
        repositoryIdentity,
        runner,
        options
      ) !== candidate.gitDir
    ) {
      throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
    }
    return;
  }

  if (
    gitTopLevel(canonicalCandidateRoot, runner) !== canonicalCandidateRoot ||
    gitCommonDirectory(canonicalCandidateRoot, runner) !== repositoryIdentity
  ) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }
}

/** Resolve a concrete local root to the registered main/derived worktree model. */
export function resolveLocalWorktree(
  root: string,
  runner: WorktreeRunner = defaultWorktreeRunner
): LocalWorktreeTarget | null {
  const inventory = readInventory(root, runner);
  if (!inventory.mainRoot || !inventory.repositoryIdentity) return null;
  const canonicalRoot = canonicalDirectory(root);
  if (!canonicalRoot) return null;

  const mainRecord = inventory.records[0];
  if (mainRecord && !mainRecord.bare && canonicalRoot === inventory.mainRoot) {
    const mainCandidate = validateCandidate(
      { ...mainRecord, root: inventory.mainRoot },
      inventory.repositoryIdentity,
      runner,
      {}
    );
    if (mainCandidate) {
      return {
        kind: "main",
        root: canonicalRoot,
        mainRoot: inventory.mainRoot,
        repositoryIdentity: inventory.repositoryIdentity,
        worktreeId: null,
        branch: mainRecord.branch,
        commit: mainRecord.commit,
      };
    }
  }

  for (const record of inventory.records.slice(1)) {
    const candidateRoot = candidateRootForId(
      record,
      inventory.repositoryIdentity,
      worktreeIdFor(inventory.repositoryIdentity, canonicalRoot),
      {}
    );
    if (candidateRoot !== canonicalRoot) continue;
    const candidate = validateCandidate(
      { ...record, root: candidateRoot },
      inventory.repositoryIdentity,
      runner,
      {}
    );
    if (candidate?.root === canonicalRoot) {
      return {
        kind: "linked",
        root: candidate.root,
        mainRoot: inventory.mainRoot,
        repositoryIdentity: inventory.repositoryIdentity,
        worktreeId: candidate.worktreeId,
        branch: candidate.branch,
        commit: candidate.commit,
      };
    }
  }
  return null;
}
