import { describe, expect, it } from "vitest";
import type { InstallationStatus } from "../src/admin/installation-status.js";
import {
  formatManagerFreshness,
  formatManagerOperationalContext,
  formatManagerVersionMismatch,
  getManagerFreshness,
  getManagerVersionMismatch,
} from "../src/manager/layout.js";

const observedAt = "2026-09-26T10:00:00.000Z";
const now = Date.parse(observedAt) + 4_000;

function makeStatus(options: {
  profile?: string | null;
  brokerVersion?: string;
  observedAt?: string;
} = {}): InstallationStatus {
  return {
    installation: {
      state: "ready",
      id: "c2c_inst_test",
      version: "0.2.0",
      profile: options.profile ?? null,
    },
    broker: {
      state: "running",
      port: 4123,
      ...(options.brokerVersion ? { version: options.brokerVersion } : {}),
    },
    authorization: { state: "authorized" },
    tunnel: {
      state: "running",
      provider: "cloudflare-quick",
      preference: "quick",
      endpoint: "https://c2c.example/mcp",
    },
    workspaces: [],
    observedAt: options.observedAt ?? observedAt,
  };
}

describe("Manager presentation context", () => {
  it("renders the runtime default profile and a named profile without hiding either", () => {
    expect(formatManagerOperationalContext(makeStatus({ profile: null }), false, now)).toBe(
      "Profile: default · C2C: 0.2.0 · Refresh: live · 4s ago"
    );
    expect(formatManagerOperationalContext(makeStatus({ profile: "test" }), false, now)).toBe(
      "Profile: test · C2C: 0.2.0 · Refresh: live · 4s ago"
    );
  });

  it("distinguishes loading, refreshing, fresh and stale status", () => {
    const status = makeStatus();

    expect(getManagerFreshness(null, false, now)).toBe("loading");
    expect(formatManagerFreshness(null, false, now)).toBe("loading");
    expect(getManagerFreshness(status, true, now)).toBe("refreshing");
    expect(formatManagerFreshness(status, true, now)).toBe("refreshing · 4s ago");
    expect(getManagerFreshness(status, false, now)).toBe("fresh");
    expect(formatManagerFreshness(status, false, now)).toBe("live · 4s ago");
    expect(getManagerFreshness(status, false, now + 30_000)).toBe("stale");
    expect(formatManagerFreshness(status, false, now + 30_000)).toBe("stale · 34s ago");
  });

  it("presents only a real Manager/broker version mismatch", () => {
    const mismatch = makeStatus({ brokerVersion: "0.1.0" });
    expect(getManagerVersionMismatch(mismatch)).toEqual({ manager: "0.2.0", broker: "0.1.0" });
    expect(formatManagerVersionMismatch(mismatch)).toBe(
      "Version mismatch: Manager 0.2.0 · Broker 0.1.0"
    );
    expect(getManagerVersionMismatch(makeStatus({ brokerVersion: "0.2.0" }))).toBeNull();
    expect(formatManagerVersionMismatch(makeStatus())).toBeNull();
  });
});
