import type { JsonSchema, ToolSpec } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionTools } from "../execution";
import { JUDGE_SCHEMA } from "../safety/llm-judge";
import { createKnowledgeTools } from "../tools/knowledge";
import { createMockIrreversibleActionTool } from "../tools/mock";
import { createOrchestratorTools } from "../tools/orchestrator";
import { createThreadTools } from "../tools/thread";
import { createFakeConnectors, createFakeExecution, createFakeWebTools } from "./fakes";
import { synthesizeJson, validateJson } from "./json-schema";

const unused = async (): Promise<never> => {
  throw new Error("unused");
};
let tools: ToolSpec[] = [];

beforeAll(async () => {
  tools = [
    ...createOrchestratorTools({
      spawnSubagent: unused,
      postComment: unused,
      askUser: unused,
      setTaskStatus: unused,
      messageSubagent: unused,
      cancelSubagent: unused,
      listTasks: unused,
      anchorLine: unused,
    }),
    ...createThreadTools({
      postUpdate: () => {},
      askUser: () => {},
      createArtifact: unused,
      finish: () => {},
    }),
    ...createKnowledgeTools({ storage: new MemoryStorageProvider() }),
    ...createFakeWebTools(),
    ...createExecutionTools(createFakeExecution({ browser: true }), {
      threadId: "t",
      taskId: null,
      workspace: { key: "t", dir: "/tmp/t" },
      capabilities: ["browser"],
    }),
    createMockIrreversibleActionTool("booking"),
    ...(await createFakeConnectors().getTools()),
  ];
});

describe("synthesizeJson", () => {
  it("produces valid arguments for every real tool schema (and the judge schema)", () => {
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      expect(validateJson(tool.parameters, synthesizeJson(tool.parameters)), tool.name).toEqual([]);
    }
    expect(validateJson(JUDGE_SCHEMA, synthesizeJson(JUDGE_SCHEMA))).toEqual([]);
  });

  it("uses hints by property name when they fit the schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        command: { type: "string" },
        count: { type: "integer", minimum: 1 },
        mode: { enum: ["a", "b"] },
      },
      required: ["command", "count", "mode"],
    };
    expect(synthesizeJson(schema, { command: "ls", count: 0, mode: "b" })).toEqual({
      command: "ls",
      count: 1,
      mode: "b",
    });
  });

  it("leaves strict-mode optional fields (required but nullable) null unless hinted", () => {
    const strict: JsonSchema = {
      type: "object",
      required: ["command", "timeout"],
      properties: {
        command: { type: "string" },
        timeout: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
      additionalProperties: false,
    };
    expect(synthesizeJson(strict, { command: "echo hi" })).toEqual({
      command: "echo hi",
      timeout: null,
    });
    expect(synthesizeJson(strict, { command: "echo hi", timeout: 5 })).toEqual({
      command: "echo hi",
      timeout: 5,
    });
  });

  const leaf = fc.oneof(
    fc.record({
      type: fc.constant("string"),
      minLength: fc.nat(5),
      maxLength: fc.integer({ min: 6, max: 20 }),
    }),
    fc.record({
      type: fc.constantFrom("integer", "number"),
      minimum: fc.integer({ min: -5, max: 5 }),
      maximum: fc.integer({ min: 6, max: 50 }),
    }),
    fc.record({ type: fc.constant("boolean") }),
    fc.record({ enum: fc.uniqueArray(fc.string(), { minLength: 1, maxLength: 4 }) }),
    fc.record({ const: fc.jsonValue() }),
  );
  const schema: fc.Arbitrary<JsonSchema> = fc.letrec<{ node: JsonSchema }>((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      leaf,
      fc.record({ type: fc.constant("array"), items: tie("node"), minItems: fc.nat(3) }),
      fc
        .dictionary(fc.stringMatching(/^[a-z]{1,6}$/), tie("node"), { maxKeys: 4 })
        .chain((properties) =>
          fc.record({
            type: fc.constant("object"),
            properties: fc.constant(properties),
            required: fc.subarray(Object.keys(properties)),
            additionalProperties: fc.boolean(),
          }),
        ),
    ),
  })).node;

  test.prop([schema])("every synthesized value validates against its schema", (s) => {
    expect(validateJson(s, synthesizeJson(s))).toEqual([]);
  });
});

describe("validateJson", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2 },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true, maxItems: 2 },
      kind: { enum: ["a", "b"] },
      n: { type: "integer", maximum: 3 },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts valid values and names every problem of invalid ones", () => {
    expect(validateJson(schema, { name: "ok", tags: ["x"], kind: "a", n: 3 })).toEqual([]);
    expect(validateJson(schema, { tags: ["x", "x", "y"], kind: "c", n: 3.5, extra: 1 })).toEqual([
      "name: is required",
      "tags: must have at most 2 items",
      "tags: must not contain duplicates",
      'kind: must be one of "a", "b"',
      "n: must be integer",
      "extra: is not an allowed property",
    ]);
    expect(validateJson(schema, "nope")).toEqual(["root: must be object"]);
    expect(validateJson({ type: "string", nullable: true }, null)).toEqual([]);
  });
});
