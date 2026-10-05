import { Box, Text } from "ink";

export function WorkspaceDetail({ lines, offset, height }: { lines: string[]; offset: number; height: number }) {
  return (
    <Box flexDirection="column">
      <Text bold>Workspace detail · {offset + 1}–{Math.min(lines.length, offset + height)} / {lines.length}</Text>
      <Box flexDirection="column" height={height}>
        {lines.slice(offset, offset + height).map((line, index) => <Text key={index}>{line || " "}</Text>)}
      </Box>
      <Text dimColor>↑/↓ Scroll · PgUp/PgDn Page · Esc Back</Text>
      <Text dimColor>[r] Refresh · [a] Actions · [?] Help · [q] Quit</Text>
    </Box>
  );
}
