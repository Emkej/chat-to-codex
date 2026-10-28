import { TextEncoder } from "node:util";
import { Workspace } from "../workspace/manager.js";
import {
  MAX_PATCH_FILES,
  preparePatch,
  readTextEditSource,
  validateRelativePatchPath,
  type TextEditSource,
} from "./patch.js";
import { WriteRequestError, type WriteRequestErrorDetails } from "./types.js";

export interface TextEdit {
  path: string;
  oldText: string;
  newText: string;
}

interface IndexedTextEdit extends TextEdit {
  index: number;
}

interface LineSpan {
  start: number;
  end: number;
  fullEnd: number;
  text: string;
  hasNewline: boolean;
}

interface ChangeBlock {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface ConvertedFile {
  source: TextEditSource;
  edits: IndexedTextEdit[];
  logicalSource: string;
  logicalResult: string;
  expectedBytes: Buffer;
  patch: string;
}

function fail(
  code: ConstructorParameters<typeof WriteRequestError>[0],
  message: string,
  details?: WriteRequestErrorDetails
): never {
  throw new WriteRequestError(code, message, details ? { details } : undefined);
}

function editDetails(
  source: TextEditSource,
  edit: IndexedTextEdit,
  reason: "NO_MATCH" | "AMBIGUOUS_MATCH"
): WriteRequestErrorDetails {
  return {
    kind: "text-edit",
    path: source.path,
    editIndex: edit.index + 1,
    reason,
  };
}

function normalizeLineEndings(value: string, source: TextEditSource): string {
  const withoutCrLf = value.replace(/\r\n/g, "");
  if (withoutCrLf.includes("\r")) {
    return fail("PATCH_UNSUPPORTED_OPERATION", "Text edits cannot contain lone carriage returns.");
  }
  return value.replace(/\r\n/g, "\n");
}

function sourceLogicalText(source: TextEditSource): string {
  return source.eol === "crlf" ? source.text.replace(/\r\n/g, "\n") : source.text;
}

function occurrences(text: string, needle: string): number[] {
  const result: number[] = [];
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const found = text.indexOf(needle, offset);
    if (found < 0) break;
    result.push(found);
    if (result.length > 1) break;
    offset = found + 1;
  }
  return result;
}

function applyTextEdits(source: TextEditSource, edits: IndexedTextEdit[]): { text: string; origins: Array<number | undefined> } {
  let text = sourceLogicalText(source);
  let origins: Array<number | undefined> = Array.from({ length: text.length }, (_, index) => index);

  for (const edit of edits) {
    const oldText = normalizeLineEndings(edit.oldText, source);
    const newText = normalizeLineEndings(edit.newText, source);
    if (oldText.length === 0) {
      return fail("PATCH_INVALID", "Text-edit old_text must not be empty.");
    }
    const matches = occurrences(text, oldText);
    if (matches.length === 0) {
      return fail(
        "PATCH_DOES_NOT_APPLY",
        "Text edit does not match the current source text.",
        editDetails(source, edit, "NO_MATCH")
      );
    }
    if (matches.length > 1) {
      return fail(
        "PATCH_DOES_NOT_APPLY",
        "Text edit matches more than one location in the current source text.",
        editDetails(source, edit, "AMBIGUOUS_MATCH")
      );
    }

    const start = matches[0];
    const end = start + oldText.length;
    text = text.slice(0, start) + newText + text.slice(end);
    origins = [
      ...origins.slice(0, start),
      ...Array<number | undefined>(newText.length).fill(undefined),
      ...origins.slice(end),
    ];
  }

  return { text, origins };
}

function lineSpans(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    lines.push({ start, end: index, fullEnd: index + 1, text: text.slice(start, index), hasNewline: true });
    start = index + 1;
  }
  if (start < text.length) {
    lines.push({ start, end: text.length, fullEnd: text.length, text: text.slice(start), hasNewline: false });
  }
  return lines;
}

function sameLine(oldLine: LineSpan, newLine: LineSpan): boolean {
  return oldLine.text === newLine.text && oldLine.hasNewline === newLine.hasNewline;
}

