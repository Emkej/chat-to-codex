#!/usr/bin/env node
// Disposable installed-layout smoke. Never reads or updates the user's C2C profile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidence = evidenceIndex < 0 ? undefined : process.argv[evidenceIndex + 1];
assert(process.platform === "linux", "Linux/WSL is required");
assert(fs.existsSync(path.join(repo, "dist/broker/server.js")), "Run pnpm build first");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-command-smoke-"));
const home = path.join(root, "home"), app = path.join(home, "app"), state = path.join(home, "state"), workspace = path.join(root, "workspace");
const originalEnv = { C2C_HOME: process.env.C2C_HOME, C2C_STATE_DIR: process.env.C2C_STATE_DIR, C2C_PROFILE: process.env.C2C_PROFILE };
let broker, client;
const checks = [];
try {
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(path.join(home, "bin"));
  for (const entry of ["dist", "bin", "skill", "package.json"]) fs.cpSync(path.join(repo, entry), path.join(app, entry), { recursive: true });
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(app, "node_modules"));
  fs.symlinkSync(path.join(app, "bin/c2c.js"), path.join(home, "bin/c2c"));
  process.env.C2C_HOME = home; process.env.C2C_STATE_DIR = state; delete process.env.C2C_PROFILE;
  const { startBroker } = await import(pathToFileURL(path.join(app, "dist/broker/server.js")).href);
  broker = await startBroker({ stateDir: state, port: 0, authStoreFile: path.join(state, "auth.json") });
  const target = broker.registry.register({ root: workspace }).id, base = broker.localBaseUrl();
  const jsonFetch = async (route, init) => {
    const response = await fetch(base + route, init); assert(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const redirect = "http://127.0.0.1:19998/callback";
  const registration = await jsonFetch("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Disposable command acceptance", redirect_uris: [redirect] }) });
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(base + "/oauth/authorize");
  for (const [key, value] of Object.entries({ client_id: registration.client_id, redirect_uri: redirect, response_type: "code", state: "smoke", code_challenge: challenge, code_challenge_method: "S256", scope: "workspace.command" })) url.searchParams.set(key, value);
  const html = await (await fetch(url)).text();
  assert(html.includes("locally approved command execution"));
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1]; assert(requestId);
  const authorized = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId, pairing_code: broker.pairing.create().code }) });
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get("location")).searchParams.get("code"); assert(code);
  const tokens = await jsonFetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: redirect, code, code_verifier: verifier }) });
  assert.equal(tokens.scope, "workspace.command"); checks.push("fresh explicit command-only OAuth pairing/PKCE");
  client = new Client({ name: "command-installed-smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  const oldToken = broker.authStore.issueTokens({ clientId: registration.client_id, scopes: ["workspace.read"] });
  const oldClient = new Client({ name: "old-scope-smoke", version: "1" });
  try {
    await oldClient.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${oldToken.accessToken}` } } }));
    const denied = await oldClient.callTool({ name: "request_command", arguments: { workspace: target, argv: ["true"], reason: "must deny" } });
    assert.equal(JSON.parse(denied.content[0].text).error, "INSUFFICIENT_SCOPE");
    checks.push("existing read scope cannot create commands");
  } finally { await oldClient.close(); }
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }); assert(!result.isError, `${name} failed`); return JSON.parse(result.content[0].text);
  };
  const cli = async (...args) => (await promisify(execFile)(process.execPath, [path.join(home, "bin/c2c"), ...args], { cwd: workspace, env: { ...process.env }, timeout: 15000 })).stdout;
  const marker = path.join(workspace, "approved-once");
  const source = "const fs=require('fs');fs.appendFileSync('approved-once','1');console.log(JSON.stringify(process.argv.slice(1)));console.error('smoke-stderr');process.exitCode=7";
  const literal = ["a b", "$(touch forbidden)", "semi;colon", "", "λ"];
  const created = await call("request_command", { workspace: target, argv: [process.execPath, "-e", source, ...literal], reason: "Disposable acceptance check" });
  assert.equal(created.status, "pending"); assert(!fs.existsSync(marker)); checks.push("request creation does not execute");
  assert((await cli("pending", created.request_id)).includes("argv["));
  const approval = await cli("approve", created.request_id); assert(approval.includes("Started")); checks.push("installed CLI explicit ID approval returns started");
  let result;
  const deadline = Date.now() + 5000;
  do {
    result = await call("get_command_request", { workspace: target, request_id: created.request_id });
    if (result.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(result.status, "completed"); assert.equal(result.exit_code, 7); assert.equal(result.output_incomplete, false);
  assert.deepEqual(JSON.parse(result.stdout), literal); assert.equal(result.stderr, "smoke-stderr\n");
  assert.equal(fs.readFileSync(marker, "utf8"), "1"); assert(!fs.existsSync(path.join(workspace, "forbidden"))); checks.push("literal argv, one execution, nonzero terminal MCP success, complete stdout/stderr");
  await assert.rejects(cli("approve", created.request_id)); assert.equal(fs.readFileSync(marker, "utf8"), "1"); checks.push("duplicate approval cannot respawn");
  const detail = await cli("pending", created.request_id, "--output"); assert(detail.includes("smoke-stderr")); checks.push("explicit CLI output inspection");
  const rejected = await call("request_command", { workspace: target, argv: [process.execPath, "-e", "throw Error('must not execute')"], reason: "Reject acceptance" });
  await cli("reject", rejected.request_id);
  assert.equal((await call("get_command_request", { workspace: target, request_id: rejected.request_id })).status, "rejected"); checks.push("installed CLI rejection without execution");
  const report = { status: "passed", platform: process.platform, node: process.version, checks, limitations: ["Disposable installed layout with repository dependency symlink; production installer, external tunnel and browser UI were not exercised", "Fixed production timeout is covered with internal short-deadline runner tests, not a ten-minute smoke wait"] };
  if (evidence) fs.writeFileSync(path.resolve(evidence), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await client?.close(); await broker?.close();
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
