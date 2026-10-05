import { getStateDir } from "../config/paths.js";
import { throwIfAborted } from "../process/abort.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { discoverDerivedWorktreesAsync } from "../workspace/worktree-read.js";
import { MANAGER_STATUS_TIMEOUT_MS } from "./constants.js";
import type { WorkspaceDetailWorktree } from "./types.js";

export async function readWorkspaceDetail(
  workspaceId: string,
  { signal }: { signal: AbortSignal }
): Promise<WorkspaceDetailWorktree[]> {
  throwIfAborted(signal);
  const workspace = WorkspaceRegistry.load(getStateDir()).get(workspaceId);
  if (!workspace) throw new Error("Workspace detail is unavailable.");
  const worktrees = await discoverDerivedWorktreesAsync(workspace.canonicalRoot, {
    signal,
    timeoutMs: MANAGER_STATUS_TIMEOUT_MS,
    resolution: { allowCrossNamespace: true },
  });
  // Paths stay in the canonical domain and never enter a Manager snapshot.
  return worktrees.map(({ worktreeId, branch, commit }) => ({ worktreeId, branch, commit }));
}
