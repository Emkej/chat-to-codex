import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WriteRequestError } from "./types.js";

export interface WriteOwnerLease {
  stateDir: string;
  release(): Promise<void>;
}

function ownerError(code: "WRITE_OWNER_ALREADY_HELD" | "WRITE_OWNER_UNAVAILABLE", message: string, cause?: unknown): WriteRequestError {
  return new WriteRequestError(code, message, cause instanceof Error ? { cause } : undefined);
}

function canonicalStateDir(input: string): string {
  const resolved = path.resolve(input);
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return fs.realpathSync.native(resolved);
  } catch (error) {
    throw ownerError("WRITE_OWNER_UNAVAILABLE", "Cannot resolve the broker state directory.", error);
  }
}

function lockFileDescriptor(stateDir: string): number {
  const file = path.join(stateDir, ".write-requests-owner.lock");
  const constants = fs.constants as typeof fs.constants & { O_NOFOLLOW?: number };
  const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
  try {
    const descriptor = fs.openSync(file, flags, 0o600);
    if (!fs.fstatSync(descriptor).isFile()) {
      fs.closeSync(descriptor);
      throw new Error("Owner-lock path is not a regular file.");
    }
    fs.fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    throw ownerError("WRITE_OWNER_UNAVAILABLE", "Cannot open the broker write-owner lock.", error);
  }
}

function linuxLockUtility(): string {
  for (const candidate of ["/usr/bin/flock", "/bin/flock"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed system location; do not resolve through caller PATH.
    }
  }
  throw ownerError("WRITE_OWNER_UNAVAILABLE", "The operating-system file-lock utility is unavailable.");
}

function acquireLinux(stateDir: string): WriteOwnerLease {
  const utility = linuxLockUtility();
  const descriptor = lockFileDescriptor(stateDir);
  const result = spawnSync(utility, ["-n", "3"], {
    stdio: ["ignore", "ignore", "ignore", descriptor],
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    fs.closeSync(descriptor);
    if (!result.error && result.status === 1) {
      throw ownerError("WRITE_OWNER_ALREADY_HELD", "Another broker owns this state directory for writes.");
    }
    throw ownerError("WRITE_OWNER_UNAVAILABLE", "Could not acquire the broker write-owner lock.", result.error);
  }

  let released = false;
  return {
    stateDir,
    async release() {
      if (released) return;
      released = true;
      fs.closeSync(descriptor);
    },
  };
}

/**
 * Hold an OS resource for the broker lifetime, keyed by the canonical state
 * directory. Linux/WSL V1 uses flock on an inherited descriptor. The lock is
 * released by the OS when the owning process exits; the lock file is only a key.
 */
export async function acquireWriteOwner(stateDirInput: string): Promise<WriteOwnerLease> {
  if (process.platform !== "linux") {
    throw ownerError("WRITE_OWNER_UNAVAILABLE", "Exclusive broker write ownership is supported only on Linux/WSL.");
  }
  const stateDir = canonicalStateDir(stateDirInput);
  return acquireLinux(stateDir);
}
