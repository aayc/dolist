/**
 * fast-check arbitraries for every named wire schema, derived from the schemas: `arbitraryFor`
 * walks a schema and generates within its types, enums, lengths and ranges (unicode text, empty
 * but valid strings, maximum lengths, bounds), and `BY_SCHEMA`/`BY_PATH` supply realistic values
 * mixed with edge cases where a generic value would rarely pass a refinement (ids, paths, URLs,
 * names) or would miss what matters (note content, tool inputs). Every value is valid, parses
 * unchanged (even with `exact`) and survives a JSON round trip.
 */
import fc from "fast-check";
import type { z } from "zod";
import { WIRE_SCHEMAS, type WireSchemaName } from "../wire/catalog";
import { MessageAuthorSchema } from "../wire/domain";
import type { WireType } from "../wire/infer";
import {
  Base64Schema,
  ClientIdSchema,
  DeviceNameInputSchema,
  DeviceNameSchema,
  EpochMsSchema,
  IsoDateSchema,
  ModelIdSchema,
  RequestPathSchema,
  RuntimeIdSchema,
  SyncDeviceNameSchema,
  VaultPathSchema,
} from "../wire/primitives";
import { wireRegistry } from "../wire/registry";
import {
  PairingCodeInputSchema,
  RemoteHostInputSchema,
  RemoteHostSchema,
  SyncDeviceIdSchema,
} from "../wire/remote";
import { MachineUrlSchema } from "../wire/settings";
import * as p from "./primitives";

type Arb = fc.Arbitrary<unknown>;

const maybe = (arb: Arb) => fc.option(arb, { nil: null, freq: 4 });

/** Schemas used in many places, matched however they are described. */
const BY_SCHEMA = new Map<object, () => Arb>(
  (
    [
      [RuntimeIdSchema, p.runtimeId],
      [ClientIdSchema, p.clientId],
      [EpochMsSchema, p.epochMs],
      [IsoDateSchema, p.isoDate],
      [VaultPathSchema, p.vaultPath],
      [RequestPathSchema, p.requestPath],
      [Base64Schema, p.base64],
      [ModelIdSchema, p.modelId],
      [DeviceNameSchema, p.deviceName],
      [DeviceNameInputSchema, p.deviceName],
      [SyncDeviceNameSchema, p.syncDeviceName],
      [SyncDeviceIdSchema, p.syncDeviceId],
      [MachineUrlSchema, p.machineUrl],
      [RemoteHostSchema, p.remoteHost],
      [RemoteHostInputSchema, p.remoteHost],
      [PairingCodeInputSchema, p.pairingCodeInput],
      [
        MessageAuthorSchema,
        () =>
          fc.oneof(
            fc.constantFrom("you", "orchestrator", "system"),
            fc
              .oneof(
                fc.constantFrom("researcher", "browser", "operator"),
                p.lengthWithin(fc.string({ minLength: 1, maxLength: 100 }), 1, 100),
              )
              .map((name) => `subagent:${name}`),
          ),
      ],
    ] as Array<[z.ZodType, () => Arb]>
  ).map(([schema, arb]) => [schema.def, arb]),
);

/** Single fields, by `Schema.field` path. */
const BY_PATH: Record<string, () => Arb> = {
  "CreateRoutineRequest.name": () =>
    fc.oneof(fc.constantFrom("Morning briefing", "Price watch", "Café ☕ digest"), p.segment()),
  "WriteNoteRequest.content": () =>
    fc.oneof(
      fc.constantFrom("", "- [ ] ", "---\ntags: [a, b]\n---\n- [ ] Book a table 🍽️\n  - later\n"),
      p.text(5_000),
    ),
  "DeviceSyncSetupRequest.url": () =>
    fc.constantFrom(
      "https://sync.example.com",
      "https://vm-name.tailnet-name.ts.net:8443",
      "https://sync.example.com/ddl",
      "http://127.0.0.1:7332",
    ),
  "PairingCodeResponse.code": p.pairingCode,
  "PairingCodeResponse.url": () => maybe(p.httpsMachineUrl()),
  "MachinePairRequest.url": () =>
    fc.oneof(
      p.machineUrl(),
      p.machineUrl().map((url) => `${url}/`),
      p.machineUrl().map((url) => url.toUpperCase()),
    ),
};

const named = new Map<z.ZodType, Arb>();

/**
 * Values `schema` accepts and returns unchanged. `path` (`Schema.field.sub`, restarting at every
 * named schema) selects `BY_PATH` entries. Throws for refinements it can't satisfy generically:
 * add a realistic generator for them.
 */
export function arbitraryFor(schema: z.ZodType, path = ""): Arb {
  const realistic = BY_PATH[path] ?? BY_SCHEMA.get(schema.def);
  if (realistic) return realistic();
  const id = wireRegistry.get(schema)?.id;
  if (id === undefined || id === path) return fromDefinition(schema, path);
  const arb = named.get(schema) ?? arbitraryFor(schema, id);
  named.set(schema, arb);
  return arb;
}

