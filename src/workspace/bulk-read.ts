import { Workspace, WorkspaceError, type ReadFileResult } from "./manager.js";

export const BULK_READ_LIMITS = {
  maxItems: 10,
  minResponseBytes: 16 * 1024,
  maxResponseBytes: 256 * 1024,
  maxDisplayPathBytes: 512,
  maxErrorMessageBytes: 256,
} as const;

export interface BulkReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface BulkReadSuccess {
  index: number;
  path: string;
  status: "ok";
  size_bytes: number;
  total_lines: number;
  start_line: number;
  end_line: number;
  truncated: boolean;
  remaining_lines: number;
  next_start_line: number | null;
  content: string;
}

interface BulkReadFailure {
  index: number;
  path: string;
  start_line: number | null;
  end_line: number | null;
  status: "error" | "skipped";
  error: {
    code: string;
    message: string;
  };
}

export type BulkReadItem = BulkReadSuccess | BulkReadFailure;

export interface BulkReadResult {
  items: BulkReadItem[];
  item_count: number;
  returned_count: number;
  skipped_count: number;
  truncated: boolean;
  response_bytes: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_PATH: "Invalid path.",
  PATH_OUTSIDE_WORKSPACE: "Path is outside the workspace.",
  ACCESS_DENIED_SENSITIVE_FILE: "Path is denied by the sensitive-file policy.",
  FILE_NOT_FOUND: "File was not found.",
  NOT_A_FILE: "Path is not a regular file.",
  NOT_A_DIRECTORY: "Path is not a directory.",
  BINARY_FILE: "Binary file content is not returned.",
  FILE_TOO_LARGE: "File content exceeds the read limit.",
};

function displayPath(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= BULK_READ_LIMITS.maxDisplayPathBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, BULK_READ_LIMITS.maxDisplayPathBytes - 3).toString("utf8")}...`;
}

function failure(
  index: number,
  request: BulkReadRequest,
  status: "error" | "skipped",
  code: string,
  message: string
): BulkReadFailure {
  return {
    index,
    path: displayPath(request.path),
    start_line: request.startLine ?? null,
    end_line: request.endLine ?? null,
    status,
    error: {
      code,
      message: message.slice(0, BULK_READ_LIMITS.maxErrorMessageBytes),
    },
  };
}

function skipped(index: number, request: BulkReadRequest): BulkReadFailure {
  return failure(index, request, "skipped", "RESPONSE_LIMIT", "Skipped because the shared response limit was reached.");
}

function success(index: number, requestedPath: string, result: ReadFileResult): BulkReadSuccess {
  return {
    index,
    path: displayPath(result.path || requestedPath),
    status: "ok",
    size_bytes: result.sizeBytes,
    total_lines: result.totalLines,
    start_line: result.startLine,
    end_line: result.endLine,
    truncated: result.truncated,
    remaining_lines: result.remainingLines,
    next_start_line: result.nextStartLine,
    content: result.content,
  };
}

function emptySuccess(index: number, request: BulkReadRequest): BulkReadSuccess {
  return {
    index,
    path: displayPath(request.path),
    status: "ok",
    size_bytes: 0,
    total_lines: 0,
    start_line: 1,
    end_line: 0,
    truncated: false,
    remaining_lines: 0,
    next_start_line: null,
    content: "",
  };
}

function serialize(
  items: BulkReadItem[],
  itemCount: number,
  truncated: boolean
): BulkReadResult {
  let result: BulkReadResult = {
    items,
    item_count: itemCount,
    returned_count: items.filter((item) => item.status === "ok").length,
    skipped_count: items.filter((item) => item.status === "skipped").length,
    truncated,
    response_bytes: 0,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    result = { ...result, response_bytes: Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") };
  }
  return result;
}

function normalizedResponseLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return BULK_READ_LIMITS.maxResponseBytes;
  return Math.min(BULK_READ_LIMITS.maxResponseBytes, Math.max(BULK_READ_LIMITS.minResponseBytes, Math.floor(value)));
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof WorkspaceError) {
    return {
      code: error.code,
      message: ERROR_MESSAGES[error.code] ?? "File read failed.",
    };
  }
  return { code: "INTERNAL_ERROR", message: "File read failed." };
}

export async function readFiles(
  workspace: Workspace,
  requests: BulkReadRequest[],
  maxTotalBytes?: number
): Promise<BulkReadResult> {
  const items: BulkReadItem[] = requests.map((request, index) => skipped(index, request));
  const responseLimit = normalizedResponseLimit(maxTotalBytes);
  let responseTruncated = false;

  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const placeholders = items.slice(index + 1);
    const reserve = serialize(
      [...items.slice(0, index), emptySuccess(index, request), ...placeholders],
      requests.length,
      responseTruncated
    );
    const available = responseLimit - reserve.response_bytes - 2048;
    if (available < 1024) {
      responseTruncated = true;
      continue;
    }

    let maxBytes = Math.min(1024 * 1024, available);
    let selected: BulkReadSuccess | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await workspace.readFile(request.path, {
          startLine: request.startLine,
          endLine: request.endLine,
          maxBytes,
        });
        const candidate = success(index, request.path, result);
        const candidateResponse = serialize(
          [...items.slice(0, index), candidate, ...placeholders],
          requests.length,
          responseTruncated || result.truncated
        );
        if (candidateResponse.response_bytes <= responseLimit) {
          selected = candidate;
          break;
        }
        const overage = candidateResponse.response_bytes - responseLimit;
        const nextMaxBytes = Math.max(1024, maxBytes - overage - 1024);
        if (nextMaxBytes >= maxBytes) break;
        maxBytes = nextMaxBytes;
      } catch (error) {
        const details = errorDetails(error);
        items[index] = failure(index, request, "error", details.code, details.message);
        selected = null;
        break;
      }
    }

    if (selected) {
      items[index] = selected;
    } else if (items[index].status === "skipped") {
      responseTruncated = true;
    }
  }

  return serialize(items, requests.length, responseTruncated);
}
