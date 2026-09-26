import type { ManagerActionOption, ManagerSnapshot } from "./types.js";

const COMMON_ACTIONS: readonly ManagerActionOption[] = [
  { id: "check", label: "Check health", shortcut: "d", description: "Run a non-repairing health check" },
  { id: "refresh", label: "Refresh overview", shortcut: "r", description: "Read current installation status" },
  { id: "quit", label: "Quit", shortcut: "q", description: "Close the Manager" },
];

function brokerAction(snapshot: ManagerSnapshot): ManagerActionOption | null {
  const state = snapshot.status?.broker.state;
  if (state === "stopped") {
    return { id: "start", label: "Start broker", shortcut: "b", description: "Start the stopped broker" };
  }
  if (state === "running") {
    return { id: "restart", label: "Restart broker", shortcut: "b", description: "Restart the running broker" };
  }
  if (state === "unknown") {
    return { id: "recover", label: "Recover broker", shortcut: "b", description: "Recover an unknown broker state" };
  }
  return null;
}

function pairIsAvailable(snapshot: ManagerSnapshot): boolean {
  const health = snapshot.health;
  const status = snapshot.status;
  if (
    !health ||
    !status ||
    health.endpoint.state !== "healthy" ||
    status.broker.state !== "running" ||
    status.tunnel.state !== "running"
  ) {
    return false;
  }
  if (snapshot.connectorInstruction.kind !== "none") return true;
  return status.authorization.state === "unauthorized" && health.authorization.state === "unauthorized";
}

function confirmIsAvailable(snapshot: ManagerSnapshot): boolean {
  return Boolean(
    snapshot.health &&
      snapshot.health.endpoint.state === "healthy" &&
      snapshot.connectorInstruction.kind !== "none" &&
      snapshot.health.endpoint.mcpUrl === snapshot.connectorInstruction.mcpUrl
  );
}

export function getAvailableManagerActions(snapshot: ManagerSnapshot): ManagerActionOption[] {
  if (snapshot.closed) return [];
  if (snapshot.activeAction || snapshot.confirmation) return [COMMON_ACTIONS[2]];

  const actions: ManagerActionOption[] = [];
  const broker = brokerAction(snapshot);
  if (broker) actions.push(broker);
  if (snapshot.status?.broker.state === "running") {
    actions.push({
      id: "stop",
      label: "Stop broker",
      shortcut: "s",
      description: "Stop the running broker",
      confirmation: "stop",
    });
  }
  actions.push(COMMON_ACTIONS[0]);
  if (snapshot.health?.issues.some((issue) => issue.repairable)) {
    actions.push({ id: "fix", label: "Fix health issues", shortcut: "f", description: "Repair structured repairable issues" });
  }
  if (pairIsAvailable(snapshot)) {
    actions.push({ id: "pair", label: "Pair / renew code", shortcut: "p", description: "Create a fresh pairing code" });
  }
  if (confirmIsAvailable(snapshot)) {
    actions.push({
      id: "confirm",
      label: "Confirm connector updated",
      shortcut: "c",
      description: "Acknowledge the currently displayed MCP URL",
      confirmation: "confirm",
    });
  }
  if (!snapshot.refreshing) actions.push(COMMON_ACTIONS[1]);
  actions.push(COMMON_ACTIONS[2]);
  return actions;
}

export function managerActionForShortcut(snapshot: ManagerSnapshot, key: string): ManagerActionOption | null {
  return getAvailableManagerActions(snapshot).find((action) => action.shortcut === key) ?? null;
}

export function findManagerAction(snapshot: ManagerSnapshot, id: string): ManagerActionOption | null {
  return getAvailableManagerActions(snapshot).find((action) => action.id === id) ?? null;
}
