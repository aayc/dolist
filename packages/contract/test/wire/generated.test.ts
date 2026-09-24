import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRoutesDocument, buildWireJsonSchema } from "../../src/docs/json-schema";
import { extractGeneratedSection, renderProtocolReference } from "../../src/docs/protocol-doc";
import { WIRE_SCHEMAS } from "../../src/wire";

const STALE = "stale: run `pnpm --filter @ddl/contract generate` and commit the result";

function committedJson(file: string): unknown {
  const url = new URL(`../../schema/${file}`, import.meta.url);
  expect(existsSync(url), `${file} is missing; ${STALE}`).toBe(true);
  return JSON.parse(readFileSync(url, "utf8"));
}

const normalized = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("generated artifacts", () => {
  it("schema/wire.schema.json matches the schemas", () => {
    expect(committedJson("wire.schema.json"), STALE).toStrictEqual(
      normalized(buildWireJsonSchema()),
    );
  });

  it("schema/routes.json matches the route table", () => {
    expect(committedJson("routes.json"), STALE).toStrictEqual(normalized(buildRoutesDocument()));
  });

  it("docs/PROTOCOL.md's reference section matches the contract", () => {
    const url = new URL("../../../../docs/PROTOCOL.md", import.meta.url);
    const section = extractGeneratedSection(readFileSync(url, "utf8"));
    expect(section, STALE).toBe(renderProtocolReference());
  });

  it("exports every named schema as a $def", () => {
    const defs = buildWireJsonSchema().$defs as Record<string, unknown>;
    expect(Object.keys(defs).sort()).toEqual(Object.keys(WIRE_SCHEMAS).sort());
  });

  it("marks requests strict and responses tolerant in JSON Schema too", () => {
    const defs = buildWireJsonSchema().$defs as Record<string, { additionalProperties?: unknown }>;
    expect(defs.WriteNoteRequest?.additionalProperties).toBe(false);
    expect(defs.ClientHelloEvent?.additionalProperties).toBe(false);
    expect(defs.NoteResponse?.additionalProperties).toEqual({});
    expect(defs.ThreadDeltaEvent?.additionalProperties).toEqual({});
  });
});
