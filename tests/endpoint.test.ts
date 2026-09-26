import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  CONNECTOR_SETTINGS_URL,
  CREATE_CONNECTOR_URL,
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  reclaimUserMessage,
  confirmStoredConnectorEndpoint,
  endpointFile,
  readLastEndpoint,
  writeLastEndpoint,
} from "../src/config/endpoint.js";
import { isolateStateDir, write } from "./helpers.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Chat to Codex")).toContain("Claude");
    expect(reclaimUserMessage("Chat to Codex")).toContain("remove");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Chat to Codex",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("uses the Claude default when an old endpoint has no stored name", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own Claude connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Chat to Codex · Landing");
  });

  it("points connector management at Claude Web", () => {
    expect(CONNECTOR_SETTINGS_URL).toContain("claude.ai");
    expect(CLAUDE_CONNECTORS_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CREATE_CONNECTOR_URL).toBe(CONNECTOR_SETTINGS_URL);
  });

  it("keeps legacy ChatGPT constants as aliases during migration", () => {
    expect(CHATGPT_DEVELOPER_MODE_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CHATGPT_PLUGINS_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CHATGPT_CREATE_CONNECTOR_URL).toBe(CREATE_CONNECTOR_URL);
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});

describe("persisted connector endpoint confirmation", () => {
  it("treats a legacy mcpUrl as confirmed on read and preserves pending observations across reloads", () => {
    const stateDir = isolateStateDir();
    const workspaceId = "c2c_inst_legacy-endpoint";
    write(stateDir, `endpoints/${workspaceId}.json`, JSON.stringify({
      workspaceId,
      port: 3030,
      publicUrl: "https://old.example",
      mcpUrl: "https://old.example/mcp",
      savedAt: "2026-09-01T00:00:00.000Z",
    }));

    const legacy = readLastEndpoint(workspaceId);
    expect(legacy?.confirmedMcpUrl).toBe("https://old.example/mcp");
    expect(JSON.parse(fs.readFileSync(endpointFile(workspaceId), "utf8")).confirmedMcpUrl).toBeUndefined();

    writeLastEndpoint({
      workspaceId,
      port: 3030,
      publicUrl: "https://new.example",
      mcpUrl: "https://new.example/mcp",
      confirmedMcpUrl: legacy?.confirmedMcpUrl ?? null,
      connectorName: "Existing connector",
    });

    const reloaded = readLastEndpoint(workspaceId);
    expect(reloaded?.mcpUrl).toBe("https://new.example/mcp");
    expect(reloaded?.confirmedMcpUrl).toBe("https://old.example/mcp");
    expect(connectorAction(reloaded?.confirmedMcpUrl, reloaded?.mcpUrl)).toBe("update");
  });

  it("confirms only the current observed endpoint and rejects a stale displayed URL", () => {
    isolateStateDir();
    const workspaceId = "c2c_inst_confirmation";
    writeLastEndpoint({
      workspaceId,
      port: 3030,
      publicUrl: "https://new.example",
      mcpUrl: "https://new.example/mcp",
      confirmedMcpUrl: "https://old.example/mcp",
      connectorName: "Existing connector",
    });

    expect(confirmStoredConnectorEndpoint({ workspaceId, mcpUrl: "https://old.example/mcp" })).toEqual({
      ok: false,
      reason: "endpoint-mismatch",
      currentMcpUrl: "https://new.example/mcp",
    });
    expect(readLastEndpoint(workspaceId)?.confirmedMcpUrl).toBe("https://old.example/mcp");

    expect(confirmStoredConnectorEndpoint({ workspaceId, mcpUrl: "https://new.example/mcp/" })).toEqual({
      ok: true,
      mcpUrl: "https://new.example/mcp",
    });
    expect(readLastEndpoint(workspaceId)?.confirmedMcpUrl).toBe("https://new.example/mcp");
    expect(connectorAction(
      readLastEndpoint(workspaceId)?.confirmedMcpUrl,
      readLastEndpoint(workspaceId)?.mcpUrl
    )).toBe("none");
  });
});
