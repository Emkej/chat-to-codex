import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INSTALLATION_TUNNEL_ID,
  installationTunnelPayload,
} from "../src/tunnel/installation.js";
import { needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { chooseQuickTunnel } from "../src/tunnel/named-provision.js";
import { findBinaryAsync } from "../src/tunnel/detect.js";

describe("installation tunnel preference", () => {
  it("reports an unset installation choice", () => {
    isolateStateDir();
    const payload = installationTunnelPayload();
    expect(payload.needsChoice).toBe(true);
    expect(payload.preference).toBe("unset");
    expect(payload.userPrompt).toMatch(/Cloudflare account/);
  });

  it("remembers a quick choice for the installation id", () => {
    isolateStateDir();
    chooseQuickTunnel(INSTALLATION_TUNNEL_ID);
    const payload = installationTunnelPayload();
    expect(needsTunnelChoice(readTunnelState(INSTALLATION_TUNNEL_ID))).toBe(false);
    expect(payload.needsChoice).toBe(false);
    expect(payload.preference).toBe("quick");
  });
});

describe("cancellable tunnel binary detection", () => {
  it.skipIf(process.platform !== "linux")("terminates an active version probe when cancelled", async () => {
    const dir = makeTmpDir("cloudflared-probe");
    const fakeBinary = path.join(dir, "cloudflared");
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    fs.writeFileSync(fakeBinary, "#!/usr/bin/env node\nsetInterval(() => {}, 30_000);\n", { mode: 0o700 });
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;

    try {
      const probing = findBinaryAsync("cloudflared", { signal: controller.signal, timeoutMs: 5_000 });
      setTimeout(() => controller.abort(new Error("probe cancelled")), 25);
      await expect(probing).rejects.toThrow("probe cancelled");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      cleanup(dir);
    }
  });
});
