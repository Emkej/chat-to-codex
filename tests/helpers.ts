import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll } from "vitest";

const temporaryDirs = new Set<string>();
let originalStateDir: string | undefined;
let capturedStateDir = false;

/** Create an isolated fixture in the OS temp directory. */
export function makeTmpDir(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${safeName}-`));
  temporaryDirs.add(dir);
  return dir;
}

export function cleanup(dir: string): void {
  const resolved = path.resolve(dir);
  if (!temporaryDirs.has(resolved)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
  temporaryDirs.delete(resolved);
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export interface GitCommandTrace {
  read(): string[][];
  clear(): void;
  restore(): void;
}

export function captureGitCommandTrace(root: string): GitCommandTrace {
  const resolvedGit = spawnSync("which", ["git"], { encoding: "utf8" });
  const realGit = resolvedGit.status === 0 ? resolvedGit.stdout?.trim() : "";
  if (!realGit) throw new Error("Could not resolve the Git executable for command tracing.");

  const bin = path.join(root, "git-trace-bin");
  const tracePath = path.join(root, "git-command-trace.jsonl");
  const wrapper = path.join(bin, "git");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(tracePath, "");
  fs.writeFileSync(wrapper, [
    "#!" + process.execPath,
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--numstat') || args.some((arg) => arg.startsWith('--max-count='))) {",
    "  fs.appendFileSync(" + JSON.stringify(tracePath) + ", JSON.stringify(args) + '\\n');",
    "}",
    "const result = spawnSync(" + JSON.stringify(realGit) + ", args, { stdio: 'inherit' });",
    "if (result.error) { process.stderr.write(result.error.message + '\\n'); process.exit(1); }",
    "process.exit(result.status === null ? 1 : result.status);",
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = [bin, originalPath].filter(Boolean).join(path.delimiter);
  return {
    read() {
      return fs.readFileSync(tracePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    clear() {
      fs.writeFileSync(tracePath, "");
    },
    restore() {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    },
  };
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Chat to Codex!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point profile-backed calls at a per-suite temporary location. */
export function isolateStateDir(): string {
  if (!capturedStateDir) {
    originalStateDir = process.env.C2C_STATE_DIR;
    capturedStateDir = true;
  }
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

afterAll(() => {
  if (capturedStateDir) {
    if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDir;
  }

  const errors: unknown[] = [];
  for (const dir of [...temporaryDirs]) {
    try {
      cleanup(dir);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to remove temporary C2C test state");
  }
});
