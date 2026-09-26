import { Box, Text } from "ink";
import type { ManagerSnapshot } from "../types.js";

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function HealthPanel({ snapshot }: { snapshot: ManagerSnapshot }) {
  const status = snapshot.status;
  const health = snapshot.health;
  const instruction = snapshot.connectorInstruction;
  const tunnelProvider = status?.tunnel.provider ?? "unknown provider";
  const tunnelPreference = status?.tunnel.preference ?? "unknown";

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>C2C Health</Text>
      <Text>Installation: {status ? titleCase(status.installation.state) : "Loading"}</Text>
      <Text>Broker: {status ? titleCase(status.broker.state) : "Loading"}</Text>
      <Text>Authorization: {status ? titleCase(status.authorization.state) : "Loading"}</Text>
      <Text>Tunnel runtime: {status ? titleCase(status.tunnel.state) + " (" + tunnelProvider + ")" : "Loading"}</Text>
      <Text>Tunnel preference: {titleCase(tunnelPreference)}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Health check</Text>
        {!health ? (
          <Text dimColor>Not checked in this Manager session.</Text>
        ) : (
          <>
            <Text>
              Endpoint: {titleCase(health.endpoint.state)}
              {snapshot.healthObservedAt ? " · checked " + new Date(snapshot.healthObservedAt).toLocaleTimeString() : ""}
            </Text>
            {health.issues.map((issue, index) => (
              <Text key={issue.code + "-" + index} wrap="wrap">
                {issue.repairable ? "Fix available: " : ""}
                {issue.message}
              </Text>
            ))}
            {health.endpoint.mcpUrl ? <Text wrap="wrap">MCP URL: {health.endpoint.mcpUrl}</Text> : null}
          </>
        )}
      </Box>

      {instruction.kind !== "none" ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" bold>
            Connector {instruction.kind} required
          </Text>
          <Text wrap="wrap">{instruction.connectorName}: {instruction.mcpUrl}</Text>
          {instruction.recoveryMessage ? <Text wrap="wrap">{instruction.recoveryMessage}</Text> : null}
          {snapshot.pairing ? (
            <Text>
              Pairing code: {snapshot.pairing.code}
              {snapshot.pairing.expiresAt <= Date.now() ? " (expired; Pair to renew)" : ""}
            </Text>
          ) : null}
        </Box>
      ) : snapshot.pairing ? (
        <Box marginTop={1}>
          <Text>
            Pairing code: {snapshot.pairing.code}
            {snapshot.pairing.expiresAt <= Date.now() ? " (expired; Pair to renew)" : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
