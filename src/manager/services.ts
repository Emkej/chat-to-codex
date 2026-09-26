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
import { getInstallationStatus, type InstallationStatus } from "../admin/installation-status.js";
import { createInstallationPairing } from "../broker/daemon.js";

export interface ManagerServices {
  readStatus(options: { signal: AbortSignal }): Promise<InstallationStatus>;
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
  readStatus: getInstallationStatus,
  checkHealth: checkInstallationHealth,
  startBroker: startInstallationBroker,
  restartBroker: restartInstallationBroker,
  recoverBroker: recoverInstallationBroker,
  stopBroker: stopInstallationBroker,
  createPairing: createInstallationPairing,
  confirmEndpoint: confirmConnectorEndpoint,
  readInstruction: readCurrentConnectorInstruction,
};
