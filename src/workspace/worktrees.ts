import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit, type GitCommandResult } from "./git.js";

export type WorktreeRunner = (root: string, args: string[]) => GitCommandResult;

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

function gitTopLevel(root: string, runner: WorktreeRunner): string | null {
  const result = runner(root, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return null;
  return canonicalGitPath(root, result.stdout);
}

function gitCommonDirectory(root: string, runner: WorktreeRunner): string | null {
  const result = runner(root, ["rev-parse", "--git-common-dir"]);
  if (!result.ok) return null;
  return canonicalGitPath(root, result.stdout);
}

function isInsideWorkTree(root: string, runner: WorktreeRunner): boolean {
  const result = runner(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

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

function validateCandidate(
  record: ParsedWorktree,
  repositoryIdentity: string,
  runner: WorktreeRunner
): DerivedWorktree | null {
  if (record.bare || record.prunable || !record.commit) return null;
  const root = canonicalDirectory(record.root);
  if (!root) return null;
  if (gitTopLevel(root, runner) !== root) return null;
  if (gitCommonDirectory(root, runner) !== repositoryIdentity) return null;
  return {
    worktreeId: worktreeIdFor(repositoryIdentity, root),
    branch: record.branch,
    commit: record.commit,
    root,
  };
}

function candidateRootForId(
  record: ParsedWorktree,
  repositoryIdentity: string,
  worktreeId: string
): string | null {
  if (record.bare || record.prunable || !record.commit) return null;
  const root = canonicalDirectory(record.root);
  return root && worktreeIdFor(repositoryIdentity, root) === worktreeId ? root : null;
}

/** Discover current eligible linked worktrees owned by a registered main root. */
export function discoverDerivedWorktrees(
  mainRoot: string,
  runner: WorktreeRunner = runGit
): DerivedWorktree[] {
  const inventory = readInventory(mainRoot, runner);
  if (!inventory.mainRoot || !inventory.repositoryIdentity) return [];
  const canonicalRoot = canonicalDirectory(mainRoot);
  if (!canonicalRoot || canonicalRoot !== inventory.mainRoot) return [];
  return inventory.records
    .slice(1)
    .map((record) => validateCandidate(record, inventory.repositoryIdentity!, runner))
    .filter((candidate): candidate is DerivedWorktree => candidate !== null);
}

/** Resolve one opaque linked-worktree id without accepting a client-supplied path. */
export function resolveDerivedWorktree(
  mainRoot: string,
  worktreeId: string,
  runner: WorktreeRunner = runGit
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
    candidateRootForId(candidate, inventory.repositoryIdentity!, worktreeId)
  );
  if (!record) throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");

  const root = candidateRootForId(record, inventory.repositoryIdentity, worktreeId);
  const candidate = root
    ? validateCandidate({ ...record, root }, inventory.repositoryIdentity, runner)
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
  runner: WorktreeRunner = runGit
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
  const candidateIdentity = gitCommonDirectory(canonicalCandidateRoot, runner);
  if (
    !repositoryIdentity ||
    gitTopLevel(canonicalCandidateRoot, runner) !== canonicalCandidateRoot ||
    candidateIdentity !== repositoryIdentity ||
    worktreeIdFor(repositoryIdentity, canonicalCandidateRoot) !== candidate.worktreeId
  ) {
    throw new WorktreeError("UNKNOWN_WORKTREE", "Unknown or unavailable worktree.");
  }
}

/** Resolve a concrete local root to the registered main/derived worktree model. */
export function resolveLocalWorktree(
  root: string,
  runner: WorktreeRunner = runGit
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
      runner
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
      worktreeIdFor(inventory.repositoryIdentity, canonicalRoot)
    );
    if (candidateRoot !== canonicalRoot) continue;
    const candidate = validateCandidate(
      { ...record, root: candidateRoot },
      inventory.repositoryIdentity,
      runner
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
