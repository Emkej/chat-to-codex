import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { browseSnapshot, compareSnapshots, listBranches, resolveRepositoryOwner, searchSnapshot } from "../src/workspace/git-snapshot.js";
import { gitDiff } from "../src/workspace/git.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const ref = "refs/heads/boundaries";

function fixture(files: Record<string, string>): string {
  const root = makeTmpDir("snapshot-boundaries");
  makeGitRepo(root);
  git(root, "checkout", "-b", "boundaries");
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  git(root, "add", ".");
  git(root, "commit", "-m", "boundary fixtures");
  git(root, "checkout", "main");
  return root;
}

describe("snapshot browse byte and line boundaries", () => {
  it("accepts an exact 1 MiB blob and rejects one byte above before pagination", () => {
    const content = `${"x".repeat(1023)}\n`.repeat(1024);
    expect(Buffer.byteLength(content)).toBe(MiB);
    const root = fixture({ "exact.txt": content, "above.txt": `${content}x` });
    try {
      const owner = resolveRepositoryOwner(root);
      expect(browseSnapshot(owner, { ref, path: "exact.txt" })).toMatchObject({
        kind: "file", sizeBytes: MiB, totalLines: 1024, truncated: true,
      });
      expect(() => browseSnapshot(owner, { ref, path: "above.txt", endLine: 1 })).toThrowError(
        expect.objectContaining({ code: "FILE_TOO_LARGE" })
      );
    } finally { cleanup(root); }
  });

  it.each([
    ["ASCII exact", "x".repeat(256 * KiB), true],
    ["ASCII above", "x".repeat(256 * KiB + 1), false],
    ["UTF-8 exact", "é".repeat(128 * KiB), true],
    ["UTF-8 above", `${"é".repeat(128 * KiB)}x`, false],
    ["300 KiB line", "x".repeat(300 * KiB), false],
  ])("enforces the response byte cap for %s", (_label, content, accepted) => {
    const root = fixture({ "line.txt": content as string });
    try {
      const owner = resolveRepositoryOwner(root);
      const read = () => browseSnapshot(owner, { ref, path: "line.txt" });
      if (accepted) {
        expect(read()).toMatchObject({ kind: "file", content, truncated: false, nextStartLine: null });
      } else {
        expect(read).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
      }
    } finally { cleanup(root); }
  });

  it.each([false, true])("preserves complete-line progress including newline bytes (exact=%s)", (exact) => {
    const lines = ["a".repeat(128 * KiB), "é".repeat(64 * KiB - (exact ? 1 : 0)) + (exact ? "b" : ""), "tail"];
    const root = fixture({ "pages.txt": lines.join("\n") });
    try {
      const owner = resolveRepositoryOwner(root);
      const first = browseSnapshot(owner, { ref, path: "pages.txt" });
      if (first.kind !== "file") throw new Error("Expected file");
      expect(first.endLine).toBe(exact ? 2 : 1);
      expect(Buffer.byteLength(first.content)).toBe(exact ? 256 * KiB : 128 * KiB);
      expect(first.nextStartLine).toBe(first.endLine + 1);
      const second = browseSnapshot(owner, {
        ref, path: "pages.txt", startLine: first.nextStartLine!, expectedCommit: first.commit,
      });
      if (second.kind !== "file") throw new Error("Expected file");
      expect(second.startLine).toBe(first.endLine + 1);
      expect(second.content.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(second.content)).toBeLessThanOrEqual(256 * KiB);
      expect(second).toMatchObject({ endLine: 3, truncated: false, nextStartLine: null });
      expect(`${first.content}\n${second.content}`).toBe(lines.join("\n"));
    } finally { cleanup(root); }
  });

  it("resumes after the 2000-line hard page limit", () => {
    const lines = Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`);
    const root = fixture({ "lines.txt": lines.join("\n") });
    try {
      const owner = resolveRepositoryOwner(root);
      const first = browseSnapshot(owner, { ref, path: "lines.txt", endLine: 9999 });
      if (first.kind !== "file") throw new Error("Expected file");
      expect(first).toMatchObject({ endLine: 2000, nextStartLine: 2001, remainingLines: 1 });
      const second = browseSnapshot(owner, { ref, path: "lines.txt", startLine: 2001, expectedCommit: first.commit });
      expect(second).toMatchObject({ content: "line 2001", truncated: false, nextStartLine: null });
    } finally { cleanup(root); }
  });
});

describe("snapshot search and comparison resource boundaries", () => {
  it("terminates raw output above 2 MiB while keeping only complete safe matches", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `needle ${index} ${"x".repeat(24 * KiB)}`);
    const root = fixture({ "matches.txt": `${lines.join("\n")}\n` });
    try {
      const result = await searchSnapshot(resolveRepositoryOwner(root), { ref, query: "needle", limit: 200 });
      expect(result).toMatchObject({ truncated: true, truncationReason: "output_limit" });
      expect(result.matchCount).toBeGreaterThan(0);
      expect(result.matchCount).toBeLessThan(100);
      const commit = git(root, "rev-parse", ref).trim();
      let rawBytes = 0;
      let completeRecords = 0;
      for (const [index, line] of lines.entries()) {
        rawBytes += Buffer.byteLength(`${commit}:matches.txt\0${index + 1}\0${line}\n`);
        if (rawBytes > 2 * MiB) break;
        completeRecords++;
      }
      expect(result.matchCount).toBe(completeRecords);
      expect(result.matchCount).toBe(result.matches.length);
      for (const [index, match] of result.matches.entries()) {
        expect(match).toEqual({ path: "matches.txt", line: index + 1, text: lines[index].slice(0, 500) });
      }
    } finally { cleanup(root); }
  });

  it("does not return an incomplete extreme grep line at the raw output cap", async () => {
    const root = fixture({ "extreme.txt": `needle safe\nneedle ${"x".repeat(2 * MiB)}\n` });
    try {
      const result = await searchSnapshot(resolveRepositoryOwner(root), { ref, query: "needle", limit: 200 });
      expect(result).toMatchObject({ truncated: true, truncationReason: "output_limit", matchCount: 1 });
      expect(result.matches).toEqual([{ path: "extreme.txt", line: 1, text: "needle safe" }]);
    } finally { cleanup(root); }
  });

  it("fails with DIFF_TOO_LARGE above 64 MiB rather than returning a partial page", () => {
    const root = fixture({ "large.txt": `${"x".repeat(1023)}\n`.repeat(64 * KiB) });
    try {
      expect(() => compareSnapshots(resolveRepositoryOwner(root), {
        baseRef: "refs/heads/main", targetRef: ref, maxBytes: 1024,
      })).toThrowError(expect.objectContaining({ code: "DIFF_TOO_LARGE" }));
    } finally { cleanup(root); }
  }, 30_000);
});

describe("snapshot execution and replacement isolation", () => {
  it("never executes configured textconv or external diff in compare, search and existing diff modes", async () => {
    const root = fixture({ ".gitattributes": "driver.txt diff=probe\n", "driver.txt": "needle committed\n" });
    try {
      const sentinel = path.join(root, "driver-ran");
      // Git reads attributes from the checked-out tree, which is main here.
      write(root, ".git/info/attributes", "driver.txt diff=probe\n");
      const driver = write(root, "probe.sh", `#!/bin/sh\nprintf ran > '${sentinel}'\nprintf 'needle converted\\n'\n`);
      fs.chmodSync(driver, 0o755);
      git(root, "config", "diff.probe.textconv", driver);
      // Positive controls prove Git recognizes each configured driver and its side effect.
      git(root, "diff", "--textconv", "main", "boundaries", "--", "driver.txt");
      expect(fs.existsSync(sentinel)).toBe(true);
      fs.unlinkSync(sentinel);
      git(root, "config", "diff.external", driver);
      git(root, "diff", "--ext-diff", "main", "boundaries", "--", "driver.txt");
      expect(fs.existsSync(sentinel)).toBe(true);
      fs.unlinkSync(sentinel);

      const owner = resolveRepositoryOwner(root);
      const comparison = compareSnapshots(owner, { baseRef: "refs/heads/main", targetRef: ref });
      expect(comparison.diff).toContain("needle committed");
      const search = await searchSnapshot(owner, { ref, query: "needle" });
      expect(search.matches).toEqual([{ path: "driver.txt", line: 1, text: "needle committed" }]);
      git(root, "checkout", "boundaries");
      write(root, "driver.txt", "needle changed\n");
      for (const mode of ["unstaged", "head"] as const) {
        expect(gitDiff(root, { mode }).diff).toContain("needle changed");
      }
      git(root, "add", "driver.txt");
      expect(gitDiff(root, { mode: "staged" }).diff).toContain("needle changed");
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally { cleanup(root); }
  });

  it("keeps discovery, browse, search and compare ancestry invariant as replacement refs change", async () => {
    const root = fixture({ "marker.txt": "original needle\n" });
    try {
      const original = git(root, "rev-parse", ref).trim();
      const owner = resolveRepositoryOwner(root);
      const inspect = async () => ({
        branches: listBranches(owner),
        browse: browseSnapshot(owner, { ref, path: "marker.txt" }),
        search: await searchSnapshot(owner, { ref, query: "needle" }),
        compare: compareSnapshots(owner, { baseRef: "refs/heads/main", targetRef: ref }),
      });
      // An orphan replacement changes ancestry as well as content unless disabled.
      git(root, "checkout", "--orphan", "replacement");
      git(root, "rm", "-rf", ".");
      write(root, "marker.txt", "replacement needle\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "unrelated replacement");
      const replacement = git(root, "rev-parse", "HEAD").trim();
      write(root, "marker.txt", "changed replacement needle\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "changed replacement");
      const changed = git(root, "rev-parse", "HEAD").trim();
      git(root, "checkout", "main");
      const expected = await inspect();
      expect(expected.browse).toMatchObject({ content: "original needle", commit: original });
      expect(expected.search.matches).toEqual([{ path: "marker.txt", line: 1, text: "original needle" }]);
      expect(expected.compare.mergeBase).toBe(git(root, "rev-parse", "main").trim());
      for (const replacementCommit of [replacement, changed]) {
        git(root, "replace", "-f", original, replacementCommit);
        expect(git(root, "show", `${ref}:marker.txt`)).toContain("replacement needle");
        expect(await inspect()).toEqual(expected);
      }
      git(root, "replace", "-d", original);
      expect(await inspect()).toEqual(expected);
    } finally { cleanup(root); }
  });
});
