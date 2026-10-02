import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
  "workspace.write",
] as const;

export const REPOSITORY_READ_SCOPE = "git.repository.read" as const;

export const BROKER_SUPPORTED_SCOPES = [
  ...SUPPORTED_SCOPES,
  REPOSITORY_READ_SCOPE,
] as const;

export type Scope = (typeof BROKER_SUPPORTED_SCOPES)[number];

export const DEFAULT_READ_SCOPES: readonly Scope[] = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
];

export const BROKER_DEFAULT_READ_SCOPES: readonly Scope[] = [
  ...DEFAULT_READ_SCOPES,
  REPOSITORY_READ_SCOPE,
];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type AuthorizationState = "authorized" | "unauthorized" | "unknown";

export interface AuthorizationSnapshot {
  state: AuthorizationState;
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<TokenRecord>;
  return (
    typeof token.hash === "string" &&
    (token.kind === "access" || token.kind === "refresh") &&
    typeof token.clientId === "string" &&
    typeof token.workspaceId === "string" &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === "string") &&
    typeof token.issuedAt === "number" &&
    Number.isFinite(token.issuedAt) &&
    typeof token.expiresAt === "number" &&
    Number.isFinite(token.expiresAt) &&
    typeof token.revoked === "boolean"
  );
}

function authorizationSnapshotFromTokens(
  tokens: readonly unknown[],
  installationId: string,
  now: number
): AuthorizationSnapshot {
  let unknownRecord = false;
  for (const candidate of tokens) {
    if (!isTokenRecord(candidate)) {
      unknownRecord = true;
      continue;
    }
    if (
      candidate.workspaceId === installationId &&
      !candidate.revoked &&
      candidate.expiresAt > now
    ) {
      return { state: "authorized" };
    }
  }
  return { state: unknownRecord ? "unknown" : "unauthorized" };
}

/** Read installation credentials without constructing a store or creating its directory. */
export function readAuthorizationSnapshot(
  stateDir: string,
  workspaceId: string,
  now = Date.now()
): AuthorizationSnapshot {
  if (!workspaceId || workspaceId === "." || workspaceId === ".." || /[\\/]/.test(workspaceId)) {
    return { state: "unknown" };
  }

  const file = path.join(stateDir, "auth", `${workspaceId}.json`);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "unauthorized" };
    return { state: "unknown" };
  }

  if (!data || typeof data !== "object" || !Array.isArray((data as PersistedAuthState).tokens)) {
    return { state: "unknown" };
  }
  return authorizationSnapshotFromTokens((data as PersistedAuthState).tokens, workspaceId, now);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;
  private authorizationStateUnknown = false;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    let contents: string;
    try {
      contents = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.authorizationStateUnknown = true;
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(contents);
    } catch {
      this.authorizationStateUnknown = true;
      return;
    }
    if (!data || typeof data !== "object" || !Array.isArray((data as PersistedAuthState).tokens)) {
      this.authorizationStateUnknown = true;
      return;
    }

    const now = Date.now();
    const clients = (data as PersistedAuthState).clients;
    if (Array.isArray(clients)) {
      for (const client of clients) {
        if (client && typeof client.clientId === "string") this.clients.set(client.clientId, client);
      }
    }
    for (const candidate of (data as PersistedAuthState).tokens) {
      if (!isTokenRecord(candidate)) {
        this.authorizationStateUnknown = true;
        continue;
      }
      if (!candidate.revoked && candidate.expiresAt > now) this.tokens.set(candidate.hash, candidate);
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
    this.authorizationStateUnknown = false;
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  authorizationSnapshot(now = Date.now()): AuthorizationSnapshot {
    const snapshot = authorizationSnapshotFromTokens([...this.tokens.values()], this.workspaceId, now);
    if (snapshot.state !== "authorized" && this.authorizationStateUnknown) return { state: "unknown" };
    return snapshot;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(
  requested: string | undefined,
  supportedScopes: readonly string[] = SUPPORTED_SCOPES,
  defaultReadScopes: readonly string[] = DEFAULT_READ_SCOPES
): string[] {
  if (!requested || requested.trim() === "") return [...defaultReadScopes];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => supportedScopes.includes(scope));
  return granted;
}
