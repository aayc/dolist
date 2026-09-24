/**
 * Regenerates the committed contract artifacts:
 *   - packages/contract/schema/wire.schema.json and routes.json (JSON Schema for non-TS clients)
 *   - the generated reference section of docs/PROTOCOL.md
 * `pnpm --filter @ddl/contract generate`; tests fail when these are stale.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildRoutesDocument,
  buildWireJsonSchema,
  ROUTES_FILE,
  WIRE_SCHEMA_FILE,
} from "../src/docs/json-schema";
import { renderProtocolReference, replaceGeneratedSection } from "../src/docs/protocol-doc";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const schemaDir = fileURLToPath(new URL("../schema/", import.meta.url));
const protocolDoc = fileURLToPath(new URL("../../../docs/PROTOCOL.md", import.meta.url));

mkdirSync(schemaDir, { recursive: true });
const jsonFiles = [
  [`${schemaDir}${WIRE_SCHEMA_FILE}`, buildWireJsonSchema()],
  [`${schemaDir}${ROUTES_FILE}`, buildRoutesDocument()],
] as const;
for (const [path, document] of jsonFiles) {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

// Biome owns JSON formatting (tests compare parsed JSON, so layout can't make them stale).
try {
  execFileSync("pnpm", ["exec", "biome", "format", "--write", ...jsonFiles.map(([path]) => path)], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch {
  console.warn("biome format failed; run `pnpm lint:fix` before committing");
}

const current = existsSync(protocolDoc) ? readFileSync(protocolDoc, "utf8") : "# Protocol\n";
writeFileSync(protocolDoc, replaceGeneratedSection(current, renderProtocolReference()));
console.log(`Wrote ${jsonFiles.length} JSON Schema files and docs/PROTOCOL.md`);
