import { z } from "zod";
import * as domain from "./domain";
import * as errors from "./errors";
import * as events from "./events";
import * as imports from "./imports";
import { wireRegistry } from "./registry";
import * as remote from "./remote";
import * as rest from "./rest";
import * as settings from "./settings";

type Modules = typeof domain &
  typeof errors &
  typeof events &
  typeof imports &
  typeof remote &
  typeof rest &
  typeof settings;

type Catalog = {
  [K in keyof Modules as Modules[K] extends { readonly "~wireId": infer Id extends string }
    ? Id
    : never]: Modules[K];
};

/** Every named wire schema by name (the `$defs` of the JSON Schema export), from the exports. */
export const WIRE_SCHEMAS = Object.fromEntries(
  [domain, errors, events, imports, remote, rest, settings]
    .flatMap((module) => Object.values(module) as unknown[])
    .flatMap((value) => {
      const id = value instanceof z.ZodType ? wireRegistry.get(value)?.id : undefined;
      return id === undefined ? [] : [[id, value] as const];
    }),
) as unknown as Catalog;

export type WireSchemaName = keyof typeof WIRE_SCHEMAS;

/**
 * Request-side schemas: strict (unknown keys rejected). Everything else is a response or event
 * and tolerates unknown keys.
 */
export const REQUEST_SCHEMA_NAMES = [
  "UpdateSettingsRequest",
  "WriteNoteRequest",
  "RenameRequest",
  "CreateFolderRequest",
  "SetAgentEnabledRequest",
  "PostMessageRequest",
  "ApprovalDecisionRequest",
  "CreateRoutineRequest",
  "ComputerPermissionsOpenRequest",
  "DeviceSettingsPatch",
  "DeviceSyncSetupRequest",
  "PairingCodeRequest",
  "PairRequest",
  "MachinePairRequest",
  "DeviceVaultRequest",
  "ObsidianImportPreviewRequest",
  "ObsidianImportRequest",
  "ClientHelloEvent",
  "ClientPingEvent",
  "SurfaceSubscribeEvent",
  "SurfaceUnsubscribeEvent",
  "ThreadReadEvent",
  "EditorActivityEvent",
  "ClientEvent",
] as const satisfies readonly WireSchemaName[];
