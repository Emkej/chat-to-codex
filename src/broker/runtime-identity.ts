import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { runGit } from "../workspace/git.js";

const INSTALLED_REVISION_FILE = ".c2c-revision";
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface BrokerRuntimeIdentity {
  readonly version: string;
  readonly revision: string | null;
  readonly profile: string | null;
}

function validRevision(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

function installedRevision(appRoot: string): string | null {
  try {
    const value = fs.readFileSync(path.join(appRoot, INSTALLED_REVISION_FILE), "utf8").trim();
    return validRevision(value) ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the C2C revision from its own app root, or from installed metadata. */
export function resolveC2cRevision(appRoot: string): string | null {
  let canonicalAppRoot: string;
  try {
    canonicalAppRoot = fs.realpathSync.native(appRoot);
  } catch {
    return null;
  }

  const topLevel = runGit(canonicalAppRoot, ["rev-parse", "--show-toplevel"]);
  if (topLevel.ok) {
    try {
      const canonicalTopLevel = fs.realpathSync.native(topLevel.stdout.trim());
      if (canonicalTopLevel !== canonicalAppRoot) return null;
    } catch {
      return null;
    }

    const head = runGit(canonicalAppRoot, ["rev-parse", "--short", "HEAD"]);
    const revision = head.stdout.trim();
    return head.ok && validRevision(revision) ? revision : null;
  }

  // A broken or unavailable source checkout must not be masked by stale
  // installed metadata. Git can still identify valid linked-worktree roots.
  if (fs.existsSync(path.join(canonicalAppRoot, ".git"))) return null;
  return installedRevision(canonicalAppRoot);
}

/** Persist only the single verified source revision needed by installed apps. */
export function persistInstalledRevision(appRoot: string, revision: string | null): void {
  const file = path.join(appRoot, INSTALLED_REVISION_FILE);
  if (!revision || !validRevision(revision)) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, `${revision}\n`, { mode: 0o644 });
}

function defaultAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Capture one immutable identity for the lifetime of a broker process. */
export function captureBrokerRuntimeIdentity(appRoot = defaultAppRoot()): BrokerRuntimeIdentity {
  return Object.freeze({
    version: VERSION,
    revision: resolveC2cRevision(appRoot),
    profile: process.env.C2C_PROFILE?.trim() || null,
  });
}
