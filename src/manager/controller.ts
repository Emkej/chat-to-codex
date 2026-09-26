import { findManagerAction, getAvailableManagerActions } from "./action-policy.js";
import { MANAGER_STATUS_TIMEOUT_MS } from "./constants.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import { managerServices, type ManagerServices } from "./services.js";
import type { ManagerAction, ManagerSnapshot } from "./types.js";
import type { InstallationHealthResult } from "../admin/installation-health.js";
import type { InstallationLifecycleResult } from "../admin/installation-lifecycle.js";
import type { InstallationStatus } from "../admin/installation-status.js";

export type ManagerListener = (snapshot: ManagerSnapshot) => void;

function initialSnapshot(): ManagerSnapshot {
  return {
    status: null,
    health: null,
    healthObservedAt: null,
    connectorInstruction: { kind: "none" },
    pairing: null,
    selectedWorkspaceId: null,
    activeAction: null,
    confirmation: null,
    refreshing: false,
    notice: null,
    error: null,
    refreshError: null,
    activity: [],
    closed: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueSummary(health: InstallationHealthResult): string {
  if (health.ok) return "Health check passed.";
  const count = health.issues.length;
  return "Health check found " + count + " issue" + (count === 1 ? "" : "s") + ".";
}

function lifecycleSummary(result: InstallationLifecycleResult): string {
  const operation = result.requestedOperation[0]!.toUpperCase() + result.requestedOperation.slice(1);
  if (result.outcome === "success") return "Broker " + result.requestedOperation + " completed.";
  if (result.error) return operation + ": " + result.error.message;
  return "Broker " + result.requestedOperation + " completed with follow-up issues.";
}

export class ManagerController {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<ManagerListener>();
  private readonly refreshCoordinator: RefreshCoordinator<InstallationStatus>;
  private actionAbort: AbortController | null = null;
  private started = false;

  constructor(
    private readonly services: ManagerServices = managerServices,
    options: { statusTimeoutMs?: number } = {}
  ) {
    this.refreshCoordinator = new RefreshCoordinator({
      read: ({ signal }) => this.services.readStatus({ signal }),
      commit: (status) => this.acceptStatus(status),
      fail: (error) => this.patch({ refreshError: error.message }),
      onReadStart: () => this.patch({ refreshing: true }),
      onReadEnd: () => this.patch({ refreshing: false }),
      timeoutMs: options.statusTimeoutMs ?? MANAGER_STATUS_TIMEOUT_MS,
    });
  }

  getSnapshot(): ManagerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: ManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.snapshot.closed) return;
    this.started = true;
    this.refreshCoordinator.start();
  }

  async refresh(): Promise<void> {
    if (this.snapshot.closed || this.snapshot.activeAction) return;
    this.patch({ notice: "Refreshing installation status.", error: null });
    await this.refreshCoordinator.refresh();
  }

  async perform(action: ManagerAction): Promise<boolean> {
    if (this.snapshot.closed) return false;
    const option = findManagerAction(this.snapshot, action);
    if (!option) {
      this.patch({ notice: this.labelFor(action) + " is not available in the current state." });
      return false;
    }
    if (this.snapshot.activeAction) {
      this.patch({ notice: "A foreground action is already running." });
      return false;
    }
    if (action === "quit") {
      this.close();
      return true;
    }
    if (action === "refresh") {
      await this.refresh();
      return true;
    }
    if (option.confirmation) {
      const notice = option.confirmation === "stop"
        ? "Stop the broker? Press y to confirm or n to cancel."
        : "Confirm the displayed connector URL? Press y to confirm or n to cancel.";
      this.patch({ confirmation: option.confirmation, notice, error: null });
      return true;
    }
    await this.runForegroundAction(action);
    return true;
  }

  async confirmPendingAction(): Promise<boolean> {
    const confirmation = this.snapshot.confirmation;
    if (confirmation === null || this.snapshot.closed) return false;
    this.patch({ confirmation: null });
    if (this.snapshot.activeAction) return false;
    const action = confirmation === "stop" ? "stop" : "confirm";
    if (!findManagerAction(this.snapshot, action)) {
      this.patch({
        notice:
          confirmation === "stop"
            ? "The broker is no longer running; stop was cancelled."
            : "The displayed connector URL is no longer current; confirmation was cancelled.",
      });
      return false;
    }
    await this.runForegroundAction(action);
    return true;
  }

  cancelConfirmation(): void {
    if (this.snapshot.confirmation !== null) {
      this.patch({
        confirmation: null,
        notice: this.snapshot.confirmation === "stop" ? "Stop cancelled." : "Connector confirmation cancelled.",
      });
    }
  }

  selectWorkspace(id: string): void {
    if (!this.snapshot.status?.workspaces.some((workspace) => workspace.id === id)) return;
    this.patch({ selectedWorkspaceId: id });
  }

  moveWorkspaceSelection(delta: number): void {
    const workspaces = this.snapshot.status?.workspaces ?? [];
    if (workspaces.length === 0) return;
    const currentIndex = workspaces.findIndex((workspace) => workspace.id === this.snapshot.selectedWorkspaceId);
    const base = currentIndex < 0 ? 0 : currentIndex;
    const index = (base + delta + workspaces.length) % workspaces.length;
    this.patch({ selectedWorkspaceId: workspaces[index]!.id });
  }

  close(): void {
    if (this.snapshot.closed) return;
    this.refreshCoordinator.close();
    this.actionAbort?.abort(new Error("Manager is closing"));
    this.patch({ closed: true, confirmation: null, activeAction: null, refreshing: false });
  }

  private async runForegroundAction(action: Exclude<ManagerAction, "refresh" | "quit">): Promise<void> {
    if (this.snapshot.activeAction || this.snapshot.closed) return;
    const retiredRead = this.refreshCoordinator.beginForegroundAction();
    const actionAbort = new AbortController();
    this.actionAbort = actionAbort;
    this.patch({ activeAction: action, error: null, notice: this.labelFor(action) + " in progress." });

    try {
      await this.execute(action, actionAbort.signal);
    } catch (error) {
      if (!this.snapshot.closed && !actionAbort.signal.aborted) {
        this.patch({ error: errorMessage(error), notice: null });
        this.addActivity(this.labelFor(action) + " failed.");
      }
    } finally {
      if (this.actionAbort === actionAbort) this.actionAbort = null;
      if (this.snapshot.closed) return;
      try {
        await this.refreshCoordinator.refreshAfterAction(retiredRead);
      } finally {
        if (!this.snapshot.closed) this.patch({ activeAction: null });
      }
    }
  }

  private async execute(action: Exclude<ManagerAction, "refresh" | "quit">, signal: AbortSignal): Promise<void> {
    switch (action) {
      case "start":
      case "restart":
      case "recover":
      case "stop": {
        const result = await this.executeLifecycle(action, signal);
        if (this.snapshot.closed) return;
        this.acceptLifecycle(result);
        return;
      }
      case "check":
      case "fix": {
        const health = await this.services.checkHealth({
          fix: action === "fix",
          allowTunnelChoiceDefault: false,
          signal,
        });
        if (this.snapshot.closed) return;
        this.acceptHealth(health);
        return;
      }
      case "pair": {
        const pairing = await this.services.createPairing({ signal });
        if (this.snapshot.closed) return;
        this.patch({
          pairing,
          notice: "Pairing code renewed; valid until " + new Date(pairing.expiresAt).toLocaleTimeString() + ".",
          error: null,
        });
        this.addActivity("Generated a fresh pairing code.");
        return;
      }
      case "confirm":
        this.confirmConnector();
        return;
      default:
        return assertNever(action);
    }
  }

  private executeLifecycle(
    action: "start" | "restart" | "recover" | "stop",
    signal: AbortSignal
  ): Promise<InstallationLifecycleResult> {
    if (action === "start") return this.services.startBroker({ signal });
    if (action === "restart") return this.services.restartBroker({ signal });
    if (action === "recover") return this.services.recoverBroker({ signal });
    return this.services.stopBroker({ signal });
  }

  private acceptLifecycle(result: InstallationLifecycleResult): void {
    const summary = lifecycleSummary(result);
    this.patch({
      status: result.status,
      health: null,
      healthObservedAt: null,
      connectorInstruction: result.connectorInstruction,
      pairing: result.pairing ?? null,
      selectedWorkspaceId: this.keepWorkspaceSelection(result.status),
      notice: summary,
      error: result.error?.message ?? null,
    });
    this.addActivity(summary);
  }

  private acceptHealth(health: InstallationHealthResult): void {
    const pairingCode =
      health.connectorInstruction.kind === "none" ? undefined : health.connectorInstruction.pairingCode;
    const pairingExpiry =
      health.connectorInstruction.kind === "none" ? undefined : health.connectorInstruction.pairingExpiresAt;
    this.patch({
      status: health.status,
      health,
      healthObservedAt: Date.now(),
      connectorInstruction: health.connectorInstruction,
      pairing:
        pairingCode && pairingExpiry
          ? { code: pairingCode, expiresAt: pairingExpiry }
          : this.snapshot.pairing,
      selectedWorkspaceId: this.keepWorkspaceSelection(health.status),
      notice: issueSummary(health),
      error: null,
    });
    this.addActivity(health.ok ? "Health check passed." : "Health check found " + health.issues.length + " issue(s).");
  }

  private confirmConnector(): void {
    const instruction = this.snapshot.connectorInstruction;
    if (instruction.kind === "none") {
      this.patch({ notice: "There is no connector update to confirm." });
      return;
    }
    const result = this.services.confirmEndpoint({ mcpUrl: instruction.mcpUrl });
    if (result.ok) {
      this.patch({
        connectorInstruction: this.readInstructionSafely(this.snapshot.status?.installation.id ?? null),
        pairing: null,
        notice: "Connector URL confirmed.",
        error: null,
      });
      this.addActivity("Confirmed the displayed connector URL.");
      return;
    }
    const current = this.readInstructionSafely(this.snapshot.status?.installation.id ?? null);
    this.patch({
      connectorInstruction: current,
      notice:
        "The endpoint changed before confirmation. Current MCP URL: " +
        (result.currentMcpUrl ?? "unavailable") +
        ". Run Check health to review it.",
      error: null,
    });
  }

  private acceptStatus(status: InstallationStatus): void {
    const previousId = this.snapshot.status?.installation.id ?? null;
    const nextId = status.installation.id;
    const installationChanged = previousId !== nextId;
    const instruction = this.readInstructionSafely(nextId);
    this.patch({
      status,
      health: installationChanged ? null : this.snapshot.health,
      healthObservedAt: installationChanged ? null : this.snapshot.healthObservedAt,
      connectorInstruction: instruction,
      pairing: installationChanged ? null : this.snapshot.pairing,
      selectedWorkspaceId: this.keepWorkspaceSelection(status),
      notice: this.snapshot.notice === "Refreshing installation status." ? "Overview refreshed." : this.snapshot.notice,
      refreshError: null,
    });
  }

  private readInstructionSafely(workspaceId: string | null) {
    try {
      return this.services.readInstruction(workspaceId);
    } catch {
      return this.snapshot.connectorInstruction;
    }
  }

  private keepWorkspaceSelection(status: InstallationStatus): string | null {
    const existing = this.snapshot.selectedWorkspaceId;
    if (existing && status.workspaces.some((workspace) => workspace.id === existing)) return existing;
    return status.workspaces[0]?.id ?? null;
  }

  private labelFor(action: ManagerAction): string {
    return getAvailableManagerActions(this.snapshot).find((candidate) => candidate.id === action)?.label ?? action;
  }

  private addActivity(message: string): void {
    const entry = { at: new Date().toISOString(), message };
    this.patch({ activity: [entry, ...this.snapshot.activity].slice(0, 5) });
  }

  private patch(patch: Partial<ManagerSnapshot>): void {
    if (this.snapshot.closed && patch.closed !== true) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function assertNever(value: never): never {
  throw new Error("Unsupported Manager action: " + value);
}
