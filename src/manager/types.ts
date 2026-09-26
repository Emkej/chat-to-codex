import type { ConnectorInstruction, InstallationHealthResult } from "../admin/installation-health.js";
import type { InstallationStatus } from "../admin/installation-status.js";

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

export interface ManagerSnapshot {
  status: InstallationStatus | null;
  health: InstallationHealthResult | null;
  healthObservedAt: number | null;
  connectorInstruction: ConnectorInstruction;
  pairing: PairingCode | null;
  selectedWorkspaceId: string | null;
  activeAction: ManagerAction | null;
  confirmation: "stop" | "confirm" | null;
  refreshing: boolean;
  notice: string | null;
  error: string | null;
  refreshError: string | null;
  activity: ManagerActivity[];
  closed: boolean;
}
