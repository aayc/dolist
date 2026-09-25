import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CLIENT_EVENT_TYPES,
  exact,
  SERVER_EVENT_TYPES,
  WIRE_SCHEMAS,
  type WireSchemaName,
} from "../../src/wire";

interface Case {
  name: string;
  value: unknown;
}

interface InvalidCase extends Case {
  /** Path of an issue the schema must report. */
  path: Array<string | number>;
  /** zod issue code of that issue. */
  code: string;
}

const dir = new URL("../../fixtures/wire/", import.meta.url);
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort();

function load<T>(file: string): T[] {
  return JSON.parse(readFileSync(new URL(file, dir), "utf8")) as T[];
}

function parseName(file: string): { schema: WireSchemaName; kind: "valid" | "invalid" } {
  const match = /^(\w+)\.(valid|invalid)\.json$/.exec(file);
  if (!match || !(match[1]! in WIRE_SCHEMAS)) throw new Error(`Unexpected fixture file: ${file}`);
  return { schema: match[1] as WireSchemaName, kind: match[2] as "valid" | "invalid" };
}

describe.each(files)("%s", (file) => {
  const { schema: name, kind } = parseName(file);
  const schema: z.ZodType = WIRE_SCHEMAS[name];

  if (kind === "valid") {
    it.each(load<Case>(file).map((c) => [c.name, c] as const))(
      "accepts %s exactly and unchanged",
      (_name, { value }) => {
        const parsed = schema.safeParse(value);
        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.data).toStrictEqual(value);
        expect(exact(schema).safeParse(value).error?.issues ?? []).toEqual([]);
      },
    );
  } else {
    it.each(load<InvalidCase>(file).map((c) => [c.name, c] as const))(
      "rejects %s at the expected path",
      (_name, { value, path, code }) => {
        const parsed = schema.safeParse(value);
        expect(parsed.success).toBe(false);
        const issues = (parsed.error?.issues ?? []).map((issue) => ({
          path: issue.path,
          code: issue.code,
        }));
        expect(issues).toContainEqual({ path, code });
      },
    );
  }
});

describe("fixture coverage", () => {
  const byName = new Map<string, Set<string>>();
  for (const file of files) {
    const { schema, kind } = parseName(file);
    byName.set(schema, (byName.get(schema) ?? new Set()).add(kind));
  }

  it("has valid and invalid cases for every request body and the event unions", () => {
    for (const name of [
      "WriteNoteRequest",
      "RenameRequest",
      "CreateFolderRequest",
      "SetAgentEnabledRequest",
      "PostMessageRequest",
      "ApprovalDecisionRequest",
      "CreateRoutineRequest",
      "UpdateSettingsRequest",
      "DeviceSettingsPatch",
      "DeviceSyncSetupRequest",
      "PairingCodeRequest",
      "PairRequest",
      "MachinePairRequest",
      "ServerEvent",
      "ClientEvent",
    ]) {
      expect([...(byName.get(name) ?? [])].sort(), name).toEqual(["invalid", "valid"]);
    }
  });

  it("has a valid example of every server and client event type", () => {
    const server = load<Case>("ServerEvent.valid.json").map(
      (c) => (c.value as { type: string }).type,
    );
    expect(new Set(server)).toEqual(new Set(SERVER_EVENT_TYPES));
    const client = load<Case>("ClientEvent.valid.json").map(
      (c) => (c.value as { type: string }).type,
    );
    expect(new Set(client)).toEqual(new Set(CLIENT_EVENT_TYPES));
  });
});
