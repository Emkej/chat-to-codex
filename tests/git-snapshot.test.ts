import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SnapshotError,
  browseSnapshot,
  compareSnapshots,
  listBranches,
  normalizeRepositoryPath,
  resolveBranchRef,
  resolveRepositoryOwner,
  searchSnapshot,
} from "../src/workspace/git-snapshot.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

function createBranchFixture(): { root: string; hiddenCommit: string } {
  const root = makeTmpDir("git-snapshot");
  makeGitRepo(root);
  git(root, "checkout", "-b", "codex/change-005-fixture");
  write(root, "branch-marker.txt", "unchecked-out branch marker\nsecond line\n");
  git(root, "add", "branch-marker.txt");
  git(root, "commit", "-m", "add unchecked-out branch marker");
  const hiddenCommit = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "main");
  return { root, hiddenCommit };
}

function expectSnapshotError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function snapshotObjectStore(root: string): string {
  const objectStore = path.resolve(root, git(root, "rev-parse", "--git-path", "objects").trim());
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.push(`${path.relative(objectStore, entryPath)}:${fs.statSync(entryPath).size}`);
    }
  };

  visit(objectStore);
  return files.sort().join("\n");
}

describe("repository snapshot domain", () => {
  it("discovers and inspects an unchecked-out local branch", async () => {
    const { root, hiddenCommit } = createBranchFixture();
    try {
      const owner = resolveRepositoryOwner(root);
      const worktrees = git(root, "worktree", "list", "--porcelain");
      expect(worktrees).not.toContain("codex/change-005-fixture");

      const branches = listBranches(owner);
      expect(branches.branches).toContainEqual({
        ref: "refs/heads/codex/change-005-fixture",
        name: "codex/change-005-fixture",
        kind: "local",
        commit: hiddenCommit,
      });

      const file = browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
      });
      expect(file).toMatchObject({
        kind: "file",
        path: "branch-marker.txt",
        content: "unchecked-out branch marker\nsecond line",
      });

      const search = await searchSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        query: "unchecked-out",
      });
      expect(search.matches).toEqual([
        { path: "branch-marker.txt", line: 1, text: "unchecked-out branch marker" },
      ]);

      const comparison = compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/codex/change-005-fixture",
      });
      expect(comparison.comparison).toBe("merge_base_to_target");
      expect(comparison.diff).toContain("branch-marker.txt");
      expect(comparison.diff).toContain("unchecked-out branch marker");
      const fileComparison = compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
      });
      expect(fileComparison.diff).toContain("branch-marker.txt");
    } finally {
      cleanup(root);
    }
  });

  it("enumerates remote-tracking refs but omits symbolic remote HEAD", () => {
    const { root } = createBranchFixture();
    try {
      const commit = git(root, "rev-parse", "refs/heads/main").trim();
      git(root, "update-ref", "refs/remotes/origin/codex-change-005", commit);
      git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/codex-change-005");
      const owner = resolveRepositoryOwner(root);
      const branches = listBranches(owner).branches;
      expect(branches).toContainEqual({
        ref: "refs/remotes/origin/codex-change-005",
        name: "origin/codex-change-005",
        kind: "remote_tracking",
        commit,
      });
      expect(branches.some((branch) => branch.ref.endsWith("/HEAD"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("rejects symbolic remote aliases even outside the remote HEAD name", () => {
    const { root } = createBranchFixture();
    try {
      const commit = git(root, "rev-parse", "refs/heads/main").trim();
      git(root, "update-ref", "refs/tags/release", commit);
      git(root, "symbolic-ref", "refs/remotes/origin/release-alias", "refs/tags/release");
      const owner = resolveRepositoryOwner(root);
      expect(() => resolveBranchRef(owner, "refs/remotes/origin/release-alias")).toThrowError(
        expect.objectContaining({ code: "INVALID_REF" })
      );
    } finally {
      cleanup(root);
    }
  });

  it("keeps repository authority on the registered main worktree", () => {
    const parent = makeTmpDir("git-snapshot-linked");
    const root = path.join(parent, "main");
    const linked = path.join(parent, "linked");
    fs.mkdirSync(root, { recursive: true });
    makeGitRepo(root);
    git(root, "worktree", "add", "-b", "linked-change-005", linked);
    try {
      expect(() => resolveRepositoryOwner(linked)).toThrowError(
        expect.objectContaining({ code: "REPOSITORY_SCOPE_UNAVAILABLE" })
      );
    } finally {
      git(root, "worktree", "remove", "--force", linked);
      cleanup(parent);
    }
  });

  it("rejects arbitrary revision syntax and unsafe repository paths", () => {
    const { root } = createBranchFixture();
    try {
      const owner = resolveRepositoryOwner(root);
      for (const ref of [
        "HEAD",
        "HEAD~1",
        "refs/heads/codex/change-005-fixture~1",
        git(root, "rev-parse", "HEAD").trim(),
        "refs/tags/release",
        "refs/remotes/origin/HEAD",
      ]) {
        expectSnapshotError(() => resolveBranchRef(owner, ref), "INVALID_REF");
      }
      for (const requested of ["../secret", "/etc/passwd", "C:/secret", "a/../../secret"]) {
        expect(() => normalizeRepositoryPath(requested)).toThrowError(
          expect.objectContaining({ code: "INVALID_PATH" })
        );
      }
      expect(normalizeRepositoryPath("./src\\index.ts")).toBe("src/index.ts");
    } finally {
      cleanup(root);
    }
  });

  it("requires continuation commits and detects a moved branch", () => {
    const { root } = createBranchFixture();
    try {
      const owner = resolveRepositoryOwner(root);
      expect(() => browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        offset: 1,
      })).toThrowError(expect.objectContaining({ code: "CONTINUATION_PRECONDITION_REQUIRED" }));
      expect(() => browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
        startLine: 2,
      })).toThrowError(expect.objectContaining({ code: "CONTINUATION_PRECONDITION_REQUIRED" }));

      const first = browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
        endLine: 1,
      });
      expect(first.kind).toBe("file");
      if (first.kind !== "file") throw new Error("Expected file response");

      git(root, "checkout", "codex/change-005-fixture");
      write(root, "branch-marker.txt", "moved branch marker\nsecond line\n");
      git(root, "add", "branch-marker.txt");
      git(root, "commit", "-m", "move branch ref");
      git(root, "checkout", "main");

      expect(() => browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
        startLine: 2,
        expectedCommit: first.commit,
      })).toThrowError(expect.objectContaining({ code: "REF_CHANGED" }));
      expect(() => compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
        offset: 1,
      })).toThrowError(expect.objectContaining({ code: "CONTINUATION_PRECONDITION_REQUIRED" }));
    } finally {
      cleanup(root);
    }
  });

  it("disables replacement objects and rejects partial repositories", () => {
    const { root } = createBranchFixture();
    try {
      const owner = resolveRepositoryOwner(root);
      git(root, "checkout", "-b", "replacement-source");
      write(root, "branch-marker.txt", "replacement content\n");
      git(root, "add", "branch-marker.txt");
      git(root, "commit", "-m", "replacement commit");
      const replacement = git(root, "rev-parse", "HEAD").trim();
      git(root, "checkout", "main");
      const original = git(root, "rev-parse", "refs/heads/codex/change-005-fixture").trim();
      git(root, "replace", original, replacement);

      const result = browseSnapshot(owner, {
        ref: "refs/heads/codex/change-005-fixture",
        path: "branch-marker.txt",
      });
      expect(result).toMatchObject({ kind: "file", content: "unchecked-out branch marker\nsecond line" });

      git(root, "config", "extensions.partialClone", "origin");
      expect(() => listBranches(owner)).toThrowError(
        expect.objectContaining({ code: "PROMISOR_REPOSITORY_UNSUPPORTED" })
      );
    } finally {
      cleanup(root);
    }
  });

  it("uses the authorized main ignore policy for branch snapshots", async () => {
    const root = makeTmpDir("git-snapshot-policy");
    makeGitRepo(root);
    write(root, ".c2cignore", "private.txt\n");
    git(root, "add", ".c2cignore");
    git(root, "commit", "-m", "configure snapshot policy");
    git(root, "checkout", "-b", "policy-branch");
    write(root, "private.txt", "custom secret\n");
    write(root, ".env", "dotenv secret\n");
    write(root, "public.txt", "public marker\n");
    git(root, "add", "-f", "private.txt", ".env", "public.txt");
    git(root, "commit", "-m", "add policy fixtures");
    git(root, "checkout", "main");
    try {
      const owner = resolveRepositoryOwner(root);
      const directory = browseSnapshot(owner, { ref: "refs/heads/policy-branch" });
      expect(directory.kind).toBe("directory");
      if (directory.kind !== "directory") throw new Error("Expected directory response");
      expect(directory.entries.map((entry) => entry.path)).toContain("public.txt");
      expect(directory.entries.map((entry) => entry.path)).not.toContain("private.txt");
      expect(directory.entries.map((entry) => entry.path)).not.toContain(".env");
      expect(() => browseSnapshot(owner, { ref: "refs/heads/policy-branch", path: ".env" })).toThrowError(
        expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" })
      );
      const search = await searchSnapshot(owner, { ref: "refs/heads/policy-branch", query: "secret" });
      expect(search.matches).toEqual([]);
      const comparison = compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/policy-branch",
      });
      expect(comparison.diff).toContain("public.txt");
      expect(comparison.diff).not.toContain("custom secret");
      expect(comparison.diff).not.toContain("dotenv secret");
    } finally {
      cleanup(root);
    }
  });

  it("filters sensitive rename pairs atomically during comparison", () => {
    const root = makeTmpDir("git-snapshot-rename-policy");
    makeGitRepo(root);
    write(root, ".env", "rename secret\n");
    git(root, "add", "-f", ".env");
    git(root, "commit", "-m", "add sensitive rename fixture");
    git(root, "checkout", "-b", "rename-secret");
    git(root, "mv", ".env", "public.txt");
    git(root, "commit", "-m", "rename sensitive fixture");
    git(root, "checkout", "main");
    try {
      const owner = resolveRepositoryOwner(root);
      const comparison = compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/rename-secret",
      });
      expect(comparison.diff).not.toContain("rename secret");
      expect(comparison.diff).not.toContain("public.txt");

      const scopedComparison = compareSnapshots(owner, {
        baseRef: "refs/heads/main",
        targetRef: "refs/heads/rename-secret",
        path: "public.txt",
      });
      expect(scopedComparison.diff).toBe("");
    } finally {
      cleanup(root);
    }
  });

  it("rejects effective promisor repositories before a missing-object read", () => {
    const root = makeTmpDir("git-snapshot-promisor");
    makeGitRepo(root);
    git(root, "checkout", "-b", "partial-promisor");
    write(root, "missing.txt", "missing promisor content\n");
    git(root, "add", "missing.txt");
    git(root, "commit", "-m", "add promisor fixture");
    const missingBlob = git(root, "rev-parse", "refs/heads/partial-promisor:missing.txt").trim();
    git(root, "checkout", "main");

    const objectStore = path.resolve(root, git(root, "rev-parse", "--git-path", "objects").trim());
    const missingObject = path.join(objectStore, missingBlob.slice(0, 2), missingBlob.slice(2));
    expect(fs.existsSync(missingObject)).toBe(true);
    fs.rmSync(missingObject);

    const helperBin = path.join(root, "promisor-helper-bin");
    const helper = write(
      helperBin,
      "git-remote-c2c-promisor",
      "#!/bin/sh\nprintf 'invoked\\n' > \"$C2C_PROMISOR_SENTINEL\"\nexit 97\n"
    );
    fs.chmodSync(helper, 0o755);
    const marker = path.join(root, "promisor-transport-invoked");
    const globalConfig = write(
      root,
      "effective-global.gitconfig",
      [
        '[remote "origin"]',
        "\tpromisor = true",
        "\turl = c2c-promisor::missing-object",
        "",
      ].join("\n")
    );
    const environmentNames = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "PATH", "C2C_PROMISOR_SENTINEL"] as const;
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));

    try {
      const owner = resolveRepositoryOwner(root);
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";
      process.env.C2C_PROMISOR_SENTINEL = marker;
      process.env.PATH = `${path.dirname(helper)}${path.delimiter}${process.env.PATH ?? ""}`;

      expect(() => listBranches(owner)).toThrowError(
        expect.objectContaining({ code: "PROMISOR_REPOSITORY_UNSUPPORTED" })
      );

      write(
        root,
        "effective-global.gitconfig",
        [
          "[extensions]",
          "\tpartialClone = origin",
          "",
          '[remote "origin"]',
          "\tpromisor = true",
          "\turl = c2c-promisor::missing-object",
          "",
        ].join("\n")
      );
      const objectStoreBefore = snapshotObjectStore(root);

      expect(() => browseSnapshot(owner, {
        ref: "refs/heads/partial-promisor",
        path: "missing.txt",
      })).toThrowError(expect.objectContaining({ code: "PROMISOR_REPOSITORY_UNSUPPORTED" }));

      expect(fs.existsSync(marker)).toBe(false);
      expect(snapshotObjectStore(root)).toBe(objectStoreBefore);
    } finally {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      cleanup(root);
    }
  });

  it("treats symlinks and gitlinks as metadata and rejects binary blobs", () => {
    const root = makeTmpDir("git-snapshot-objects");
    const submodule = makeTmpDir("git-snapshot-gitlink");
    makeGitRepo(root);
    makeGitRepo(submodule);
    git(root, "checkout", "-b", "object-types");
    write(root, "target.txt", "symlink target\n");
    fs.symlinkSync("target.txt", path.join(root, "link.txt"));
    fs.writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    git(root, "add", "target.txt", "link.txt", "binary.dat");
    const submoduleCommit = git(submodule, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${submoduleCommit},vendor/sub`);
    git(root, "commit", "-m", "add snapshot object types");
    git(root, "checkout", "main");
    try {
      const owner = resolveRepositoryOwner(root);
      expect(browseSnapshot(owner, { ref: "refs/heads/object-types", path: "link.txt" })).toMatchObject({
        kind: "symlink",
        target: "target.txt",
      });
      expect(browseSnapshot(owner, { ref: "refs/heads/object-types", path: "vendor/sub" })).toMatchObject({
        kind: "gitlink",
        oid: submoduleCommit,
      });
      expect(() => browseSnapshot(owner, { ref: "refs/heads/object-types", path: "binary.dat" })).toThrowError(
        expect.objectContaining({ code: "BINARY_FILE" })
      );
    } finally {
      cleanup(root);
      cleanup(submodule);
    }
  });

  it("keeps pathspec-looking filenames literal and reports match-limit truncation", async () => {
    const root = makeTmpDir("git-snapshot-pathspec");
    makeGitRepo(root);
    git(root, "checkout", "-b", "literal-paths");
    write(root, "literal[1].txt", "literal path marker\n");
    write(root, "many.txt", "match one\nmatch two\nmatch three\n");
    git(root, "add", "--", ":(literal)literal[1].txt", "many.txt");
    git(root, "commit", "-m", "add literal and search fixtures");
    git(root, "checkout", "main");
    const names = [
      "GIT_LITERAL_PATHSPECS",
      "GIT_GLOB_PATHSPECS",
      "GIT_NOGLOB_PATHSPECS",
      "GIT_ICASE_PATHSPECS",
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = "1";
      const owner = resolveRepositoryOwner(root);
      expect(browseSnapshot(owner, { ref: "refs/heads/literal-paths", path: "literal[1].txt" })).toMatchObject({
        kind: "file",
        content: "literal path marker",
      });
      const search = await searchSnapshot(owner, {
        ref: "refs/heads/literal-paths",
        query: "match",
        path: "many.txt",
        limit: 1,
      });
      expect(search).toMatchObject({ truncated: true, truncationReason: "match_limit", matchCount: 1 });
      const globSearch = await searchSnapshot(owner, {
        ref: "refs/heads/literal-paths",
        query: "literal path marker",
        glob: "**/*.txt",
      });
      expect(globSearch.matches).toEqual([
        { path: "literal[1].txt", line: 1, text: "literal path marker" },
      ]);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      cleanup(root);
    }
  });

  it("fails an individually oversized line without returning partial content", () => {
    const root = makeTmpDir("git-snapshot-limits");
    makeGitRepo(root);
    git(root, "checkout", "-b", "large-line");
    write(root, "large.txt", "x".repeat(256 * 1024 + 1));
    git(root, "add", "large.txt");
    git(root, "commit", "-m", "add oversized line");
    git(root, "checkout", "main");
    try {
      const owner = resolveRepositoryOwner(root);
      expect(() => browseSnapshot(owner, {
        ref: "refs/heads/large-line",
        path: "large.txt",
      })).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
    } finally {
      cleanup(root);
    }
  });
});
