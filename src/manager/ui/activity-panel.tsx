import { Box, Text } from "ink";
import type { ManagerSnapshot } from "../types.js";

export function ActivityPanel({ snapshot }: { snapshot: ManagerSnapshot }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>Activity</Text>
      {snapshot.activity.length === 0 ? (
        <Text dimColor>No recent Manager activity.</Text>
      ) : (
        snapshot.activity.map((item, index) => (
          <Text key={item.at + "-" + index} wrap="wrap">
            {new Date(item.at).toLocaleTimeString()} {item.message}
          </Text>
        ))
      )}
    </Box>
  );
}
