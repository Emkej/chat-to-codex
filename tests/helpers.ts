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
