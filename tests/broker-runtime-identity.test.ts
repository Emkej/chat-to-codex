import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBrokerRuntimeIdentity,
  persistInstalledRevision,
  resolveC2cRevision,
} from "../src/broker/runtime-identity.js";
import { VERSION } from "../src/version.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

describe("broker runtime identity", () => {
  it("uses the app root and ignores inherited Git repository overrides", () => {
    const c2cRoot = makeTmpDir("runtime-identity-c2c");
    const foreignRoot = makeTmpDir("runtime-identity-foreign");
    dirs.push(c2cRoot, foreignRoot);
    makeGitRepo(c2cRoot);
    makeGitRepo(foreignRoot);
    write(c2cRoot, "revision-marker.txt", "C2C app root\n");
    git(c2cRoot, "add", ".");
    git(c2cRoot, "commit", "-m", "C2C revision");
    const expected = git(c2cRoot, "rev-parse", "--short", "HEAD").trim();

    const overrides: Record<string, string> = {
      GIT_DIR: path.join(foreignRoot, ".git"),
      GIT_WORK_TREE: foreignRoot,
      GIT_COMMON_DIR: path.join(foreignRoot, ".git"),
      GIT_INDEX_FILE: path.join(foreignRoot, ".git", "index"),
      GIT_OBJECT_DIRECTORY: path.join(foreignRoot, ".git", "objects"),
      GIT_OBJECT_DIRECTORY_RELATIVE: "1",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignRoot, ".git", "objects"),
      GIT_QUARANTINE_PATH: path.join(foreignRoot, ".git", "objects"),
    };
    const original = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
      expect(resolveC2cRevision(c2cRoot)).toBe(expected);
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("accepts a linked worktree as the C2C application root", () => {
    const base = makeTmpDir("runtime-identity-worktree");
    dirs.push(base);
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    fs.mkdirSync(main);
    makeGitRepo(main);
    git(main, "worktree", "add", "-b", "runtime-identity-linked", linked);
    write(linked, "linked-revision.txt", "linked C2C checkout\n");
    git(linked, "add", ".");
    git(linked, "commit", "-m", "linked C2C revision");

    expect(resolveC2cRevision(linked)).toBe(git(linked, "rev-parse", "--short", "HEAD").trim());
  });

  it("rejects an unrelated enclosing repository even when installed metadata exists", () => {
    const parent = makeTmpDir("runtime-identity-enclosing-repo");
    dirs.push(parent);
    makeGitRepo(parent);
    const appRoot = path.join(parent, "copied-app");
    fs.mkdirSync(appRoot);
    persistInstalledRevision(appRoot, "fedcba9");

    expect(resolveC2cRevision(appRoot)).toBeNull();
  });

  it("recovers only valid installed metadata and captures an immutable version/profile", () => {
    const appRoot = makeTmpDir("runtime-identity-installed");
    dirs.push(appRoot);
    expect(resolveC2cRevision(appRoot)).toBeNull();

    persistInstalledRevision(appRoot, "abc1234");
    expect(resolveC2cRevision(appRoot)).toBe("abc1234");
    fs.writeFileSync(path.join(appRoot, ".c2c-revision"), "not-a-revision\n");
    expect(resolveC2cRevision(appRoot)).toBeNull();
    persistInstalledRevision(appRoot, "abc1234");

    const originalProfile = process.env.C2C_PROFILE;
    try {
      process.env.C2C_PROFILE = " test ";
      const identity = captureBrokerRuntimeIdentity(appRoot);
      expect(identity).toEqual({ version: VERSION, revision: "abc1234", profile: "test" });
      expect(Object.isFrozen(identity)).toBe(true);

      process.env.C2C_PROFILE = "changed";
      persistInstalledRevision(appRoot, "fedcba9");
      expect(identity).toEqual({ version: VERSION, revision: "abc1234", profile: "test" });
    } finally {
      if (originalProfile === undefined) delete process.env.C2C_PROFILE;
      else process.env.C2C_PROFILE = originalProfile;
    }

    persistInstalledRevision(appRoot, null);
    expect(resolveC2cRevision(appRoot)).toBeNull();
  });

  it("reports a null profile when no named profile is active", () => {
    const appRoot = makeTmpDir("runtime-identity-default-profile");
    dirs.push(appRoot);
    persistInstalledRevision(appRoot, "abc1234");
    const originalProfile = process.env.C2C_PROFILE;
    try {
      delete process.env.C2C_PROFILE;
      expect(captureBrokerRuntimeIdentity(appRoot).profile).toBeNull();
    } finally {
      if (originalProfile === undefined) delete process.env.C2C_PROFILE;
      else process.env.C2C_PROFILE = originalProfile;
    }
  });
});
