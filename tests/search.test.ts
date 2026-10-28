import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { searchWorkspace, resetRipgrepCache, findRipgrep } from "../src/workspace/search.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

let root: string;
let ws: Workspace;
let originalDisableRg: string | undefined;
const globMarker = "C2C_GLOB_MARKER";

beforeAll(() => {
  root = makeTmpDir("search-ws");
  write(root, "src/auth.ts", "export function login() { return 'needle-alpha'; }\n");
  write(root, "src/deep/nested.ts", `// needle-alpha appears here too\n${globMarker}\n`);
  write(root, "src/root.ts", `${globMarker}\n`);
  write(root, "root.ts", `${globMarker}\n`);
  write(root, "README.md", "This project contains needle-alpha documentation.\n");
  write(root, ".env", "NEEDLE-ALPHA=secret\n");
  write(root, "node_modules/pkg/index.js", "needle-alpha in dependencies\n");
  for (let i = 0; i < 30; i++) {
    write(root, `many/file-${i}.txt`, "needle-beta\nneedle-beta\n");
  }
  write(root, "many/single-file.txt", Array.from({ length: 25 }, () => "needle-gamma").join("\n") + "\n");
  write(root, "exact-limit.txt", Array.from({ length: 10 }, () => "needle-delta").join("\n") + "\n");
  write(root, "context.txt", "before one\nbefore two\nneedle-context\nafter one\nafter two\n");
  write(root, "case/Smart.txt", "Needle-Smart\nneedle-smart\n");
  write(root, "case/A.txt", "needle-order\n");
  write(root, "case/z.txt", "needle-order\n");
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
});

beforeEach(() => {
  originalDisableRg = process.env.C2C_DISABLE_RG;
});

afterEach(() => {
  if (originalDisableRg === undefined) delete process.env.C2C_DISABLE_RG;
  else process.env.C2C_DISABLE_RG = originalDisableRg;
  resetRipgrepCache();
});

function engines(): ("ripgrep" | "node")[] {
  const previous = process.env.C2C_DISABLE_RG;
  try {
    delete process.env.C2C_DISABLE_RG;
    resetRipgrepCache();
    return findRipgrep() ? ["ripgrep", "node"] : ["node"];
  } finally {
    if (previous === undefined) delete process.env.C2C_DISABLE_RG;
    else process.env.C2C_DISABLE_RG = previous;
    resetRipgrepCache();
  }
}

describe.each(engines())("search engine: %s", (engine) => {
  const configure = (): void => {
    if (engine === "node") process.env.C2C_DISABLE_RG = "1";
    else delete process.env.C2C_DISABLE_RG;
    resetRipgrepCache();
  };

  it("finds matches with paths and line numbers", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    expect(result.engine).toBe(engine);
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/deep/nested.ts");
    expect(paths).toContain("README.md");
    const authMatch = result.matches.find((match) => match.path === "src/auth.ts");
    expect(authMatch?.line).toBe(1);
  });

  it("never returns sensitive or noise files", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    const paths = result.matches.map((match) => match.path);
    expect(paths.some((p) => p.includes(".env"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("respects the limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-beta", limit: 10 });
    expect(result.matches.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("does not apply a per-file match cap before the global limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-gamma", limit: 50 });
    expect(result.matches).toHaveLength(25);
    expect(result.matchCount).toBe(25);
    expect(result.truncated).toBe(false);
  });

  it("only marks a result truncated when an eligible match is omitted", async () => {
    configure();
    const complete = await searchWorkspace(ws, { query: "needle-delta", limit: 10 });
    const limited = await searchWorkspace(ws, { query: "needle-delta", limit: 9 });
    expect(complete).toMatchObject({ matchCount: 10, truncated: false });
    expect(limited).toMatchObject({ matchCount: 9, truncated: true });
  });

  it("does not claim completeness when the cumulative scan budget is exhausted", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-never-present", maxScanTimeMs: 0 });
    expect(result).toMatchObject({
      matches: [],
      truncated: true,
      hasMore: null,
      nextOffset: null,
      truncationReason: "scan_limit",
    });
  });

  it("pages deterministically without duplicate matching lines", async () => {
    configure();
    const first = await searchWorkspace(ws, { query: "needle-alpha", limit: 2 });
    const second = await searchWorkspace(ws, { query: "needle-alpha", limit: 2, offset: first.nextOffset ?? 0 });
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(2);
    expect(first.matches.map((match) => `${match.path}:${"line" in match ? match.line : 0}`)).toEqual([
      "README.md:1",
      "src/auth.ts:1",
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.matches.map((match) => `${match.path}:${"line" in match ? match.line : 0}`)).toEqual(["src/deep/nested.ts:1"]);
  });

  it("returns unique paths when files_only is enabled", async () => {
    configure();
    const first = await searchWorkspace(ws, { query: "needle-beta", filesOnly: true, limit: 3 });
    const second = await searchWorkspace(ws, { query: "needle-beta", filesOnly: true, limit: 3, offset: first.nextOffset ?? 0 });
    expect(first.mode).toBe("files");
    expect(first.matches).toHaveLength(3);
    expect(new Set(first.matches.map((match) => match.path)).size).toBe(3);
    expect(first.matches.every((match) => !("line" in match))).toBe(true);
    expect(second.matches.some((match) => first.matches.some((firstMatch) => firstMatch.path === match.path))).toBe(false);
  });

  it("matches smart-case semantics and path ordering in both engines", async () => {
    configure();
    const insensitive = await searchWorkspace(ws, { query: "needle-smart" });
    expect(insensitive.matches.map((match) => "line" in match ? match.line : 0)).toEqual([1, 2]);

    const sensitive = await searchWorkspace(ws, { query: "Needle-Smart" });
    expect(sensitive.matches.map((match) => "line" in match ? match.line : 0)).toEqual([1]);

    const ordered = await searchWorkspace(ws, { query: "needle-order" });
    expect(ordered.matches.map((match) => match.path)).toEqual(["case/A.txt", "case/z.txt"]);
  });

  it("adds bounded context without changing match locations", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-context", contextLines: 2 });
    const match = result.matches[0];
    expect(match && "line" in match ? match : null).toMatchObject({
      path: "context.txt",
      line: 3,
      context: { before: ["before one", "before two"], after: ["after one", "after two"], complete: true },
    });
  });

  it("supports glob filters", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", glob: "*.md" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.endsWith(".ts"))).toBe(false);
  });

  it("matches root and nested files for recursive globs", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: globMarker, glob: "**/*.ts" });
    const paths = result.matches.map((match) => match.path).sort();
    expect(paths).toEqual(["root.ts", "src/deep/nested.ts", "src/root.ts"]);
  });

  it("restricts search to a subdirectory", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", path: "src" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("README.md");
  });
});
