import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AuthStore, readAuthorizationSnapshot, type TokenRecord } from "../src/auth/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

function makeStateDir(): string {
  const dir = makeTmpDir("auth-snapshot");
  dirs.push(dir);
  return dir;
}

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    hash: "token-hash",
    kind: "access",
    clientId: "client",
    workspaceId: "c2c_inst_snapshot",
    scopes: ["workspace.read"],
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revoked: false,
    ...overrides,
  };
}

function writeStore(stateDir: string, workspaceId: string, tokens: unknown[]): string {
  const directory = path.join(stateDir, "auth");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${workspaceId}.json`);
  fs.writeFileSync(file, JSON.stringify({ clients: [], tokens }));
  return file;
}

describe("authorization snapshots", () => {
  it("treats an absent auth store as unauthorized without creating its directory", () => {
    const stateDir = makeStateDir();

    expect(readAuthorizationSnapshot(stateDir, "c2c_inst_missing")).toEqual({ state: "unauthorized" });
    expect(fs.existsSync(path.join(stateDir, "auth"))).toBe(false);
  });

  it("returns unknown for malformed credential state", () => {
    const stateDir = makeStateDir();
    const file = writeStore(stateDir, "c2c_inst_malformed", []);
    fs.writeFileSync(file, "{");

    expect(readAuthorizationSnapshot(stateDir, "c2c_inst_malformed")).toEqual({ state: "unknown" });
  });

  it("retains unknown authorization status when a store starts from malformed state", () => {
    const stateDir = makeStateDir();
    const workspaceId = "c2c_inst_malformed_runtime";
    const file = writeStore(stateDir, workspaceId, []);
    fs.writeFileSync(file, "{");
    const store = new AuthStore(workspaceId, { file });

    expect(store.authorizationSnapshot()).toEqual({ state: "unknown" });
  });

  it("recognizes a valid credential even when another persisted record is malformed", () => {
    const stateDir = makeStateDir();
    const workspaceId = "c2c_inst_mixed";
    const now = Date.now();
    writeStore(stateDir, workspaceId, [
      { malformed: true },
      token({ workspaceId, expiresAt: now + 60_000 }),
    ]);

    expect(readAuthorizationSnapshot(stateDir, workspaceId, now)).toEqual({ state: "authorized" });
  });

  it("ignores expired and revoked credentials", () => {
    const stateDir = makeStateDir();
    const workspaceId = "c2c_inst_expired";
    const now = Date.now();
    writeStore(stateDir, workspaceId, [
      token({ expiresAt: now - 1 }),
      token({ kind: "refresh", expiresAt: now + 60_000, revoked: true }),
    ]);

    expect(readAuthorizationSnapshot(stateDir, workspaceId, now)).toEqual({ state: "unauthorized" });
  });

  it("does not count usable credentials bound to another installation", () => {
    const stateDir = makeStateDir();
    const installationId = "c2c_inst_current";
    const file = writeStore(stateDir, installationId, [
      token({ workspaceId: "c2c_inst_other" }),
    ]);
    const store = new AuthStore(installationId, { file });

    expect(readAuthorizationSnapshot(stateDir, installationId)).toEqual({ state: "unauthorized" });
    expect(store.authorizationSnapshot()).toEqual({ state: "unauthorized" });
  });

  it("treats a valid refresh-only credential as authorized", () => {
    const stateDir = makeStateDir();
    const workspaceId = "c2c_inst_refresh";
    const file = path.join(stateDir, "auth", `${workspaceId}.json`);
    const store = new AuthStore(workspaceId, { file });
    const credentials = store.issueTokens({
      clientId: "client",
      scopes: ["workspace.read", "offline_access"],
      accessTtlMs: -1,
    });

    expect(credentials.refreshToken).not.toBeNull();
    expect(store.authorizationSnapshot().state).toBe("authorized");
    expect(readAuthorizationSnapshot(stateDir, workspaceId).state).toBe("authorized");
  });

  it("rechecks in-memory expiry without rewriting token state", () => {
    const stateDir = makeStateDir();
    const workspaceId = "c2c_inst_runtime";
    const file = path.join(stateDir, "auth", `${workspaceId}.json`);
    const store = new AuthStore(workspaceId, { file });
    store.issueTokens({ clientId: "client", scopes: ["workspace.read"], accessTtlMs: 1_000 });
    const before = fs.readFileSync(file);

    expect(store.authorizationSnapshot(Date.now() + 60 * 60 * 1_000)).toEqual({ state: "unauthorized" });
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
