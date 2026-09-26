import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { getAvailableManagerActions, managerActionForShortcut } from "../action-policy.js";
import { getManagerLayout } from "../layout.js";
import { ManagerController } from "../controller.js";
import type { ManagerActionOption, ManagerSnapshot } from "../types.js";
import { ActionsMenu } from "./actions-menu.js";
import { Overview } from "./overview.js";

function useManagerSnapshot(controller: ManagerController): ManagerSnapshot {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());
  useEffect(() => controller.subscribe(setSnapshot), [controller]);
  return snapshot;
}

function HelpPanel() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold>Keyboard help</Text>
      <Text>b Start / Restart / Recover · s Stop (confirm first)</Text>
      <Text>d Check · f Fix when repairable · p Pair when endpoint is ready</Text>
      <Text>c Confirm displayed connector URL · r Refresh · a Actions · q Quit</Text>
      <Text>Confirmation: y/Enter accept · n/Esc cancel</Text>
      <Text>↑/↓ select a workspace · ? close help · Ctrl+C quit</Text>
    </Box>
  );
}

function actionAt(actions: ManagerActionOption[], index: number): ManagerActionOption | null {
  if (actions.length === 0) return null;
  return actions[Math.max(0, Math.min(index, actions.length - 1))] ?? null;
}

export function ManagerApp({
  controller,
  onQuit,
}: {
  controller: ManagerController;
  onQuit(): void;
}) {
  const snapshot = useManagerSnapshot(controller);
  const [columns, setColumns] = useState(process.stdout.columns ?? 80);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const actions = getAvailableManagerActions(snapshot);

  useEffect(() => {
    const updateColumns = () => setColumns(process.stdout.columns ?? 80);
    process.stdout.on("resize", updateColumns);
    updateColumns();
    return () => {
      process.stdout.removeListener("resize", updateColumns);
    };
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onQuit();
      return;
    }
    if (input === "q") {
      onQuit();
      return;
    }
    if (snapshot.confirmation) {
      if (input.toLowerCase() === "y" || key.return) void controller.confirmPendingAction();
      else if (input.toLowerCase() === "n" || key.escape) controller.cancelConfirmation();
      return;
    }
    if (input === "?") {
      setHelpOpen((current) => !current);
      setMenuOpen(false);
      return;
    }
    if (input === "a") {
      setMenuOpen((current) => !current);
      setHelpOpen(false);
      setMenuIndex(0);
      return;
    }
    if (menuOpen) {
      if (key.escape) {
        setMenuOpen(false);
        return;
      }
      if (key.upArrow) {
        setMenuIndex((current) => (current - 1 + actions.length) % actions.length);
        return;
      }
      if (key.downArrow) {
        setMenuIndex((current) => (current + 1) % actions.length);
        return;
      }
      if (key.return) {
        const selected = actionAt(actions, menuIndex);
        if (selected) {
          setMenuOpen(false);
          if (selected.id === "quit") onQuit();
          else void controller.perform(selected.id);
        }
      }
      return;
    }
    if (helpOpen && key.escape) {
      setHelpOpen(false);
      return;
    }
    if (key.upArrow) {
      controller.moveWorkspaceSelection(-1);
      return;
    }
    if (key.downArrow) {
      controller.moveWorkspaceSelection(1);
      return;
    }
    const action = managerActionForShortcut(snapshot, input.toLowerCase());
    if (!action) return;
    if (action.id === "quit") onQuit();
    else void controller.perform(action.id);
  });

  const layout = getManagerLayout(columns);
  const hints = actions
    .filter((action) => action.id !== "quit")
    .map((action) => "[" + action.shortcut + "] " + action.label)
    .join(" · ");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Overview snapshot={snapshot} layout={layout} />
      {menuOpen ? <ActionsMenu actions={actions} selectedIndex={menuIndex} /> : null}
      {helpOpen ? <HelpPanel /> : null}
      {snapshot.confirmation ? (
        <Text color="yellow" bold>{snapshot.notice}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          {hints} · [a] Actions · [?] Help · [q] Quit
        </Text>
      </Box>
    </Box>
  );
}
