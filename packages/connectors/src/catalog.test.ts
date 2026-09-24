import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, catalogExampleConfig } from "./catalog";
import { loadConnectorsConfig, parseServerConfig } from "./config";

const EXAMPLE_PATH = fileURLToPath(new URL("../mcp.example.json", import.meta.url));

describe("connector catalog", () => {
  it("is mirrored exactly by mcp.example.json", async () => {
    const json = JSON.parse(await readFile(EXAMPLE_PATH, "utf8"));
    expect(json.mcpServers).toEqual(catalogExampleConfig().mcpServers);
  });

  it("contains only valid, disabled, documented servers with an explicit approval posture", async () => {
    const config = await loadConnectorsConfig(EXAMPLE_PATH);
    expect(Object.keys(config.mcpServers)).toEqual(CONNECTOR_CATALOG.map((entry) => entry.name));
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const parsed = parseServerConfig(name, raw);
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.spec.enabled).toBe(false);
      expect(parsed.spec.description).toBeTruthy();
      expect(raw.approval).toBeDefined();
    }
  });

  it("flags unverified community servers and keeps secrets as placeholders", () => {
    for (const entry of CONNECTOR_CATALOG) {
      const serialized = JSON.stringify(entry.config);
      for (const variable of entry.requiredEnv) expect(serialized).toContain(`\${${variable}}`);
      if (!entry.verified) {
        expect(entry.title.toLowerCase()).toContain("unverified");
        expect(entry.config.description?.toLowerCase()).toContain("unverified");
      }
    }
    expect(CONNECTOR_CATALOG.find((entry) => entry.name === "google-workspace")?.verified).toBe(
      false,
    );
  });
});
