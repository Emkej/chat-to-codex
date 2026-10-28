import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Workspace } from "./manager.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  offset?: number;
  contextLines?: number;
  filesOnly?: boolean;
  regex?: boolean;
  /** Internal test seam; the MCP contract uses the fixed server bound. */
  maxScanTimeMs?: number;
}

export interface SearchContext {
  before: string[];
  after: string[];
  complete: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  context?: SearchContext;
}

export interface SearchFileMatch {
  path: string;
}

export type SearchRecord = SearchMatch | SearchFileMatch;
export type SearchMode = "matches" | "files";
export type SearchTruncationReason = "match_limit" | "scan_limit" | "output_limit" | null;

export interface SearchResult {
  matches: SearchRecord[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
  hasMore: boolean | null;
  nextOffset: number | null;
  truncationReason: SearchTruncationReason;
  mode: SearchMode;
}

const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_OFFSET = 10_000;
const MAX_CONTEXT_LINES = 3;
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const MAX_SEARCH_SCAN_TIME_MS = 2_000;
const MAX_SEARCH_MATCH_TEXT = 500;

const RG_CANDIDATES = [
  "rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

let cachedRg: string | null | undefined;

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (cachedRg !== undefined) return cachedRg;
  if (process.env.C2C_RG_PATH) {
    cachedRg = process.env.C2C_RG_PATH;
    return cachedRg;
  }
  for (const candidate of RG_CANDIDATES) {
    try {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      if (result.status === 0) {
        cachedRg = candidate;
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  cachedRg = null;
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
}

interface SearchCandidate {
  path: string;
  line: number;
  text: string;
}

function normalizedLimit(opts: SearchOptions): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(opts.limit ?? 50)));
}

function normalizedOffset(opts: SearchOptions): number {
  return Math.min(MAX_SEARCH_OFFSET, Math.max(0, Math.floor(opts.offset ?? 0)));
}

function normalizedContextLines(opts: SearchOptions): number {
  return Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(opts.contextLines ?? 0)));
}

function normalizedScanTimeMs(opts: SearchOptions): number {
  return Math.min(MAX_SEARCH_SCAN_TIME_MS, Math.max(0, Math.floor(opts.maxScanTimeMs ?? MAX_SEARCH_SCAN_TIME_MS)));
}

function smartCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptySearchResult(engine: "ripgrep" | "node", opts: SearchOptions): SearchResult {
  return {
    matches: [],
    matchCount: 0,
    truncated: false,
    engine,
    hasMore: false,
    nextOffset: null,
    truncationReason: null,
    mode: opts.filesOnly ? "files" : "matches",
  };
}

function collectCandidate(
  candidates: SearchCandidate[],
  paths: Set<string>,
  candidate: SearchCandidate,
  filesOnly: boolean,
  scanTarget: number
): boolean {
  if (filesOnly) {
    if (paths.has(candidate.path)) return false;
    paths.add(candidate.path);
  }
  candidates.push(candidate);
  return candidates.length >= scanTarget;
}

function contextLine(line: string): string {
  return line.trimEnd().slice(0, MAX_SEARCH_MATCH_TEXT);
}

async function addContexts(
  ws: Workspace,
  records: SearchRecord[],
  contextLines: number
): Promise<SearchRecord[]> {
  if (contextLines === 0) return records;
  const linesByPath = new Map<string, string[] | null>();
  for (const record of records) {
    if (!("line" in record) || linesByPath.has(record.path)) continue;
    try {
      const { abs } = ws.resolve(record.path);
      const content = await fs.promises.readFile(abs, "utf8");
      linesByPath.set(record.path, content.includes("\0") ? null : content.split(/\r?\n/));
    } catch {
      linesByPath.set(record.path, null);
    }
  }

  return records.map((record) => {
    if (!("line" in record)) return record;
    const lines = linesByPath.get(record.path);
    if (!lines) {
      return { ...record, context: { before: [], after: [], complete: false } };
    }
    const lineIndex = record.line - 1;
    return {
      ...record,
      context: {
        before: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex).map(contextLine),
        after: lines.slice(lineIndex + 1, lineIndex + contextLines + 1).map(contextLine),
        complete: lineIndex >= 0 && lineIndex < lines.length,
      },
    };
  });
}

function trimOneContext(records: SearchRecord[]): boolean {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (!("line" in record) || !record.context) continue;
    if (record.context.after.length > 0) {
      record.context.after.pop();
      record.context.complete = false;
      return true;
    }
    if (record.context.before.length > 0) {
      record.context.before.pop();
      record.context.complete = false;
      return true;
    }
  }
  return false;
}

