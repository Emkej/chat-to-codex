import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBroker } from "../src/broker/server.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type DoctorRun = {
  json: Record<string, unknown>;
  status: number | null;
  stderr: string;
};

async function runDoctorProcess(
  workspaceRoot: string,
  stateDir: string,
  mode: "--fix" | "--no-fix",
  env: NodeJS.ProcessEnv = {}
): Promise<DoctorRun> {
  // Use the same tsx dev-fallback the bin uses so tests do not require dist/.
  const entry = path.join(projectRoot, "src", "cli", "index.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", entry, "doctor", mode, "--json", "-w", workspaceRoot],
    { env: { ...process.env, ...env, C2C_STATE_DIR: stateDir } }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`doctor ${mode} --json timed out`));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      const lines = stdout.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      try {
        resolve({ json: JSON.parse(last) as Record<string, unknown>, status, stderr });
      } catch {
        reject(new Error(`doctor ${mode} --json did not emit JSON (exit ${status}): ${stderr || last}`));
      }
    });
  });
}

async function runDoctorJson(workspaceRoot: string, stateDir: string): Promise<Record<string, unknown>> {
  return (await runDoctorProcess(workspaceRoot, stateDir, "--no-fix")).json;
}

function writeDoctorCompatibilityTools(toolDir: string, main: string, linked: string): void {
  const gitPath = write(
    toolDir,
    "git",
    `#!/usr/bin/env node
const main = ${JSON.stringify(main)};
const linked = ${JSON.stringify(linked)};
const commonDir = ${JSON.stringify(path.join(main, ".git"))};
const command = process.argv.slice(2).join(" ");
if (command === "rev-parse --is-inside-work-tree") {
  process.stdout.write("true\\n");
  process.exit(0);
}
if (command === "worktree list --porcelain -z") {
  process.stdout.write([
    \`worktree \${main}\`,
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    \`worktree \${linked}\`,
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature/doctor-fix",
    "",
  ].join("\\0"));
  process.exit(0);
}
if (command === "rev-parse --show-toplevel") {
  process.stdout.write(process.cwd() + "\\n");
  process.exit(0);
}
if (command === "rev-parse --git-common-dir") {
  process.stdout.write(commonDir + "\\n");
  process.exit(0);
}
process.exit(1);
`
  );
  fs.chmodSync(gitPath, 0o755);
  const cloudflaredPath = write(toolDir, "cloudflared", "#!/usr/bin/env sh\nexit 0\n");
  fs.chmodSync(cloudflaredPath, 0o755);
}

describe("c2c doctor --json", () => {
  it("reports the installation contract with connectorRepair and its deprecated alias", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("doctor-json");
    write(root, "hello.txt", "hello");
    const registryFile = path.join(stateDir, "workspaces", "registry.json");
    const sessionsFile = path.join(stateDir, "workspaces", "sessions.json");

    const json = await runDoctorJson(root, stateDir);
    const report = json.report as Record<string, { ok: boolean; detail?: string }>;
    const canonical = json.connectorRepair as Record<string, unknown> | undefined;
    const legacy = json.chatgptRepair as Record<string, unknown> | undefined;

    // shape contract: canonical field with the deprecated alias alongside
    expect(canonical).toBeDefined();
    expect(legacy).toBeDefined();
    expect(legacy).toStrictEqual(canonical);
    expect(canonical?.settingsUrl).toBe("https://claude.ai/settings/connectors");
    expect(canonical?.createConnectorUrl).toBe("https://claude.ai/settings/connectors");
    expect(canonical?.connectorAction).toBe("none");

    // without a running broker, the doctor reports honestly and fails closed
    expect(report.workspace?.ok).toBe(true);
    expect(report.installation?.ok).toBe(true);
    expect(report.broker?.ok).toBe(false);
    expect(fs.existsSync(registryFile)).toBe(false);
    expect(fs.existsSync(sessionsFile)).toBe(false);

    cleanup(root);
    cleanup(stateDir);
  });

  it("doctor --fix reuses the registered main for a linked worktree", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const main = makeTmpDir("doctor-fix-main");
    const linked = makeTmpDir("doctor-fix-linked");
    const toolDir = makeTmpDir("doctor-fix-tools");
    fs.mkdirSync(path.join(main, ".git"));
    writeDoctorCompatibilityTools(toolDir, main, linked);

    let publicUrl: string | null = null;
    const tunnel: TunnelProvider = {
      name: "test-tunnel",
      async start() {
        publicUrl = "https://c2c-doctor-fix.example";
        return publicUrl;
      },
      async stop() {
        publicUrl = null;
      },
      async restart() {
        publicUrl = "https://c2c-doctor-fix.example";
        return publicUrl;
      },
      status() {
        return { running: publicUrl !== null, url: publicUrl, provider: "test-tunnel" };
      },
      getPublicUrl() {
        return publicUrl;
      },
      async doctor() {
        return {
          provider: "test-tunnel",
          binaryFound: true,
          binaryPath: "test-tunnel",
          running: publicUrl !== null,
          url: publicUrl,
          problems: [],
        };
      },
    };

    let broker: Awaited<ReturnType<typeof startBroker>> | null = null;
    try {
      broker = await startBroker({
        stateDir,
        port: 0,
        persistRuntime: true,
        authStoreFile: path.join(stateDir, "auth", "doctor-fix.json"),
        tunnelProvider: tunnel,
      });
      const parent = broker.registry.register({ root: main, displayName: "Main" });
      broker.authStore.issueTokens({
        clientId: "doctor-fix-regression",
        scopes: ["workspace.read", "workspace.search", "git.read"],
      });

      const run = await runDoctorProcess(linked, stateDir, "--fix", {
        CODEX_HOME: path.join(stateDir, "codex-home"),
        PATH: `${toolDir}:${process.env.PATH ?? ""}`,
      });
      const report = run.json.report as Record<string, { ok: boolean; detail?: string }>;

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(report.registration?.ok).toBe(true);
      expect(report.registration?.detail).toContain(parent.id);
      expect(report.registration?.detail).toContain("worktree");
      expect(run.json.repairs).toEqual(expect.arrayContaining(["Codex session is active for this workspace"]));
      expect(broker.registry.list()).toHaveLength(1);
      expect(broker.registry.getByRoot(main)?.id).toBe(parent.id);
      expect(broker.registry.getByRoot(linked)).toBeNull();
    } finally {
      if (broker) await broker.close();
      cleanup(toolDir);
      cleanup(linked);
      cleanup(main);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });
});
