import { Box, Text } from "ink";
import type { ManagerSnapshot } from "../types.js";
import { formatSessionCount } from "../layout.js";

export function WorkspacePanel({ snapshot }: { snapshot: ManagerSnapshot }) {
  const workspaces = snapshot.status?.workspaces ?? [];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>Workspaces</Text>
      {workspaces.length === 0 ? (
        <Text dimColor>{snapshot.status ? "No workspaces registered." : "Waiting for installation status..."}</Text>
      ) : (
        workspaces.map((workspace) => (
          <Text key={workspace.id} wrap="wrap">
            {workspace.id === snapshot.selectedWorkspaceId ? "› " : "  "}
            {workspace.name} — {formatSessionCount(workspace.liveSessionCount)} live session(s)
            {" · pending "}{snapshot.pendingCounts === null ? "unavailable" : snapshot.pendingCounts[workspace.id] ?? 0}
          </Text>
        ))
      )}
      {workspaces.length > 1 ? <Text dimColor>Use ↑/↓ to select a workspace.</Text> : null}
    </Box>
  );
}
