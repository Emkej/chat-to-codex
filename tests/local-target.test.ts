import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalTarget, type LocalTargetRegistration } from "../src/workspace/local-target.js";
import type { WorktreeRunner } from "../src/workspace/worktrees.js";
import { cleanup, makeTmpDir } from "./helpers.js";

function ok(stdout = ""): { ok: true; stdout: string; stderr: string; code: number } {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function makeRunner(main: string, linked: string): WorktreeRunner {
  const repositoryIdentity = path.join(main, ".git");
  const output = [
    `worktree ${main}`,
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    `worktree ${linked}`,
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature/example",
    "",
  ].join("\0");
  return (root, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (command === "worktree list --porcelain -z") return ok(output);
    if (command === "rev-parse --show-toplevel") return ok(`${root}\n`);
    if (command === "rev-parse --git-common-dir") return ok(`${repositoryIdentity}\n`);
    return { ok: false, stdout: "", stderr: "", code: 1 };
  };
}

describe("local target resolver", () => {
  it("prefers an exact registration without consulting Git", () => {
    const root = makeTmpDir("local-target-exact");
    const registration: LocalTargetRegistration = {
      id: "main-id",
      displayName: "Main",
      canonicalRoot: root,
    };
    try {
      const target = resolveLocalTarget(root, [registration], () => {
        throw new Error("Git should not be consulted for an exact registration");
      });
      expect(target).toEqual({ kind: "exact", root, mainRoot: root, registration, worktreeId: null });
    } finally {
      cleanup(root);
    }
  });

  it("resolves a linked root to its registered parent without mutation", () => {
    const main = makeTmpDir("local-target-main");
    const linked = makeTmpDir("local-target-linked");
    fs.mkdirSync(path.join(main, ".git"));
    const registration: LocalTargetRegistration = {
      id: "main-id",
      displayName: "Main",
      canonicalRoot: main,
    };
    try {
      const target = resolveLocalTarget(linked, [registration], makeRunner(main, linked));
      expect(target.kind).toBe("derived");
      expect(target.registration).toEqual(registration);
      expect(target.mainRoot).toBe(main);
      expect(target.worktreeId).toMatch(/^wt-[0-9a-f]{16}$/);
    } finally {
      cleanup(main);
      cleanup(linked);
    }
  });

  it("leaves an uncovered linked root unregistered", () => {
    const main = makeTmpDir("local-target-uncovered-main");
    const linked = makeTmpDir("local-target-uncovered-linked");
    fs.mkdirSync(path.join(main, ".git"));
    try {
      expect(resolveLocalTarget(linked, [], makeRunner(main, linked))).toMatchObject({
        kind: "unregistered",
        root: linked,
        mainRoot: main,
        registration: null,
        worktreeId: null,
      });
    } finally {
      cleanup(main);
      cleanup(linked);
    }
  });

  it("treats unavailable worktree discovery as an unregistered root", () => {
    const root = makeTmpDir("local-target-unavailable");
    try {
      expect(
        resolveLocalTarget(root, [], (_cwd, args) => {
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return ok("true\n");
          return { ok: false, stdout: "", stderr: "unsupported", code: 129 };
        })
      ).toMatchObject({ kind: "unregistered", root, registration: null, worktreeId: null });
    } finally {
      cleanup(root);
    }
  });
});
