import { wrapDetailValue } from "./workspace-detail-layout.js";
import type { ManagerSnapshot } from "./types.js";

/** Escape input controls without losing LF boundaries or confusing literal backslashes. */
export function escapeReviewText(value: string, preserveNewlines = false): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    if (preserveNewlines && character === "\n") return character;
    if (character === "\\") return "\\\\";
    if (code < 32 || (code >= 127 && code <= 159) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      return "\\u{" + code.toString(16).padStart(4, "0") + "}";
    }
    return character;
  }).join("");
}

export function requestReviewLines(snapshot: ManagerSnapshot, columns: number): string[] {
  const review = snapshot.requestReview;
  if (!review) return [];
  const values = [`Workspace: ${escapeReviewText(review.workspaceId)}`];
  const attempt = snapshot.approvalAttempt;
  if (attempt?.state === "unknown") {
    values.push(`UNKNOWN approval outcome: ${escapeReviewText(attempt.id)}`, "No automatic retry. Press r to reconcile or inspect this id with the CLI.");
  } else if (attempt) {
    values.push(`${escapeReviewText(attempt.id)}: ${escapeReviewText(attempt.receipt?.status ?? "resolved")}`);
  }
  if (snapshot.notice) values.push(escapeReviewText(snapshot.notice));
  if (review.detail) {
    const detail = review.detail;
    if (detail.state === "loading") values.push("Loading selected request...");
    else if (detail.state === "unavailable") values.push("Request unavailable or no longer pending. Press r to reload the queue.");
    else if (detail.request) {
      const request = detail.request;
      values.push(`Request: ${escapeReviewText(request.id)}`, `Status: ${escapeReviewText(request.status)}`,
        `Target: ${escapeReviewText(request.worktreeId ?? "main workspace")}`,
        `Created: ${escapeReviewText(request.createdAt)}`, `Expires: ${escapeReviewText(request.expiresAt ?? "resolved")}`);
      for (const file of request.files) {
        values.push(`${escapeReviewText(file.path)} (${escapeReviewText(file.operation)}) +${file.additions} -${file.deletions}`);
      }
      if (request.patch !== undefined) {
        values.push("Diff (controls shown as \\u{code}; literal backslashes doubled):");
        for (const line of escapeReviewText(request.patch, true).split("\n")) values.push(line);
      } else values.push("No pending patch. Refresh to return to the queue.");
    }
  } else if (review.state === "loading") values.push("Loading pending requests...");
  else if (review.state === "unavailable") values.push("Pending requests unavailable. Press r to retry.");
  else {
    if (!review.requests.length) values.push("No active pending requests.");
    if (review.overflow) values.push("More than 100 pending requests. Showing the newest 100; additional entries are omitted.");
    review.requests.forEach((request, index) => {
      values.push(`${index === review.selectedIndex ? "> " : "  "}${escapeReviewText(request.id)} [${escapeReviewText(request.worktreeId ?? "main")}]`,
        `  Created ${escapeReviewText(request.createdAt)}; expires ${escapeReviewText(request.expiresAt ?? "unknown")}`);
      for (const file of request.files) values.push(`  ${escapeReviewText(file.path)} +${file.additions} -${file.deletions}`);
    });
  }
  return values.flatMap((value) => {
    // Large ASCII hunks do not need Unicode grapheme segmentation.
    if (!/^[\x20-\x7e]*$/.test(value)) return wrapDetailValue(value, columns);
    const width = Math.max(1, columns), lines: string[] = [];
    for (let offset = 0; offset < value.length; offset += width) lines.push(value.slice(offset, offset + width));
    return lines.length ? lines : [""];
  });
}

export function selectedRequestOffset(snapshot: ManagerSnapshot, columns: number): number {
  const review = snapshot.requestReview;
  if (!review || review.detail) return 0;
  return Math.max(0, requestReviewLines(snapshot, columns).findIndex((line) => line.startsWith("> ")));
}
