/**
 * (Initial stub — replaced by the real implementation.) Behaves as "no connectors configured".
 */
import type { ConnectorStatus, Logger, ToolSpec, Unsubscribe } from "@ddl/core";
import type { ConnectorsConfig, ConnectorToolSource } from "./types";

export const EMPTY_CONNECTORS_CONFIG: ConnectorsConfig = { mcpServers: {} };

export interface ConnectorManagerOptions {
  logger?: Logger;
}

export function createConnectorManager(
  _config: ConnectorsConfig,
  _options: ConnectorManagerOptions = {},
): ConnectorToolSource {
  return {
    async getTools(): Promise<ToolSpec[]> {
      return [];
    },
    status(): ConnectorStatus[] {
      return [];
    },
    onStatus(): Unsubscribe {
      return () => {};
    },
    async reload() {},
    async dispose() {},
  };
}

/** Reads a JSON file with an `mcpServers` object. Missing file → empty config. */
export async function loadConnectorsConfig(_path: string): Promise<ConnectorsConfig> {
  return EMPTY_CONNECTORS_CONFIG;
}
