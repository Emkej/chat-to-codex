import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const c2ctPath = path.join(projectRoot, "bin", "c2ct.js");
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0).reverse()) cleanup(dir);
});

function scratch(name: string): string {
  const dir = makeTmpDir(name);
  scratchDirs.push(dir);
  return dir;
}

function runC2ct(args: string[], env: NodeJS.ProcessEnv, cwd = projectRoot) {
  return spawnSync(process.execPath, [c2ctPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

describe("c2ct test profile", () => {
  it("resolves the canonical test-profile state under C2C_HOME", () => {
    const home = scratch("c2ct-home");
    const previous = {
      home: process.env.C2C_HOME,
      profile: process.env.C2C_PROFILE,
      stateDir: process.env.C2C_STATE_DIR,
    };
    process.env.C2C_HOME = home;
    process.env.C2C_PROFILE = "test";
    delete process.env.C2C_STATE_DIR;
    try {
      expect(getStateDir()).toBe(path.join(home, "profiles", "test"));
    } finally {
      if (previous.home === undefined) delete process.env.C2C_HOME;
      else process.env.C2C_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.C2C_PROFILE;
      else process.env.C2C_PROFILE = previous.profile;
      if (previous.stateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previous.stateDir;
    }
  });

  it("selects test state despite inherited overrides, preserves default state, and avoids repo-local work", () => {
    const home = scratch("c2ct-isolation-home");
    const c2cHome = path.join(home, ".c2c");
    const override = scratch("c2ct-isolation-override");
    const codexHome = scratch("c2ct-isolation-codex-home");
    const defaultFile = write(c2cHome, "state/live-sentinel.txt", "default profile");
    const overrideFile = write(override, "live-sentinel.txt", "state override");
    const originalDefault = fs.readFileSync(defaultFile, "utf8");
    const originalOverride = fs.readFileSync(overrideFile, "utf8");
    const workPath = path.join(projectRoot, "work");
    const workBefore = fs.existsSync(workPath) ? fs.readdirSync(workPath).sort() : null;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      C2C_PROFILE: "live",
      C2C_STATE_DIR: override,
    };
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === "C2C_HOME") delete env[name];
    }

    const result = runC2ct(["sandbox-allow", "--json"], env);

    expect(result.status).toBe(0);
    const testStateDir = path.join(c2cHome, "profiles", "test");
    expect(fs.existsSync(testStateDir)).toBe(true);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(testStateDir);
    expect(fs.readFileSync(defaultFile, "utf8")).toBe(originalDefault);
    expect(fs.readFileSync(overrideFile, "utf8")).toBe(originalOverride);
    expect(fs.existsSync(workPath) ? fs.readdirSync(workPath).sort() : null).toEqual(workBefore);
  });

  it("rejects caller-supplied profile overrides in either syntax", () => {
    const home = scratch("c2ct-override-home");
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: scratch("c2ct-override-codex-home"),
      C2C_HOME: home,
    };
    for (const args of [
      ["--profile", "live", "broker", "tunnel", "status", "--json"],
      ["--profile=live", "broker", "tunnel", "status", "--json"],
    ]) {
      expect(runC2ct(args, env).status).toBe(2);
    }
  });

  it("fails closed when test-profile state cannot be initialized", () => {
    const home = scratch("c2ct-failure-home");
    const codexHome = scratch("c2ct-failure-codex-home");
    write(home, "profiles", "blocking file");
    const defaultLogBlocker = write(home, "state/logs", "blocking file");
    const stateOverride = path.join(home, "state");

    const result = runC2ct(["broker", "start", "--no-tunnel", "--json"], {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      C2C_HOME: home,
      C2C_PROFILE: "live",
      C2C_STATE_DIR: stateOverride,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, "state", "installation.json"))).toBe(false);
    expect(fs.readFileSync(defaultLogBlocker, "utf8")).toBe("blocking file");
  });
});
