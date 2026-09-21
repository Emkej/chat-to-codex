import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startBroker } from "../../../../../src/broker/server.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliEntry = path.join(repositoryRoot, "src", "cli", "index.ts");
const windowsGit = "/mnt/c/Program Files/Git/cmd/git.exe";
const windowsTempRoot = "/mnt/c/Users/emkej/AppData/Local/Temp";

function toWindowsPath(value) {
  const normalized = value.replaceAll("\\", "/");
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(normalized);
  return match ? `${match[1].toUpperCase()}:/${match[2] ?? ""}` : value;
}

function toWslPath(value) {
  const normalized = value.replaceAll("\\", "/");
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function writeGitWrapper(toolDir) {
  const wrapper = path.join(toolDir, "git");
  writeExecutable(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const windowsGit = ${JSON.stringify(windowsGit)};
function toWindowsPath(value) {
  const normalized = value.replaceAll("\\\\", "/");
  const match = /^\\/mnt\\/([a-zA-Z])(?:\\/(.*))?$/.exec(normalized);
  return match ? match[1].toUpperCase() + ":/" + (match[2] ?? "") : value;
}
function toWslPath(value) {
  const normalized = value.replaceAll("\\\\", "/");
  const match = /^([a-zA-Z]):\\/(.*)$/.exec(normalized);
  return match ? "/mnt/" + match[1].toLowerCase() + "/" + match[2] : normalized;
}
const args = process.argv.slice(2).map(toWindowsPath);
const result = spawnSync(windowsGit, args, { encoding: "buffer" });
const output = result.stdout ? Buffer.from(result.stdout).toString("utf8") : "";
const isWorktreeList = args.includes("worktree") && args.includes("--porcelain") && args.includes("-z");
const isPathProbe = args.includes("--show-toplevel") || args.includes("--git-common-dir");
let normalized = output;
if (isWorktreeList) {
  normalized = output
    .split("\\0")
    .map((field) => field.startsWith("worktree ") ? "worktree " + toWslPath(field.slice(9)) : field)
    .join("\\0");
} else if (isPathProbe) {
  normalized = output.split(/\\r?\\n/).map((line) => line ? toWslPath(line) : line).join("\\n");
}
if (normalized) process.stdout.write(normalized);
if (result.stderr) process.stderr.write(Buffer.from(result.stderr));
process.exit(result.status ?? 1);
`
  );
  return wrapper;
}

function runGit(gitWrapper, cwd, args, env) {
  const result = spawnSync(gitWrapper, args, { cwd, env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  return result.stdout ?? "";
}

async function runDoctor(workspaceRoot, stateDir, codexHome, env) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", cliEntry, "doctor", "--fix", "--json", "-w", workspaceRoot],
    { cwd: repositoryRoot, env: { ...process.env, ...env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome } }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("doctor --fix --json timed out"));
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
        resolve({ json: JSON.parse(last), status, stderr });
      } catch {
        reject(new Error(`doctor --fix --json did not emit JSON (exit ${status}): ${stderr || last}`));
      }
    });
  });
}

const previousStateDir = process.env.C2C_STATE_DIR;
let fixtureRoot = null;
let broker = null;
let result = null;
let failure = null;

try {
  if (process.platform !== "linux") throw new Error("This WSL harness must run on Linux with Windows Git interop.");
  if (!fs.existsSync(windowsGit)) throw new Error(`Compatible Git not found: ${windowsGit}`);
  if (!fs.existsSync(windowsTempRoot)) throw new Error(`Windows temp root not found: ${windowsTempRoot}`);

  fixtureRoot = fs.mkdtempSync(path.join(windowsTempRoot, "c2c-spec001-live-"));
  const main = path.join(fixtureRoot, "main");
  const linked = path.join(fixtureRoot, "linked");
  const toolDir = path.join(fixtureRoot, "tools");
  const stateDir = path.join(fixtureRoot, "state");
  const codexHome = path.join(fixtureRoot, "codex-home");
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const gitWrapper = writeGitWrapper(toolDir);
  writeExecutable(
    path.join(toolDir, "cloudflared"),
    "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then printf 'cloudflared verification stub\\n'; fi\nexit 0\n"
  );
  const env = {
    ...process.env,
    PATH: `${toolDir}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "C2C verification",
    GIT_AUTHOR_EMAIL: "c2c-verification@example.invalid",
    GIT_COMMITTER_NAME: "C2C verification",
    GIT_COMMITTER_EMAIL: "c2c-verification@example.invalid",
  };

  const gitVersion = runGit(gitWrapper, fixtureRoot, ["--version"], env).trim();
  runGit(gitWrapper, main, ["init", "-b", "main"], env);
  fs.writeFileSync(path.join(main, "README.md"), "SPEC-001 live verification\n");
  runGit(gitWrapper, main, ["add", "README.md"], env);
  runGit(
    gitWrapper,
    main,
    ["-c", "user.name=C2C verification", "-c", "user.email=c2c-verification@example.invalid", "commit", "-m", "fixture"],
    env
  );
  runGit(gitWrapper, main, ["worktree", "add", "-b", "doctor-fix-live", linked], env);
  const inventory = runGit(gitWrapper, main, ["worktree", "list", "--porcelain", "-z"], env);
  if (!inventory.includes("\0") || !inventory.includes(`worktree ${main}`) || !inventory.includes(`worktree ${linked}`)) {
    throw new Error("Compatible Git did not return the expected NUL-delimited worktree inventory.");
  }

  process.env.C2C_STATE_DIR = stateDir;
  const tunnelUrl = "https://c2c-doctor-fix-live.example";
  const tunnel = {
    name: "live-verification-tunnel",
    async start() {
      return tunnelUrl;
    },
    async stop() {},
    async restart() {
      return tunnelUrl;
    },
    status() {
      return { running: true, url: tunnelUrl, provider: "live-verification-tunnel" };
    },
    getPublicUrl() {
      return tunnelUrl;
    },
    async doctor() {
      return {
        provider: "live-verification-tunnel",
        binaryFound: true,
        binaryPath: "live-verification-tunnel",
        running: true,
        url: tunnelUrl,
        problems: [],
      };
    },
  };
  broker = await startBroker({
    stateDir,
    port: 0,
    persistRuntime: true,
    authStoreFile: path.join(stateDir, "auth", "live-verification.json"),
    tunnelProvider: tunnel,
  });
  const parent = broker.registry.register({ root: main, displayName: "Live Main" });
  broker.authStore.issueTokens({
    clientId: "spec001-live-verification",
    scopes: ["workspace.read", "workspace.search", "git.read"],
  });

  const doctor = await runDoctor(linked, stateDir, codexHome, env);
  const report = doctor.json.report ?? {};
  const registration = report.registration ?? {};
  const registryEntries = broker.registry.list();
  const activeSessions = broker.sessions.list().length;
  if (
    doctor.status !== 0 ||
    doctor.stderr !== "" ||
    registration.ok !== true ||
    !String(registration.detail ?? "").includes(parent.id) ||
    !String(registration.detail ?? "").includes("worktree") ||
    !doctor.json.repairs?.includes("Codex session is active for this workspace") ||
    registryEntries.length !== 1 ||
    broker.registry.getByRoot(linked) !== null ||
    activeSessions !== 1
  ) {
    throw new Error(
      `doctor --fix did not satisfy the linked-worktree contract: ${JSON.stringify({ doctor, registryEntries, activeSessions })}`
    );
  }

  result = {
    status: "passed",
    gitVersion,
    gitContract: "worktree list --porcelain -z",
    fixture: "temporary Windows-mounted repository and linked worktree",
    doctorExitCode: doctor.status,
    registration: {
      ok: registration.ok,
      detail: registration.detail,
    },
    repairs: doctor.json.repairs,
    registryCountAfterRun: registryEntries.length,
    activeSessionsAfterRun: activeSessions,
    linkedRootRegistered: broker.registry.getByRoot(linked) !== null,
  };
} catch (error) {
  failure = error;
} finally {
  if (broker) await broker.close().catch(() => undefined);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: String(failure) })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ...result, node: process.version, platform: os.platform() }, null, 2)}\n`);
}