function fromDefinition(schema: z.ZodType, path: string): Arb {
  const def = schema.def;
  const checks = (def.checks ?? []).map((check) => check._zod.def);
  const refined = checks.some((check) => check.check === "custom");
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = (schema as z.ZodObject).shape;
      const fields = Object.entries(shape).map(([key, field]) => {
        const value = field.def.type === "optional" ? (field as z.ZodOptional).unwrap() : field;
        return [key, arbitraryFor(value as z.ZodType, `${path}.${key}`)] as const;
      });
      const requiredKeys = Object.keys(shape).filter((key) => shape[key]!.def.type !== "optional");
      return fc.record(Object.fromEntries(fields), { requiredKeys });
    }
    case "array": {
      const bound = (kind: string) =>
        (checks.find((check) => check.check === kind) as { minimum?: number; maximum?: number }) ??
        {};
      const minLength = bound("min_length").minimum ?? 0;
      const maxLength = Math.min(bound("max_length").maximum ?? Infinity, minLength + 4);
      const element = arbitraryFor((schema as z.ZodArray<z.ZodType>).element, path);
      const items = fc.array(element, { minLength, maxLength });
      return refined ? items.filter((value) => schema.safeParse(value).success) : items;
    }
    case "optional":
      return arbitraryFor((schema as z.ZodOptional<z.ZodType>).unwrap(), path);
    case "nullable":
      return maybe(arbitraryFor((schema as z.ZodNullable<z.ZodType>).unwrap(), path));
    case "union":
      return fc.oneof(
        ...(schema as z.ZodUnion<z.ZodType[]>).options.map((o) => arbitraryFor(o, path)),
      );
    case "enum":
      return fc.constantFrom(...(schema as z.ZodEnum).options);
    case "literal":
      return fc.constantFrom(...(def as z.core.$ZodLiteralDef<z.core.util.Literal>).values);
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "unknown":
      return p.toolInput();
    case "number": {
      const { minValue, maxValue, isInt } = schema as z.ZodNumber;
      const min = Math.max(minValue ?? -1e6, isInt ? Number.MIN_SAFE_INTEGER : -1e6);
      const max = Math.min(maxValue ?? 1e6, isInt ? Number.MAX_SAFE_INTEGER : 1e6);
      return isInt ? p.integer(min, max) : p.finiteNumber(min, max);
    }
    case "string": {
      const formatted = (def as { format?: string }).format !== undefined;
      if (refined || formatted || checks.some((check) => check.check === "string_format")) break;
      const { minLength, maxLength } = schema as z.ZodString;
      const min = minLength ?? 0;
      const max = maxLength ?? 2_000;
      return fc
        .oneof(
          { weight: 4, arbitrary: p.text(max) },
          {
            weight: 1,
            arbitrary: fc.string({ minLength: min, maxLength: Math.min(max, min + 40) }),
          },
          { weight: 1, arbitrary: fc.constant("x".repeat(Math.min(max, 10_000))) },
        )
        .map((value) => schema.safeParse(value))
        .filter((result) => result.success)
        .map((result) => result.data);
    }
  }
  throw new Error(
    `arbitraryFor: no generator for ${path || "a schema"} (${def.type}); add one to BY_SCHEMA or BY_PATH`,
  );
}

/**
 * fast-check builds records with a null prototype; wire values come from `JSON.parse`, so every
 * exported arbitrary yields plain objects (own `__proto__` keys stay own properties).
 */
function toPlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toPlain) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: toPlain(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}

type WireArbitraries = { [K in WireSchemaName]: () => fc.Arbitrary<WireType<K>> };

/** One arbitrary factory per named wire schema. */
export const wireArbitraries = Object.fromEntries(
  Object.entries(WIRE_SCHEMAS).map(([name, schema]) => [
    name,
    () => arbitraryFor(schema).map(toPlain),
  ]),
) as WireArbitraries;

/** Arbitraries by camelCase name (`arb.thread()`, `arb.serverEvent()`), plus primitives. */
export const arb = {
  ...(Object.fromEntries(
    Object.entries(wireArbitraries).map(([name, factory]) => [
      name.charAt(0).toLowerCase() + name.slice(1),
      factory,
    ]),
  ) as { [K in WireSchemaName as Uncapitalize<K>]: WireArbitraries[K] }),
  runtimeId: p.runtimeId,
  isoDate: p.isoDate,
  text: p.text,
  trimmedText: p.trimmedText,
  notePath: p.notePath,
  folderPath: p.folderPath,
  requestPath: p.requestPath,
  cursorModelId: p.cursorModelId,
};
