import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

describe("temporary test state", () => {
  it("uses unique OS temp directories and removes them on cleanup", () => {
    const first = makeTmpDir("scratch-one");
    const second = makeTmpDir("scratch-two");
    dirs.push(first, second);

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.resolve(os.tmpdir()));
    expect(path.dirname(second)).toBe(path.resolve(os.tmpdir()));

    cleanup(first);
    expect(fs.existsSync(first)).toBe(false);
  });

  it("fails closed when the OS temp location cannot create a directory", () => {
    const blockerRoot = makeTmpDir("temp-location-blocker");
    dirs.push(blockerRoot);
    const invalidTemp = write(blockerRoot, "not-a-directory", "file");
    const repoScratch = path.join(projectRoot, ".tooling", "test-tmp");
    const repoScratchExisted = fs.existsSync(repoScratch);
    const names = ["TMPDIR", "TMP", "TEMP"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));

    try {
      for (const name of names) process.env[name] = invalidTemp;
      expect(() => makeTmpDir("must-fail")).toThrow();
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(fs.existsSync(repoScratch)).toBe(repoScratchExisted);
  });
});
