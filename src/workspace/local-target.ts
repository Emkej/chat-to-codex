import path from "node:path";
import {
  resolveLocalWorktree,
  WorktreeError,
  type LocalWorktreeTarget,
  type WorktreeRunner,
} from "./worktrees.js";
import { canonicalizeRoot, type WorkspaceRegistration } from "../workspaces/registry.js";

export type LocalTargetRegistration = Pick<WorkspaceRegistration, "id" | "displayName" | "canonicalRoot">;

export interface LocalTargetResolution {
  kind: "exact" | "derived" | "unregistered";
  root: string;
  mainRoot: string | null;
  registration: LocalTargetRegistration | null;
  worktreeId: string | null;
}

function registrationForRoot(
  registrations: readonly LocalTargetRegistration[],
  root: string
): LocalTargetRegistration | null {
  return registrations.find((registration) => registration.canonicalRoot === root) ?? null;
}

function isDiscoveryUnavailable(error: unknown): boolean {
  return error instanceof WorktreeError && error.code === "WORKTREE_DISCOVERY_FAILED";
}

/**
 * Resolve a concrete local root against an existing read-only registration
 * snapshot. This helper never writes registry, session, or local state.
 */
export function resolveLocalTarget(
  rootInput: string,
  registrations: readonly LocalTargetRegistration[],
  runner?: WorktreeRunner
): LocalTargetResolution {
  const root = canonicalizeRoot(rootInput);
  const exact = registrationForRoot(registrations, root);
  if (exact) {
    return { kind: "exact", root, mainRoot: root, registration: exact, worktreeId: null };
  }

  let detected: LocalWorktreeTarget | null = null;
  try {
    detected = resolveLocalWorktree(root, runner);
  } catch (error) {
    // An older Git or an unavailable Git repository must not prevent an
    // otherwise valid exact registration from being created for this root.
    if (!isDiscoveryUnavailable(error)) throw error;
  }

  if (!detected || detected.kind !== "linked") {
    return { kind: "unregistered", root, mainRoot: null, registration: null, worktreeId: null };
  }

  const parent = registrationForRoot(registrations, detected.mainRoot);
  if (!parent) {
    return { kind: "unregistered", root, mainRoot: detected.mainRoot, registration: null, worktreeId: null };
  }

  return {
    kind: "derived",
    root,
    mainRoot: detected.mainRoot,
    registration: parent,
    worktreeId: detected.worktreeId,
  };
}

function comparablePath(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolve the most specific authorized target containing a local cwd.
 * Explicit registrations and valid concrete Git worktrees are candidates;
 * the deepest candidate wins, with an explicit registration winning ties.
 */
export function resolveContainingLocalTarget(
  cwdInput: string,
  registrations: readonly LocalTargetRegistration[],
  runner?: WorktreeRunner
): LocalTargetResolution {
  const cwd = canonicalizeRoot(cwdInput);
  const candidates: Array<LocalTargetResolution & { explicit: boolean }> = [];

  for (const registration of registrations) {
    if (containsPath(registration.canonicalRoot, cwd)) {
      candidates.push({
        kind: "exact",
        root: registration.canonicalRoot,
        mainRoot: registration.canonicalRoot,
        registration,
        worktreeId: null,
        explicit: true,
      });
    }
  }

  let current = cwd;
  for (;;) {
    try {
      const target = resolveLocalWorktree(current, runner);
      if (target && containsPath(target.root, cwd)) {
        const registration = registrationForRoot(registrations, target.mainRoot);
        if (registration) {
          candidates.push({
            kind: target.kind === "linked" ? "derived" : "exact",
            root: target.root,
            mainRoot: target.mainRoot,
            registration,
            worktreeId: target.worktreeId,
            explicit: false,
          });
        }
      }
    } catch (error) {
      if (!isDiscoveryUnavailable(error)) throw error;
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  candidates.sort((a, b) => {
    const depthDifference = b.root.split(path.sep).length - a.root.split(path.sep).length;
    if (depthDifference !== 0) return depthDifference;
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
    return a.root.localeCompare(b.root);
  });

  if (candidates[0]) {
    const { explicit: _explicit, ...selected } = candidates[0];
    return selected;
  }
  return { kind: "unregistered", root: cwd, mainRoot: null, registration: null, worktreeId: null };
}
