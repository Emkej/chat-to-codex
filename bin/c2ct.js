#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const c2c = path.join(here, "c2c.js");
const args = process.argv.slice(2);

if (args.some((arg) => arg === "--profile" || arg.startsWith("--profile="))) {
  console.error("c2ct always uses the test profile; omit --profile.");
  process.exitCode = 2;
} else {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "C2C_STATE_DIR" || name.toUpperCase() === "C2C_PROFILE") {
      delete env[name];
    }
  }
  env.C2C_PROFILE = "test";

  const result = spawnSync(process.execPath, [c2c, "--profile", "test", ...args], {
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
