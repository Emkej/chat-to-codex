import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT, getC2cHome, getStateDir } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, probeBridge, type RuntimeState } from "../bridge/runtime.js";
import { createAdminGuard } from "../bridge/admin-guard.js";
import {
  loadOrCreateInstallation,
  type InstallationIdentity,
} from "../workspaces/installation.js";
import { WorkspaceRegistry, RegistryError } from "../workspaces/registry.js";
import { SessionRegistry } from "../workspaces/sessions.js";
import { resolveRegisteredWorkspaceTarget } from "../workspaces/targets.js";
import { acquireWriteOwner, type WriteOwnerLease } from "../write-requests/owner.js";
import { WriteRequestService } from "../write-requests/service.js";
import { WriteRequestStore } from "../write-requests/store.js";
import { createWriteRequestAdminRouter } from "./write-request-admin.js";

export const CONNECTOR_DISPLAY_NAME = "Chat to Codex";

export interface BrokerOptions {
  /** Defaults to the standard C2C state dir. */
  stateDir?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Broker {
  installation: InstallationIdentity;
  registry: WorkspaceRegistry;
  sessions: SessionRegistry;
  authStore: AuthStore;
  pairing: PairingManager;
  writeRequests: WriteRequestService | undefined;
  tunnel: TunnelProvider;
  port: number;
  host: string;
  adminToken: string;
  localBaseUrl(): string;
  close(): Promise<void>;
}

export interface BrokerInfo {
  service: string;
  version: string;
  installationId: string;
  displayName: string;
  workspaceCount: number;
  activeSessions: number;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

const mcpBodyParserErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if ((error as { type?: string } | undefined)?.type !== "entity.too.large") {
    next(error);
    return;
  }
  res.status(413).json({
    error: "PATCH_TOO_LARGE",
    message: "Request body exceeds the MCP transport limit.",
  });
};

/**
 * The installation-level broker: one stable MCP endpoint (one Claude
 * connector, one OAuth/pairing relationship) serving every registered
 * Codex workspace. Claude addresses workspaces only by opaque registry
 * id; roots never leave the machine and every read stays confined to the
 * resolved workspace.
 */
export async function startBroker(opts: BrokerOptions = {}): Promise<Broker> {
  const logger = opts.logger ?? nullLogger;
  const stateDir = opts.stateDir ?? getStateDir();
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The broker only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const installation = loadOrCreateInstallation(stateDir);
  const registry = WorkspaceRegistry.load(stateDir);
  const sessions = SessionRegistry.load(stateDir, { workspaces: registry });
  const authStore = new AuthStore(installation.installationId, {
    file: opts.authStoreFile ?? path.join(stateDir, "auth", `${installation.installationId}.json`),
  });
  const pairing = new PairingManager(installation.installationId, { ttlMs: opts.pairingTtlMs });
  // Prefer the installation's named-tunnel binding (stable hostname); fall
  // back to a Quick Tunnel when no named tunnel has been provisioned yet.
  const binding = namedTunnelBinding(readTunnelState("installation"));
  const tunnel =
    opts.tunnelProvider ??
    (binding
      ? new CloudflaredNamedTunnel({ tunnelName: binding.tunnelName, hostname: binding.hostname, logger })
      : new CloudflaredQuickTunnel(logger));
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const payload: Record<string, string> = {
      service: SERVICE_NAME,
      version: VERSION,
      status: "ok",
    };
    // Installation identity is only for local loopback probes; the tunneled
    // /health surface stays minimal.
    if (isLoopback && !viaProxy) payload.workspaceId = installation.installationId;
    res.json(payload);
  });

  // ---- OAuth + discovery (installation-bound) ------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: CONNECTOR_DISPLAY_NAME,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  let writeRequests: WriteRequestService | undefined;
  const mcpHandler = createMcpHttpHandler(
    () => {
      return createMcpServer({ registry, sessions, ...(writeRequests ? { writeRequests } : {}), logger });
    },
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({
      store: authStore,
      workspaceId: installation.installationId,
      getBaseUrl,
      logger,
    }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );
  app.use("/mcp", mcpBodyParserErrorHandler);

  // ---- Admin API (loopback + admin token only; CLI/local tooling) -----------

  const adminGuard = createAdminGuard(adminToken);

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    const info: BrokerInfo = {
      service: SERVICE_NAME,
      version: VERSION,
      installationId: installation.installationId,
      displayName: CONNECTOR_DISPLAY_NAME,
      workspaceCount: registry.list().length,
      activeSessions: sessions.list().length,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    };
    res.json(info);
  });

  app.post("/admin/workspace", adminGuard, express.json(), (req, res) => {
    const body = (req.body ?? {}) as { root?: string; displayName?: string };
    if (!body.root) {
      res.status(400).json({ error: "invalid_request", message: "root is required" });
      return;
    }
    try {
      res.json(registry.register({ root: body.root, displayName: body.displayName }));
    } catch (error) {
      if (error instanceof RegistryError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/admin/workspaces", adminGuard, (_req, res) => {
    res.json({ workspaces: registry.list() });
  });

  app.post("/admin/workspace/remove", adminGuard, express.json(), (req, res) => {
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) {
      res.status(400).json({ error: "invalid_request", message: "id is required" });
      return;
    }
    const removed = registry.remove(body.id);
    const sessionsEnded = removed ? sessions.endByWorkspace(body.id) : 0;
    res.json({ removed, sessionsEnded });
  });

  app.post("/admin/session", adminGuard, express.json(), (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: string; pid?: number };
    if (!body.workspaceId) {
      res.status(400).json({ error: "invalid_request", message: "workspaceId is required" });
      return;
    }
    try {
      res.json(sessions.create(body.workspaceId, { pid: body.pid }));
    } catch (error) {
      if (error instanceof RegistryError) {
        res.status(404).json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/admin/session/heartbeat", adminGuard, express.json(), (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: string };
    if (!body.sessionId) {
      res.status(400).json({ error: "invalid_request", message: "sessionId is required" });
      return;
    }
    const session = sessions.touch(body.sessionId);
    if (!session) {
      res.status(404).json({ error: "UNKNOWN_SESSION", message: "Session expired or unknown" });
      return;
    }
    res.json(session);
  });

  app.post("/admin/session/end", adminGuard, express.json(), (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: string };
    if (!body.sessionId) {
      res.status(400).json({ error: "invalid_request", message: "sessionId is required" });
      return;
    }
    res.json({ ended: sessions.end(body.sessionId) });
  });

  app.get("/admin/sessions", adminGuard, (_req, res) => {
    res.json({ sessions: sessions.list() });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  let writeOwner: WriteOwnerLease | undefined;
  let lifecycle: WriteRequestService | undefined;
  let listening: { server: Server; port: number };
  try {
    if (process.platform === "linux") {
      writeOwner = await acquireWriteOwner(stateDir);
      lifecycle = new WriteRequestService({
        store: new WriteRequestStore(stateDir),
        resolveTarget: (workspaceId, worktreeId) => {
          const target = resolveRegisteredWorkspaceTarget(registry, workspaceId, worktreeId, undefined, {
            allowCrossNamespace: true,
          });
          return {
            workspace: target.workspace,
            workspaceId: target.registration.id,
            ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
          };
        },
        protectedRoots: [stateDir, getC2cHome()],
      });
      writeRequests = lifecycle;
      app.use("/admin/write-requests", createWriteRequestAdminRouter(lifecycle, adminGuard));
    } else {
      logger.warn("Write-request tools are unavailable on this platform; starting the broker read-only.");
    }
    listening = await listen(app, host, opts.port ?? DEFAULT_PORT);
  } catch (error) {
    await writeOwner?.release();
    throw error;
  }
  const { server, port } = listening;
  // Duplicate-daemon guard: if the preferred port was taken and we fell back
  // to an ephemeral one, refuse to shadow an already-running broker for the
  // same installation (it would split the CLI from the tunnel-bearing broker).
  const preferredPort = opts.port ?? DEFAULT_PORT;
  if (port !== preferredPort) {
    const occupant = await probeBridge(preferredPort);
    if (occupant && occupant.workspaceId === installation.installationId) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeOwner?.release();
      throw new Error(
        `A broker for this installation is already running on port ${preferredPort}; not starting a duplicate.`
      );
    }
  }
  const startedAt = new Date().toISOString();
  logger.info(
    `Broker listening on ${host}:${port} for installation ${installation.installationId} ` +
      `(${registry.list().length} workspace(s))`
  );

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: installation.installationId,
      workspaceRoot: stateDir,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  try {
    persistRuntime();
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeOwner?.release();
    throw error;
  }

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await tunnel.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (opts.persistRuntime !== false) clearRuntimeState(installation.installationId);
      logger.info("Broker stopped");
    } finally {
      await writeOwner?.release();
    }
  };

  return {
    installation,
    registry,
    sessions,
    authStore,
    pairing,
    writeRequests: lifecycle,
    tunnel,
    port,
    host,
    adminToken,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
