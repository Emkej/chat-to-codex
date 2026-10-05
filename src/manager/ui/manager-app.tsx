import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { getAvailableManagerActions } from "../action-policy.js";
import { getManagerLayout } from "../layout.js";
import { ManagerController } from "../controller.js";
import type { ManagerSnapshot } from "../types.js";
import { ActionsMenu } from "./actions-menu.js";
import { Overview } from "./overview.js";
import { WorkspaceDetail } from "./workspace-detail.js";
import { detailViewport, workspaceDetailLines } from "../workspace-detail-layout.js";
import { handleManagerInput } from "./manager-input.js";

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
      <Text>↑/↓ select · Enter detail · Esc back · PgUp/PgDn scroll detail</Text>
      <Text>? close help · Ctrl+C quit</Text>
    </Box>
  );
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
  const [rows, setRows] = useState(process.stdout.rows ?? 24);
  const [detailOffset, setDetailOffset] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const actions = getAvailableManagerActions(snapshot);
  const detailLines = workspaceDetailLines(snapshot, Math.max(1, columns - 2));
  const viewport = detailViewport(detailLines.length, rows, detailOffset);

  useEffect(() => {
    if (!snapshot.workspaceDetail) setDetailOffset(0);
  }, [snapshot.workspaceDetail?.workspaceId]);

  useEffect(() => {
    setDetailOffset(viewport.offset);
  }, [viewport.offset]);

  useEffect(() => {
    const updateColumns = () => {
      setColumns(process.stdout.columns ?? 80);
      setRows(process.stdout.rows ?? 24);
    };
    process.stdout.on("resize", updateColumns);
    updateColumns();
    return () => {
      process.stdout.removeListener("resize", updateColumns);
    };
  }, []);

  useInput((input, key) => {
    handleManagerInput(input, key, snapshot, controller, {
      menuOpen, menuIndex, helpOpen, setMenuOpen, setMenuIndex, setHelpOpen, onQuit,
      pageHeight: viewport.height,
      resetScroll: () => setDetailOffset(0),
      scroll: (delta) => setDetailOffset(detailViewport(detailLines.length, rows, viewport.offset + delta).offset),
    });
  });

  const layout = getManagerLayout(columns);
  const hints = actions
    .filter((action) => action.id !== "quit")
    .map((action) => "[" + action.shortcut + "] " + action.label)
    .join(" · ");

  return (
    <Box flexDirection="column" paddingX={1}>
      {snapshot.workspaceDetail ? (
        !menuOpen && !helpOpen && !snapshot.confirmation ?
          <WorkspaceDetail lines={detailLines} offset={viewport.offset} height={viewport.height} /> :
          <Text bold>Workspace detail</Text>
      ) : <Overview snapshot={snapshot} layout={layout} />}
      {menuOpen ? <ActionsMenu actions={actions} selectedIndex={menuIndex} /> : null}
      {helpOpen ? <HelpPanel /> : null}
      {snapshot.confirmation ? (
        <Text color="yellow" bold>{snapshot.notice}</Text>
      ) : null}
      {!snapshot.workspaceDetail || menuOpen || helpOpen || snapshot.confirmation ? <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          {hints} · [Enter] Detail · [a] Actions · [?] Help · [q] Quit
        </Text>
      </Box> : null}
    </Box>
  );
}
