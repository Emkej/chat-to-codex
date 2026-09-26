import { Box, Text } from "ink";
import { isStatusStale, type ManagerLayout } from "../layout.js";
import type { ManagerSnapshot } from "../types.js";
import { ActivityPanel } from "./activity-panel.js";
import { HealthPanel } from "./health-panel.js";
import { WorkspacePanel } from "./workspace-panel.js";

export function Overview({
  snapshot,
  layout,
}: {
  snapshot: ManagerSnapshot;
  layout: ManagerLayout;
}) {
  const stale = snapshot.status ? isStatusStale(snapshot.status) : false;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">C2C Manager</Text>
        <Text dimColor>
          {snapshot.refreshing ? "Refreshing…" : stale ? "Status may be stale" : ""}
        </Text>
      </Box>
      {snapshot.error ? <Text color="red" wrap="wrap">{snapshot.error}</Text> : null}
      {snapshot.refreshError ? <Text color="red" wrap="wrap">Status refresh: {snapshot.refreshError}</Text> : null}
      {snapshot.notice ? <Text color="yellow" wrap="wrap">{snapshot.notice}</Text> : null}
      {layout === "wide" ? (
        <Box flexDirection="row" marginTop={1}>
          <Box width="50%" paddingRight={1}>
            <WorkspacePanel snapshot={snapshot} />
          </Box>
          <Box width="50%" flexDirection="column">
            <HealthPanel snapshot={snapshot} />
            <ActivityPanel snapshot={snapshot} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <WorkspacePanel snapshot={snapshot} />
          <HealthPanel snapshot={snapshot} />
          <ActivityPanel snapshot={snapshot} />
        </Box>
      )}
    </Box>
  );
}
