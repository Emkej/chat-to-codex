// Disposable broker; C2C_STATE_DIR and C2C_PROBE_DIR must point to task scratch.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { startBroker } = await import(path.join(repository, "dist/broker/server.js"));
const { abortableDelay } = await import(path.join(repository, "dist/process/abort.js"));
const scratch = process.env.C2C_PROBE_DIR;
if (!scratch || !process.env.C2C_STATE_DIR) throw new Error("Disposable probe paths are required.");
const project = path.join(scratch, "project");
await fs.mkdir(project);
const before = Array.from({ length: 60 }, (_, i) => "before-" + i);
await fs.writeFile(path.join(project, "file.txt"), before.join("\n") + "\n");
const patch = "--- a/file.txt\n+++ b/file.txt\n" + before.map((line, i) =>
  `@@ -${i + 1} +${i + 1} @@\n-${line}\n+after-${i} ` + "x".repeat(90) + ` \x1b[31m\x07\\u{001b} END-${i}\n`
).join("");
const broker = await startBroker({ stateDir: process.env.C2C_STATE_DIR, port: 0, authStoreFile: path.join(process.env.C2C_STATE_DIR, "auth/fixture.json") });
const workspaceId = broker.registry.register({ root: project, displayName: "Request fixture" }).id;
const request = await broker.writeRequests.createManualRequest({ workspaceId, patch });
const store = broker.writeRequests.store;
const mode = async () => (await fs.readFile(path.join(scratch, "mode"), "utf8").catch(() => "normal")).trim();
const observed = store.getObserved.bind(store);
store.getObserved = async (id, budget) => {
  if (await mode() === "slow-read") {
    await fs.writeFile(path.join(scratch, "read-started"), "ready");
    try { await abortableDelay(30_000, budget.signal); } catch { budget.check(); }
  }
  return observed(id, budget);
};
const approve = broker.writeRequests.approveManualRequest.bind(broker.writeRequests);
broker.writeRequests.approveManualRequest = async (id) => {
  if (await mode() === "slow-approve") {
    await fs.writeFile(path.join(scratch, "approval-started"), "ready");
    while (await mode() === "slow-approve") await abortableDelay(25);
  }
  const result = await approve(id);
  await fs.writeFile(path.join(scratch, "applied"), "ready");
  return result;
};
await fs.writeFile(path.join(scratch, "ready.json"), JSON.stringify({ workspaceId, id: request.id, port: broker.port }));
process.on("SIGTERM", () => { void broker.close().then(() => process.exit(0)); });
