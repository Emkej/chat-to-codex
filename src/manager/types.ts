import type { ConnectorInstruction, InstallationHealthResult } from "../admin/installation-health.js";
import type { InstallationStatus } from "../admin/installation-status.js";
import type { ApprovalAttempt, RequestReviewState } from "./request-review-types.js";

export type ManagerAction =
  | "start"
  | "restart"
  | "recover"
  | "stop"
  | "check"
  | "fix"
  | "pair"
  | "confirm"
  | "refresh"
  | "quit";

export interface ManagerActionOption {
  id: ManagerAction;
  label: string;
  shortcut: string;
  description: string;
  confirmation?: "stop" | "confirm";
}

export interface ManagerActivity {
  at: string;
  message: string;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface WorkspaceDetailWorktree {
  worktreeId: string;
  branch: string | null;
  commit: string | null;
}

export interface WorkspaceDetailState {
  workspaceId: string;
  state: "loading" | "ready" | "unavailable";
  worktrees: WorkspaceDetailWorktree[];
}

export interface ManagerSnapshot {
  status: InstallationStatus | null;
  health: InstallationHealthResult | null;
  healthObservedAt: number | null;
  connectorInstruction: ConnectorInstruction;
  pairing: PairingCode | null;
  selectedWorkspaceId: string | null;
  workspaceDetail: WorkspaceDetailState | null;
  pendingCounts: Record<string, number> | null;
  requestReview: RequestReviewState | null;
  approvalAttempt: ApprovalAttempt | null;
  activeAction: ManagerAction | "detail" | "requests" | null;
  confirmation: "stop" | "confirm" | "approve" | null;
  refreshing: boolean;
  notice: string | null;
  error: string | null;
  refreshError: string | null;
  activity: ManagerActivity[];
  closed: boolean;
}