function mappedSourceLine(
  sourceLines: LineSpan[],
  resultLines: LineSpan[],
  origins: Array<number | undefined>,
  resultIndex: number,
  sourceStarts: Map<number, number>
): number | undefined {
  const resultLine = resultLines[resultIndex];
  const fullLength = resultLine.fullEnd - resultLine.start;
  if (fullLength === 0) return undefined;
  const mappedStart = origins[resultLine.start];
  if (mappedStart === undefined) return undefined;
  const sourceIndex = sourceStarts.get(mappedStart);
  if (sourceIndex === undefined) return undefined;
  const sourceLine = sourceLines[sourceIndex];
  if (!sourceLine || sourceLine.fullEnd - sourceLine.start !== fullLength || !sameLine(sourceLine, resultLine)) {
    return undefined;
  }
  for (let offset = 0; offset < fullLength; offset++) {
    if (origins[resultLine.start + offset] !== sourceLine.start + offset) return undefined;
  }
  return sourceIndex;
}

function changeBlocks(
  sourceLines: LineSpan[],
  resultLines: LineSpan[],
  origins: Array<number | undefined>
): ChangeBlock[] {
  const sourceStarts = new Map(sourceLines.map((line, index) => [line.start, index]));
  const anchors: Array<{ oldIndex: number; newIndex: number }> = [];
  let lastOldIndex = -1;
  for (let newIndex = 0; newIndex < resultLines.length; newIndex++) {
    const oldIndex = mappedSourceLine(sourceLines, resultLines, origins, newIndex, sourceStarts);
    if (oldIndex !== undefined && oldIndex > lastOldIndex) {
      anchors.push({ oldIndex, newIndex });
      lastOldIndex = oldIndex;
    }
  }

  const withSentinels = [
    { oldIndex: -1, newIndex: -1 },
    ...anchors,
    { oldIndex: sourceLines.length, newIndex: resultLines.length },
  ];
  const blocks: ChangeBlock[] = [];
  for (let index = 1; index < withSentinels.length; index++) {
    const previous = withSentinels[index - 1];
    const next = withSentinels[index];
    const block = {
      oldStart: previous.oldIndex + 1,
      oldEnd: next.oldIndex,
      newStart: previous.newIndex + 1,
      newEnd: next.newIndex,
    };
    if (block.oldStart !== block.oldEnd || block.newStart !== block.newEnd) blocks.push(block);
  }
  return blocks;
}

