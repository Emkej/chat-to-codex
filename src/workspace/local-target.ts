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
