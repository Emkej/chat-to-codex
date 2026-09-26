import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  formatManagerOperationalContext,
  formatManagerVersionMismatch,
  type ManagerLayout,
} from "../layout.js";
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
  const [displayNow, setDisplayNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setDisplayNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const versionMismatch = formatManagerVersionMismatch(snapshot.status);
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">C2C Manager</Text>
      <Text dimColor wrap="wrap">
        {formatManagerOperationalContext(snapshot.status, snapshot.refreshing, displayNow)}
      </Text>
      {versionMismatch ? <Text color="yellow" wrap="wrap">{versionMismatch}</Text> : null}
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
