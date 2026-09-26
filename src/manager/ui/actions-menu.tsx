import { Box, Text } from "ink";
import type { ManagerActionOption } from "../types.js";

export function ActionsMenu({
  actions,
  selectedIndex,
}: {
  actions: ManagerActionOption[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold>Actions</Text>
      {actions.map((action, index) => (
        <Text key={action.id} wrap="wrap">
          {index === selectedIndex ? "› " : "  "}
          [{action.shortcut}] {action.label} — {action.description}
          {action.confirmation ? " (confirmation required)" : ""}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · Enter run · Esc close</Text>
    </Box>
  );
}
