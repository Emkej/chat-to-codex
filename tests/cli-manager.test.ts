import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-manager-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(args: string[], outputPath: string): Promise<{ code: number | null; output: string }> {
  const entry = path.join(projectRoot, "src", "cli", "index.ts");
  const outputFd = fs.openSync(outputPath, "w");
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", entry, ...args],
    {
      cwd: projectRoot,
      env: { ...process.env, C2C_STATE_DIR: path.join(path.dirname(outputPath), "state") },
      stdio: ["ignore", outputFd, outputFd],
    }
  );
  fs.closeSync(outputFd);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("c2c manager non-TTY guard timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output: fs.readFileSync(outputPath, "utf8") });
    });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("c2c manager CLI entry", () => {
  it("refuses non-TTY use with a clear message", async () => {
    const directory = temporaryDirectory();
    const result = await runCli(["manager"], path.join(directory, "stderr.txt"));
    expect(result.code).toBe(1);
    expect(result.output).toContain("c2c manager requires an interactive terminal (TTY).");
    expect(result.output).not.toContain("\x1b[?1049h");
    const command = fs.readFileSync(path.join(projectRoot, "src", "cli", "manager-command.ts"), "utf8");
    expect(command).toContain("c2c manager requires an interactive terminal (TTY).");
  });

  it("lists Manager in the existing root help output", async () => {
    const directory = temporaryDirectory();
    const result = await runCli(["--help"], path.join(directory, "help.txt"));
    expect(result.code).toBe(0);
    expect(result.output).toContain("manager");
  });

  it("keeps unrelated version output working", async () => {
    const directory = temporaryDirectory();
    const result = await runCli(["--version"], path.join(directory, "version.txt"));
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe("0.2.0");
  });

  it("keeps Ink and React out of the eager CLI import graph", () => {
    const cli = fs.readFileSync(path.join(projectRoot, "src", "cli", "index.ts"), "utf8");
    const command = fs.readFileSync(path.join(projectRoot, "src", "cli", "manager-command.ts"), "utf8");
    expect(cli).not.toMatch(/from\s+["'](?:ink|react)(?:\/[^"']*)?["']/);
    expect(command).not.toMatch(/from\s+["'](?:ink|react|\.\.\/manager)(?:\/[^"']*)?["']/);
    expect(command).toMatch(
      /if \(!process\.stdin\.isTTY \|\| !process\.stdout\.isTTY\)[\s\S]*?await import\("\.\.\/manager\/index\.js"\)/
    );
  });
});
