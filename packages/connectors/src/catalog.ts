/**
 * Curated, disabled-by-default connector examples. `mcp.example.json` in this package is generated
 * from the same data (a test keeps them in sync); the settings UI can offer these as presets.
 * Placeholders such as `${GITHUB_TOKEN}` are resolved from the daemon's environment at connect time.
 */
import type { ConnectorsConfig, McpServerConfig } from "./types";

export interface ConnectorCatalogEntry {
  /** Suggested key in `mcpServers`. */
  name: string;
  title: string;
  /** One line: what it does and why its approval posture is what it is. */
  summary: string;
  /** Maintained by the service vendor or the MCP project (false = community, unverified code). */
  verified: boolean;
  homepage?: string;
  /** Environment variables the user must provide (e.g. in `$DDL_HOME/.env`). */
  requiredEnv: string[];
  config: McpServerConfig;
}

/** `${NAME}` placeholder, built so no literal `${…}` appears in source strings. */
const envRef = (name: string) => `\${${name}}`;

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    name: "playwright",
    title: "Playwright browser",
    summary:
      "Drives a local browser (navigate, click, type, screenshot); every action goes through the safety evaluator.",
    verified: true,
    homepage: "https://github.com/microsoft/playwright-mcp",
    requiredEnv: [],
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      enabled: false,
      approval: "auto",
      description: "Local browser automation with Playwright",
    },
  },
  {
    name: "filesystem",
    title: "Filesystem",
    summary:
      "Reads and writes files inside the listed folders (edit the path); reads run freely, writes need approval.",
    verified: true,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    requiredEnv: [],
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"],
      enabled: false,
      approval: "writes",
      description: "Files in ~/Documents",
    },
  },
  {
    name: "github",
    title: "GitHub",
    summary:
      "Issues, pull requests and code via GitHub's official remote server; creating or changing anything needs approval.",
    verified: true,
    homepage: "https://github.com/github/github-mcp-server",
    requiredEnv: ["GITHUB_TOKEN"],
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${envRef("GITHUB_TOKEN")}` },
      enabled: false,
      approval: "writes",
      description: "GitHub issues, pull requests and code",
    },
  },
  {
    name: "notion",
    title: "Notion",
    summary:
      "Notion's official remote server; it requires OAuth sign-in, which Daily Do List does not support yet.",
    verified: true,
    homepage: "https://developers.notion.com/docs/mcp",
    requiredEnv: [],
    config: {
      type: "http",
      url: "https://mcp.notion.com/mcp",
      enabled: false,
      approval: "writes",
      description: "Notion pages and databases",
    },
  },
  {
    name: "google-workspace",
    title: "Google Workspace (community, unverified)",
    summary:
      "Gmail, Calendar and Drive through a community server you choose: review its code, fill in its command; sending and editing need approval.",
    verified: false,
    requiredEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    config: {
      type: "stdio",
      command: "REPLACE_WITH_THE_SERVER_COMMAND",
      args: [],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: envRef("GOOGLE_OAUTH_CLIENT_ID"),
        GOOGLE_OAUTH_CLIENT_SECRET: envRef("GOOGLE_OAUTH_CLIENT_SECRET"),
      },
      enabled: false,
      approval: "writes",
      description: "Gmail, Calendar and Drive (community server, unverified)",
    },
  },
];

/** The catalog as a connectors config (what `mcp.example.json` contains under `mcpServers`). */
export function catalogExampleConfig(): ConnectorsConfig {
  return {
    mcpServers: Object.fromEntries(
      CONNECTOR_CATALOG.map((entry) => [entry.name, structuredClone(entry.config)]),
    ),
  };
}
