import type * as core from "@ddl/core";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  namedWireSchemas,
  REQUEST_SCHEMA_NAMES,
  type SettingsPatchSectionSchemas,
  WIRE_SCHEMAS,
  type WireType,
} from "../../src/wire";

describe("schema catalog", () => {
  test("every registered schema has a unique id and is exported, so WIRE_SCHEMAS has it", () => {
    const registered = namedWireSchemas.map((entry) => entry.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect(Object.keys(WIRE_SCHEMAS).sort()).toEqual(registered.sort());
  });

  test("request schemas are named in the catalog", () => {
    for (const name of REQUEST_SCHEMA_NAMES) expect(WIRE_SCHEMAS).toHaveProperty(name);
  });

  test("the settings patch sections are exactly the AppSettings sections", () => {
    expectTypeOf<keyof typeof SettingsPatchSectionSchemas>().toEqualTypeOf<
      keyof core.AppSettings
    >();
  });

  test("the enums core owns are the ones the schemas check", () => {
    expectTypeOf<WireType<"AgentHarnessKind">>().toEqualTypeOf<core.AgentHarnessKind>();
    expectTypeOf<WireType<"ApprovalPolicy">>().toEqualTypeOf<core.ApprovalPolicy>();
    expectTypeOf<WireType<"OrchestratorThreadId">>().toEqualTypeOf<core.OrchestratorThreadId>();
  });

  test("tolerant objects infer without index signatures, strictly typed", () => {
    expectTypeOf<core.OkResponse>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<core.ThreadActionResponse>().toEqualTypeOf<{ ok: true; pending?: true }>();
    expectTypeOf<core.MessageAuthor>().toEqualTypeOf<
      "you" | "orchestrator" | "system" | `subagent:${string}`
    >();
  });
});
