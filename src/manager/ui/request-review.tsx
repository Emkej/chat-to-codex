import { Box, Text } from "ink";

export function RequestReview({ lines, offset, height, detail }: { lines: string[]; offset: number; height: number; detail: boolean }) {
  return <Box flexDirection="column">
    <Text bold>Pending write requests · {offset + 1}–{Math.min(lines.length, offset + height)} / {lines.length}</Text>
    <Box flexDirection="column" height={height}>
      {lines.slice(offset, offset + height).map((line, index) => <Text key={index}>{line || " "}</Text>)}
    </Box>
    <Text dimColor>{detail ? "↑/↓ Scroll · PgUp/PgDn Page · [v] Approve" : "↑/↓ Select · Enter Review · PgUp/PgDn Page"}</Text>
    <Text dimColor>[r] Refresh · Esc Back · [q] Quit</Text>
  </Box>;
}