function mergeChangeBlocks(blocks: ChangeBlock[]): ChangeBlock[] {
  const merged: ChangeBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (
      previous &&
      block.oldStart - previous.oldEnd <= 6 &&
      block.newStart - previous.newEnd <= 6
    ) {
      previous.oldEnd = block.oldEnd;
      previous.newEnd = block.newEnd;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function formatRange(startIndex: number, count: number): string {
  return count === 0 ? `${startIndex},0` : `${startIndex + 1},${count}`;
}

function patchLines(prefix: " " | "+" | "-", line: LineSpan): string[] {
  return [prefix + line.text, ...(line.hasNewline ? [] : ["\\ No newline at end of file"])];
}

function renderPatch(source: TextEditSource, logicalSource: string, logicalResult: string, origins: Array<number | undefined>): string {
  const sourceLines = lineSpans(logicalSource);
  const resultLines = lineSpans(logicalResult);
  const blocks = mergeChangeBlocks(changeBlocks(sourceLines, resultLines, origins));
  if (blocks.length === 0) return fail("PATCH_DOES_NOT_APPLY", "Text edits produce no content change.");

  const hunks = blocks.map((block) => {
    let before = Math.min(3, block.oldStart, block.newStart);
    while (
      before > 0 &&
      !sameLine(sourceLines[block.oldStart - before], resultLines[block.newStart - before])
    ) {
      before--;
    }
    let after = Math.min(3, sourceLines.length - block.oldEnd, resultLines.length - block.newEnd);
    while (after > 0 && !sameLine(sourceLines[block.oldEnd + after - 1], resultLines[block.newEnd + after - 1])) {
      after--;
    }

    const oldStart = block.oldStart - before;
    const oldEnd = block.oldEnd + after;
    const newStart = block.newStart - before;
    const newEnd = block.newEnd + after;
    const lines: string[] = [];
    for (let index = 0; index < before; index++) lines.push(...patchLines(" ", sourceLines[oldStart + index]));
    for (let index = block.oldStart; index < block.oldEnd; index++) lines.push(...patchLines("-", sourceLines[index]));
    for (let index = block.newStart; index < block.newEnd; index++) lines.push(...patchLines("+", resultLines[index]));
    for (let index = 0; index < after; index++) lines.push(...patchLines(" ", sourceLines[block.oldEnd + index]));
    return [
      `@@ -${formatRange(oldStart, oldEnd - oldStart)} +${formatRange(newStart, newEnd - newStart)} @@`,
      ...lines,
    ];
  });

  return [
    `--- a/${source.path}`,
    `+++ b/${source.path}`,
    ...hunks.flat(),
    "",
  ].join("\n");
}

function encodeResult(source: TextEditSource, logicalResult: string): Buffer {
  const withEol = source.eol === "crlf" ? logicalResult.replace(/\n/g, "\r\n") : logicalResult;
  const encoded = Buffer.from(new TextEncoder().encode(withEol));
  return source.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
}

function samePathKey(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function validateEdit(edit: TextEdit): void {
  if (!edit || typeof edit.path !== "string" || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
    return fail("PATCH_INVALID", "Text edits must contain path, old_text, and new_text strings.");
  }
  validateRelativePatchPath(edit.path);
  if (edit.oldText.length === 0) return fail("PATCH_INVALID", "Text-edit old_text must not be empty.");
}

function convertFile(source: TextEditSource, edits: IndexedTextEdit[]): ConvertedFile {
  if (source.eol === "mixed") {
    return fail("PATCH_UNSUPPORTED_OPERATION", "Mixed line endings are not supported by text edits.");
  }
  const logicalSource = sourceLogicalText(source);
  const { text: logicalResult, origins } = applyTextEdits(source, edits);
  if (logicalResult === logicalSource) return fail("PATCH_DOES_NOT_APPLY", "Text edits produce no content change.");
  const expectedBytes = encodeResult(source, logicalResult);
  const patch = renderPatch(source, logicalSource, logicalResult, origins);
  return { source, edits, logicalSource, logicalResult, expectedBytes, patch };
}

export function createTextEditPatch(
  workspace: Workspace,
  edits: readonly TextEdit[],
  protectedRoots: readonly string[] = []
): string {
  if (!Array.isArray(edits) || edits.length === 0) return fail("PATCH_INVALID", "At least one text edit is required.");
  if (edits.length > 50) return fail("PATCH_TOO_MANY_FILES", "Text edits exceed the 50-edit limit.");

  const files = new Map<string, { source: TextEditSource; edits: IndexedTextEdit[] }>();
  for (const [index, edit] of edits.entries()) {
    validateEdit(edit);
    const source = files.get(samePathKey(edit.path))?.source ?? readTextEditSource(workspace, edit.path, protectedRoots);
    const key = samePathKey(source.path);
    const entry = files.get(key);
    if (entry) {
      entry.edits.push({ ...edit, index });
    } else {
      files.set(key, { source, edits: [{ ...edit, index }] });
    }
  }
  if (files.size > MAX_PATCH_FILES) return fail("PATCH_TOO_MANY_FILES", "Patch exceeds the 50-file limit.");

  const converted = [...files.values()].map(({ source, edits: fileEdits }) => convertFile(source, fileEdits));
  const patch = converted.map((file) => file.patch).join("");
  const prepared = preparePatch(workspace, patch, protectedRoots);
  for (const file of converted) {
    const preparedFile = prepared.files.find((candidate) => candidate.path === file.source.path);
    if (!preparedFile || !preparedFile.resultBytes.equals(file.expectedBytes)) {
      return fail("PATCH_UNSUPPORTED_OPERATION", "Text edits could not be represented by the unified patch lifecycle.");
    }
  }
  return patch;
}