function serializedBytes(result: SearchResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

async function buildSearchResult(
  ws: Workspace,
  candidates: SearchCandidate[],
  opts: SearchOptions,
  engine: "ripgrep" | "node",
  hasMore: boolean | null,
  truncationReason: SearchTruncationReason
): Promise<SearchResult> {
  const limit = normalizedLimit(opts);
  const offset = normalizedOffset(opts);
  const filesOnly = opts.filesOnly === true;
  const contextLines = normalizedContextLines(opts);
  let records: SearchRecord[] = candidates
    .slice(offset, offset + limit)
    .map((candidate) => (filesOnly ? { path: candidate.path } : { ...candidate }));
  records = await addContexts(ws, records, filesOnly ? 0 : contextLines);

  let result = (): SearchResult => ({
    matches: records,
    matchCount: records.length,
    truncated: hasMore !== false || truncationReason !== null,
    engine,
    hasMore,
    nextOffset: hasMore === true ? offset + records.length : null,
    truncationReason: truncationReason ?? (hasMore === true ? "match_limit" : null),
    mode: filesOnly ? "files" : "matches",
  });
  let built = result();
  while (serializedBytes(built) > MAX_SEARCH_RESPONSE_BYTES) {
    if (contextLines > 0 && trimOneContext(records)) {
      truncationReason = "output_limit";
      built = result();
      continue;
    }
    if (records.length === 0) break;
    records = records.slice(0, -1);
    if (hasMore !== null) hasMore = true;
    if (truncationReason !== "scan_limit") truncationReason = "output_limit";
    built = result();
  }
  return built;
}

async function searchWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  opts: SearchOptions
): Promise<SearchResult> {
  const args = ["--json", "--max-filesize", "2M", "--sort", "path"];
  if (!opts.regex) args.push("-F");
  args.push("--smart-case");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", opts.query, searchAbs);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgBin, args, { cwd: ws.root });
    const candidates: SearchCandidate[] = [];
    const paths = new Set<string>();
    const scanTarget = normalizedOffset(opts) + normalizedLimit(opts) + 1;
    const scanBudget = normalizedScanTimeMs(opts);
    const scanDeadline = Date.now() + scanBudget;
    let hasMore = false;
    let truncationReason: SearchTruncationReason = null;
    let scanLimitTimer: ReturnType<typeof setTimeout> | undefined;
    const markScanLimit = (): void => {
      if (hasMore || truncationReason !== null) return;
      truncationReason = "scan_limit";
      child.kill("SIGTERM");
    };
    scanLimitTimer = setTimeout(markScanLimit, scanBudget);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (hasMore || truncationReason === "scan_limit") return;
      if (Date.now() >= scanDeadline) {
        markScanLimit();
        return;
      }
      try {
        const event = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        const data = event.data;
        const rawPath = data?.path?.text;
        if (!rawPath) return;
        const fileAbs = path.isAbsolute(rawPath) ? rawPath : path.resolve(ws.root, rawPath);
        const rel = path.relative(ws.root, fileAbs).split(path.sep).join("/");
        if (rel.startsWith("..") || ws.ignoreRules.isHidden(rel)) return;
        if (event.type !== "match") return;
        const reachedPage = collectCandidate(
          candidates,
          paths,
          {
            path: rel,
            line: data?.line_number ?? 0,
            text: (data?.lines?.text ?? "").trimEnd().slice(0, MAX_SEARCH_MATCH_TEXT),
          },
          opts.filesOnly === true,
          scanTarget
        );
        if (reachedPage) {
          hasMore = true;
          truncationReason = "match_limit";
          child.kill("SIGTERM");
        }
      } catch {
        // ignore malformed json lines
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      if (scanLimitTimer) clearTimeout(scanLimitTimer);
      const completeness = truncationReason === "scan_limit" ? null : hasMore;
      void buildSearchResult(ws, candidates, opts, "ripgrep", completeness, truncationReason)
        .then(resolvePromise)
        .catch(reject);
    });
  });
}

async function searchWithNode(
  ws: Workspace,
  searchAbs: string,
  opts: SearchOptions
): Promise<SearchResult> {
  const caseSensitive = smartCaseSensitive(opts.query);
  const matcher = opts.regex ? new RegExp(opts.query, caseSensitive ? "" : "i") : null;
  const needle = caseSensitive ? opts.query : opts.query.toLowerCase();
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const candidates: SearchCandidate[] = [];
  const paths = new Set<string>();
  const scanTarget = normalizedOffset(opts) + normalizedLimit(opts) + 1;
  const scanBudget = normalizedScanTimeMs(opts);
  const scanDeadline = Date.now() + scanBudget;
  let scanLimitReached = false;
  let hasMore = false;
  let truncationReason: SearchTruncationReason = null;

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (hasMore || scanLimitReached) return;
    if (Date.now() >= scanDeadline) {
      scanLimitReached = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      if (hasMore || scanLimitReached) return;
      if (Date.now() >= scanDeadline) {
        scanLimitReached = true;
        return;
      }
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(childRel)) continue;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(childAbs);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
        let content: string;
        try {
          content = await fs.promises.readFile(childAbs, "utf8");
        } catch {
          continue;
        }
        if (Date.now() >= scanDeadline) {
          scanLimitReached = true;
          return;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if ((i & 0xff) === 0 && Date.now() >= scanDeadline) {
            scanLimitReached = true;
            return;
          }
          const line = lines[i];
          const hit = matcher
            ? matcher.test(line)
            : caseSensitive
              ? line.includes(needle)
              : line.toLowerCase().includes(needle);
          if (hit) {
            const reachedPage = collectCandidate(
              candidates,
              paths,
              { path: childRel, line: i + 1, text: line.trimEnd().slice(0, MAX_SEARCH_MATCH_TEXT) },
              opts.filesOnly === true,
              scanTarget
            );
            if (reachedPage) {
              hasMore = true;
              truncationReason = "match_limit";
              return;
            }
          }
        }
      }
    }
  };

  const startRel = path.relative(ws.root, searchAbs).split(path.sep).join("/");
  await walk(searchAbs, startRel === "" ? "" : startRel);
  return buildSearchResult(
    ws,
    candidates,
    opts,
    "node",
    scanLimitReached ? null : hasMore,
    scanLimitReached ? "scan_limit" : truncationReason
  );
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return emptySearchResult("node", opts);
  }
  const { abs } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep();
  if (rg) {
    try {
      return await searchWithRipgrep(ws, rg, abs, opts);
    } catch {
      // fall through to node engine
    }
  }
  return searchWithNode(ws, abs, opts);
}
