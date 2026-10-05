import { stripVTControlCharacters } from "node:util";
import { formatSessionCount } from "./layout.js";
import type { ManagerSnapshot } from "./types.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap before rendering so scrolling counts visible terminal lines. */
export function wrapDetailValue(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const clean = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ");
  const lines: string[] = [];
  let line = "";
  let cells = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const code = segment.codePointAt(0)!;
    // Conservatively reserve two cells for non-ASCII graphemes. This also
    // covers new/ambiguous wide characters without another Unicode database
    // dependency; narrow Unicode may wrap early but never becomes unreachable.
    const wide = code > 0x7f || /[\ufe0f\u20e3]/u.test(segment);
    const size = /^\p{Mark}+$/u.test(segment) ? 0 : wide ? 2 : 1;
    if (line && cells + size > width) {
      lines.push(line);
      line = "";
      cells = 0;
    }
    line += segment;
    cells += size;
  }
  lines.push(line);
  return lines;
}

export function workspaceDetailLines(snapshot: ManagerSnapshot, columns: number): string[] {
  const detail = snapshot.workspaceDetail;
  const workspace = snapshot.status?.workspaces.find((entry) => entry.id === detail?.workspaceId);
  if (!detail || !workspace) return [];
  const values = [
    `Name: ${workspace.name}`,
    `Workspace id: ${workspace.id}`,
    `Live sessions: ${formatSessionCount(workspace.liveSessionCount)}`,
    "Derived worktrees:",
  ];
  if (detail.state === "loading") values.push("Loading worktrees...");
  if (detail.state === "unavailable") values.push("Workspace detail is unavailable. Press r to retry.");
  if (detail.state === "ready" && detail.worktrees.length === 0) values.push("No derived worktrees.");
  for (const worktree of detail.worktrees) {
    values.push(`Worktree id: ${worktree.worktreeId}`, `Branch: ${worktree.branch ?? "detached"}`, `Commit: ${worktree.commit ?? "unavailable"}`, "");
  }
  return values.flatMap((value) => wrapDetailValue(value, columns));
}

export function detailViewport(lineCount: number, rows: number, requestedOffset: number) {
  const height = Math.max(1, rows - 4);
  const offset = Math.max(0, Math.min(requestedOffset, Math.max(0, lineCount - height)));
  return { height, offset };
}
