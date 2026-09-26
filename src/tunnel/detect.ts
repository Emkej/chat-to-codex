import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { throwIfAborted } from "../process/abort.js";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
];

/** Locate a binary on PATH or in common install locations. */
export function findBinary(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  try {
    const probe = spawnSync(exe, ["--version"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0 || probe.status === 1) return exe;
  } catch {
    // not on PATH
  }
  for (const dir of COMMON_DIRS) {
    const full = path.join(dir, exe);
    try {
      if (fs.existsSync(full)) {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/** Locate a binary without blocking the event loop; Manager callers can cancel the probe. */
export async function findBinaryAsync(
  name: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string | null> {
  throwIfAborted(opts.signal);
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (await probeBinary(exe, opts.timeoutMs ?? 5_000, opts.signal)) return exe;
  for (const dir of COMMON_DIRS) {
    throwIfAborted(opts.signal);
    const full = path.join(dir, exe);
    if (await executableAt(full, opts.signal)) return full;
  }
  return null;
}

function executableAt(full: string, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (isExecutable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(isExecutable);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => finish(false), 250);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void fs.promises.access(full, fs.constants.X_OK).then(
      () => finish(true),
      () => finish(false)
    );
  });
}

function probeBinary(exe: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["--version"], { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (found: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 || code === 1));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
