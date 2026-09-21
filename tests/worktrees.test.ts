import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../src/workspace/git.js";
import { assertDerivedWorktreeCurrent, WorktreeError, discoverDerivedWorktrees, parseWorktreePorcelainZ, resolveDerivedWorktree, resolveLocalWorktree, worktreeIdFor, type WorktreeRunner } from "../src/workspace/worktrees.js";
import { git, makeGitRepo, makeTmpDir, cleanup } from "./helpers.js";

function result(stdout = ""): { ok: true; stdout: string; stderr: string; code: number } {
  return { ok: true, stdout, stderr: "", code: 0 };
}

describe("worktree domain", () => {
  it("parses branch, detached, locked and prunable records without paths in public metadata", () => {
    const records = parseWorktreePorcelainZ(
      [
        "worktree /repo/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repo/feature",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feature/example",
        "locked by test",
        "",
        "worktree /repo/detached",
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
        "worktree /repo/prunable",
        "HEAD 4444444444444444444444444444444444444444",
        "branch refs/heads/old",
        "prunable /gone",
      ].join("\0")
    );

    expect(records).toEqual([
      {
        root: "/repo/main",
        commit: "1111111111111111111111111111111111111111",
        branch: "main",
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        root: "/repo/feature",
        commit: "2222222222222222222222222222222222222222",
        branch: "feature/example",
        bare: false,
        locked: true,
        prunable: false,
      },
      {
        root: "/repo/detached",
        commit: "3333333333333333333333333333333333333333",
        branch: null,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        root: "/repo/prunable",
        commit: "4444444444444444444444444444444444444444",
        branch: "old",
        bare: false,
        locked: false,
        prunable: true,
      },
    ]);
  });

  it("keeps embedded newlines inside NUL-delimited worktree fields", () => {
    const records = parseWorktreePorcelainZ(
      [
        "worktree /repo/feature\nwith-newline",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/feature",
        "",
      ].join("\0")
    );
    expect(records[0].root).toBe("/repo/feature\nwith-newline");
  });

  it("parses line-delimited porcelain from Git versions without worktree -z support", () => {
    const records = parseWorktreePorcelainZ(
      [
        "worktree /repo/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repo/feature",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feature/example",
        "",
      ].join("\n")
    );

    expect(records).toMatchObject([
      { root: "/repo/main", branch: "main", commit: "1111111111111111111111111111111111111111" },
      { root: "/repo/feature", branch: "feature/example", commit: "2222222222222222222222222222222222222222" },
    ]);
  });

  it("derives deterministic opaque ids and validates eligible linked roots", () => {
    const main = makeTmpDir("worktree-main");
    const linked = makeTmpDir("worktree-linked");
    const detached = makeTmpDir("worktree-detached");
    const locked = makeTmpDir("worktree-locked");
    const missing = path.join(makeTmpDir("worktree-missing"), "removed");
    const subdirectory = path.join(main, "packages", "app");
    fs.mkdirSync(subdirectory, { recursive: true });
    makeGitRepo(main);
    fs.mkdirSync(path.join(main, ".git", "objects"), { recursive: true });
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${linked}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/example",
      "",
      `worktree ${detached}`,
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
      `worktree ${locked}`,
      "HEAD 4444444444444444444444444444444444444444",
      "branch refs/heads/locked",
      "locked",
      "",
      `worktree ${missing}`,
      "HEAD 5555555555555555555555555555555555555555",
      "branch refs/heads/missing",
      "prunable /missing",
    ].join("\0");
    const roots = new Set([main, linked, detached, locked]);
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") {
        return roots.has(root) ? result(`${root}\n`) : { ok: false, stdout: "", stderr: "", code: 1 };
      }
      if (args.join(" ") === "rev-parse --git-common-dir") return result(`${repositoryIdentity}\n`);
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };

    try {
      const derived = discoverDerivedWorktrees(main, runner);
      expect(derived.map(({ root }) => root)).toEqual([linked, detached, locked]);
      expect(derived[0]).toMatchObject({ branch: "feature/example", commit: "2222222222222222222222222222222222222222" });
      expect(derived[1].branch).toBeNull();
      expect(derived[0].worktreeId).toMatch(/^wt-[0-9a-f]{16}$/);
      expect(worktreeIdFor(repositoryIdentity, linked)).toBe(derived[0].worktreeId);
      expect(worktreeIdFor(repositoryIdentity, linked)).toBe(worktreeIdFor(repositoryIdentity, linked));
      expect(discoverDerivedWorktrees(linked, runner)).toEqual([]);
      expect(discoverDerivedWorktrees(subdirectory, runner)).toEqual([]);
      expect(resolveLocalWorktree(main, runner)?.kind).toBe("main");
      expect(resolveLocalWorktree(linked, runner)).toMatchObject({ kind: "linked", worktreeId: derived[0].worktreeId });
      expect(resolveDerivedWorktree(main, derived[1].worktreeId, runner).root).toBe(detached);
      expect(() => resolveDerivedWorktree(main, "wt-invented", runner)).toThrowError(
        expect.objectContaining({ code: "UNKNOWN_WORKTREE" })
      );
    } finally {
      cleanup(main);
      cleanup(linked);
      cleanup(detached);
      cleanup(locked);
      cleanup(path.dirname(missing));
    }
  });

  it("excludes linked roots with a different repository identity", () => {
    const main = makeTmpDir("worktree-identity-main");
    const foreign = makeTmpDir("worktree-identity-foreign");
    makeGitRepo(main);
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const foreignIdentity = path.join(foreign, ".git");
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${foreign}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/foreign",
      "",
    ].join("\0");
    const runner: WorktreeRunner = (root, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") return result("true\n");
      if (command === "worktree list --porcelain -z") return result(output);
      if (command === "rev-parse --show-toplevel") return result(`${root}\n`);
      if (command === "rev-parse --git-common-dir") {
        return result(`${root === main ? repositoryIdentity : foreignIdentity}\n`);
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };

    try {
      expect(discoverDerivedWorktrees(main, runner)).toEqual([]);
    } finally {
      cleanup(main);
      cleanup(foreign);
    }
  });

  it("fails closed when the machine-readable Git contract is unavailable", () => {
    const root = makeTmpDir("worktree-unsupported");
    const runner: WorktreeRunner = (cwd, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      return { ok: false, stdout: "", stderr: "unknown switch `z'", code: 129 };
    };
    try {
      expect(() => discoverDerivedWorktrees(root, runner)).toThrowError(
        new WorktreeError("WORKTREE_DISCOVERY_FAILED", "Git worktree discovery is unavailable.")
      );
    } finally {
      cleanup(root);
    }
  });

  it("resolves a selected id without validating unrelated sibling roots", () => {
    const main = makeTmpDir("worktree-selected-main");
    const selected = makeTmpDir("worktree-selected-target");
    const sibling = makeTmpDir("worktree-selected-sibling");
    makeGitRepo(main);
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${selected}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/selected",
      "",
      `worktree ${sibling}`,
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/sibling",
    ].join("\0");
    const showToplevelRoots: string[] = [];
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") {
        showToplevelRoots.push(root);
        return result(`${root}\n`);
      }
      if (args.join(" ") === "rev-parse --git-common-dir") return result(`${repositoryIdentity}\n`);
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };

    try {
      const worktreeId = worktreeIdFor(repositoryIdentity, selected);
      expect(resolveDerivedWorktree(main, worktreeId, runner).root).toBe(selected);
      expect(showToplevelRoots).toContain(main);
      expect(showToplevelRoots).toContain(selected);
      expect(showToplevelRoots).not.toContain(sibling);
    } finally {
      cleanup(main);
      cleanup(selected);
      cleanup(sibling);
    }
  });

  it("fails closed when a selected worktree changes repository identity before use", () => {
    const main = makeTmpDir("worktree-race-main");
    const selected = makeTmpDir("worktree-race-selected");
    const replacementIdentity = makeTmpDir("worktree-race-replacement");
    makeGitRepo(main);
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    let selectedIdentity = repositoryIdentity;
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${selected}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/selected",
    ].join("\0");
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
      if (args.join(" ") === "rev-parse --git-common-dir") {
        return result(`${root === main ? repositoryIdentity : selectedIdentity}\n`);
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };

    try {
      const worktreeId = worktreeIdFor(repositoryIdentity, selected);
      const candidate = resolveDerivedWorktree(main, worktreeId, runner);
      selectedIdentity = replacementIdentity;
      expect(() => assertDerivedWorktreeCurrent(main, candidate, runner)).toThrowError(
        expect.objectContaining({ code: "UNKNOWN_WORKTREE" })
      );
    } finally {
      cleanup(main);
      cleanup(selected);
      cleanup(replacementIdentity);
    }
  });

  it("fails closed when a selected worktree root disappears", () => {
    const main = makeTmpDir("worktree-stale-main");
    const selected = makeTmpDir("worktree-stale-selected");
    makeGitRepo(main);
    const repositoryIdentity = fs.realpathSync.native(path.join(main, ".git"));
    const output = [
      `worktree ${main}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${selected}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/selected",
    ].join("\0");
    const runner: WorktreeRunner = (root, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
      if (args.join(" ") === "worktree list --porcelain -z") return result(output);
      if (args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
      if (args.join(" ") === "rev-parse --git-common-dir") return result(`${repositoryIdentity}\n`);
      return { ok: false, stdout: "", stderr: "", code: 1 };
    };

    try {
      const worktreeId = worktreeIdFor(repositoryIdentity, selected);
      fs.rmSync(selected, { recursive: true, force: true });
      expect(() => resolveDerivedWorktree(main, worktreeId, runner)).toThrowError(
        expect.objectContaining({ code: "UNKNOWN_WORKTREE" })
      );
    } finally {
      cleanup(main);
      cleanup(selected);
    }
  });

  it("uses live Git worktree enumeration with a porcelain fallback when -z is unsupported", () => {
    const base = makeTmpDir("worktree-live");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    fs.mkdirSync(main, { recursive: true });
    makeGitRepo(main);
    let linkedAdded = false;

    try {
      const probe = runGit(main, ["worktree", "list", "--porcelain", "-z"]);
      if (!probe.ok) {
        expect(probe.stderr).toMatch(/unknown (switch|option).*z/i);
      }

      git(main, "worktree", "add", "-b", "live-selection", linked);
      linkedAdded = true;
      const derived = discoverDerivedWorktrees(main);
      expect(derived).toHaveLength(1);
      expect(derived[0].root).toBe(fs.realpathSync.native(linked));
      expect(resolveDerivedWorktree(main, derived[0].worktreeId).root).toBe(derived[0].root);
    } finally {
      if (linkedAdded) {
        const removed = runGit(main, ["worktree", "remove", "--force", linked]);
        if (!removed.ok) throw new Error(`git worktree remove failed: ${removed.stderr}`);
      }
      cleanup(base);
    }
  });
});
