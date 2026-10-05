import { Box, Text } from "ink";
import { escapeReviewText } from "../request-review-layout.js";

export function RequestReview({ lines, offset, height, detail, unknownId = null, canApprove = true }: { lines: string[]; offset: number; height: number; detail: boolean; unknownId?: string | null; canApprove?: boolean }) {
  return <Box flexDirection="column">
    <Text bold>{unknownId ? "UNKNOWN approval outcome: " + escapeReviewText(unknownId) : `Pending write requests · ${offset + 1}–${Math.min(lines.length, offset + height)} / ${lines.length}`}</Text>
    <Box flexDirection="column" height={height}>
      {lines.slice(offset, offset + height).map((line, index) => <Text key={index}>{line || " "}</Text>)}
    </Box>
    <Text dimColor>{detail ? "↑/↓ Scroll · PgUp/PgDn Page · " + (canApprove ? "[v] Approve" : "Approval unavailable") : "↑/↓ Select · Enter Review · PgUp/PgDn Page"}</Text>
    <Text dimColor>[r] Refresh · Esc Back · [q] Quit</Text>
  </Box>;
}
