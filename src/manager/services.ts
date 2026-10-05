import {
  checkInstallationHealth,
  confirmConnectorEndpoint,
  readCurrentConnectorInstruction,
  type ConnectorInstruction,
  type InstallationHealthResult,
} from "../admin/installation-health.js";
import {
  recoverInstallationBroker,
  restartInstallationBroker,
  startInstallationBroker,
  stopInstallationBroker,
  type InstallationLifecycleResult,
} from "../admin/installation-lifecycle.js";
import { readManagerStatus, managerWriteRequestServices, type ManagerWriteRequestServices, type ManagerStatus } from "./write-request-service.js";
import { createInstallationPairing } from "../broker/daemon.js";
import { readWorkspaceDetail } from "./workspace-detail-service.js";
import type { WorkspaceDetailWorktree } from "./types.js";

export interface ManagerServices {
  writeRequests: ManagerWriteRequestServices;
  readWorkspaceDetail(workspaceId: string, options: { signal: AbortSignal }): Promise<WorkspaceDetailWorktree[]>;
  readStatus(options: { signal: AbortSignal }): Promise<ManagerStatus>;
  checkHealth(options: {
    fix: boolean;
    allowTunnelChoiceDefault: false;
    signal: AbortSignal;
  }): Promise<InstallationHealthResult>;
  startBroker(options: { signal: AbortSignal }): Promise<InstallationLifecycleResult>;
  restartBroker(options: { signal: AbortSignal }): Promise<InstallationLifecycleResult>;
  recoverBroker(options: { signal: AbortSignal }): Promise<InstallationLifecycleResult>;
  stopBroker(options: { signal: AbortSignal }): Promise<InstallationLifecycleResult>;
  createPairing(options: { signal: AbortSignal }): Promise<{ code: string; expiresAt: number }>;
  confirmEndpoint(options: { mcpUrl: string }): ReturnType<typeof confirmConnectorEndpoint>;
  readInstruction(workspaceId: string | null): ConnectorInstruction;
}

export const managerServices: ManagerServices = {
  writeRequests: managerWriteRequestServices,
  readWorkspaceDetail,
  readStatus: readManagerStatus,
  checkHealth: checkInstallationHealth,
  startBroker: startInstallationBroker,
  restartBroker: restartInstallationBroker,
  recoverBroker: recoverInstallationBroker,
  stopBroker: stopInstallationBroker,
  createPairing: createInstallationPairing,
  confirmEndpoint: confirmConnectorEndpoint,
  readInstruction: readCurrentConnectorInstruction,
};
