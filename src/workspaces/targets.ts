import { Workspace } from "../workspace/manager.js";
import {
  assertDerivedWorktreeCurrent,
  resolveDerivedWorktree,
  type WorktreeResolutionOptions,
  type WorktreeRunner,
} from "../workspace/worktrees.js";
import { RegistryError, type WorkspaceRegistration, type WorkspaceRegistry } from "./registry.js";

export interface ResolvedRegisteredWorkspace {
  workspace: Workspace;
  registration: WorkspaceRegistration;
  worktreeId?: string;
  gitDir?: string;
}

/** Resolve an opaque registered target with the same worktree checks used by broker MCP reads. */
export function resolveRegisteredWorkspaceTarget(
  registry: WorkspaceRegistry,
  workspaceId: string,
  worktreeId?: string,
  runner?: WorktreeRunner,
  options: WorktreeResolutionOptions = {}
): ResolvedRegisteredWorkspace {
  const registration = registry.get(workspaceId);
  if (!registration) throw new RegistryError("UNKNOWN_WORKSPACE", "Unknown or revoked workspace.");

  if (worktreeId === undefined) {
    return { workspace: new Workspace(registration.canonicalRoot), registration };
  }

  const worktreeOptions = { ...options, allowCrossNamespace: true };
  const selected = resolveDerivedWorktree(registration.canonicalRoot, worktreeId, runner, worktreeOptions);
  const workspace = new Workspace(selected.root);
  assertDerivedWorktreeCurrent(registration.canonicalRoot, selected, runner, worktreeOptions);
  return { workspace, registration, worktreeId: selected.worktreeId, ...(selected.gitDir ? { gitDir: selected.gitDir } : {}) };
}
