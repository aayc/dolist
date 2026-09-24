import type { AgentRuntime } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import type { Logger } from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { VaultSearch } from "./search";
import type { SecurityPolicy } from "./security";
import type { SettingsStore } from "./settings-store";
import type { WriteTracker } from "./write-tracker";

/** Resolved dependencies shared by the route modules. */
export interface AppContext {
  storage: StorageProvider;
  runtime: AgentRuntime;
  settings: SettingsStore;
  policy: SecurityPolicy;
  token: string;
  logger: Logger;
  /** Built web UI directory, or null when static serving is disabled. */
  webDist: string | null;
  connectors: Pick<ConnectorToolSource, "status"> | undefined;
  writes: WriteTracker;
  search: VaultSearch;
  now: () => Date;
  version: string;
}
