/**
 * Where the agent runs (placement, readiness), this daemon's device-local settings, pairing other
 * devices with it, and the always-on machine seen from this device.
 */
import {
  isMachineUrl,
  isPairingCode,
  isRemoteHost,
  isSecureServiceUrl,
  normalizeMachineUrl,
  normalizePairingCode,
  normalizeRemoteHost,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  REMOTE_LIMITS,
  SYNC_ID_PATTERN,
} from "@ddl/core";
import { z } from "zod";
import {
  CountSchema,
  DeviceNameInputSchema,
  DeviceNameSchema,
  EpochMsSchema,
  RuntimeIdSchema,
  SyncDeviceNameSchema,
} from "./primitives";
import { named } from "./registry";
import { AgentHarnessKindSchema, AlwaysOnMachineSchema } from "./settings";

/** Device ids of the sync service (`dev_…`): 1–64 URL-safe characters. */
export const SyncDeviceIdSchema = z
  .string()
  .regex(SYNC_ID_PATTERN, "must be 1-64 characters of A-Z a-z 0-9 _ -")
  .describe("Device id (as the sync service knows it).");

const VersionSchema = z.string().min(1).max(100);

// ── Placement, readiness ─────────────────────────────────────────────────

export const AgentPlacementSchema = named(
  "AgentPlacement",
  "Where this device's agent runs: `this_device` (here; takes the agent over from the always-on machine), `always_on_machine` (never here; relayed to the always-on machine) or `always_on_host` (this is the always-on machine; it runs the agent when no `this_device` does). Without sync a daemon runs its own agent whatever the placement.",
  z.enum(["this_device", "always_on_machine", "always_on_host"]),
);

export const AgentRunsOnSchema = named(
  "AgentRunsOn",
  "The device that holds the agent lease.",
  z.looseObject({
    deviceId: SyncDeviceIdSchema,
    name: SyncDeviceNameSchema,
    thisDevice: z.boolean(),
    alwaysOnMachine: z.boolean().describe('The holder requested the lease with priority "host".'),
  }),
);

export const RelayStateSchema = named(
  "RelayState",
  "The link to the always-on machine's agent: `off` (not relaying), `connecting`, `connected`, `unreachable` or `not_paired`.",
  z.enum(["off", "connecting", "connected", "unreachable", "not_paired"]),
);

export const AgentPlacementStatusSchema = named(
  "AgentPlacementStatus",
  "This device's placement and who runs the agent now.",
  z.looseObject({
    placement: AgentPlacementSchema.describe(
      "The stored choice (see `heldHere` for when it can't apply).",
    ),
    heldHere: z
      .enum(["no_machine", "no_sync"])
      .optional()
      .describe(
        "Why the agent is held on this device despite the stored choice: no always-on machine is set up (`no_machine`), or this device doesn't sync (`no_sync`).",
      ),
    runsOn: AgentRunsOnSchema.nullable().describe(
      "Who runs the agent now (null: nobody, or unknown without sync).",
    ),
    relay: RelayStateSchema,
    note: z
      .string()
      .optional()
      .describe('Short, human ("Taking over from vm-1…", "Handing the agent to vm-1…").'),
  }),
);

export const AgentReadinessSchema = named(
  "AgentReadiness",
  "Whether a daemon can run the agent: its harness, a model credential (never the value), the browser, desktop control and connectors.",
  z.looseObject({
    harness: z.looseObject({
      kind: AgentHarnessKindSchema,
      ready: z.boolean(),
      problem: z.string().optional(),
    }),
    modelCredential: z
      .boolean()
      .describe("A model credential for the configured harness is present."),
    browser: z.boolean(),
    computer: z.enum(["available", "needs_permissions", "unsupported"]),
    connectors: z.looseObject({ configured: CountSchema, connected: CountSchema }),
  }),
);

// ── This daemon's device-local settings ──────────────────────────────────

/** A remote host as the daemon reports it: `host[:port]`, lowercase (`normalizeRemoteHost`). */
export const RemoteHostSchema = z
  .string()
  .min(1)
  .max(REMOTE_LIMITS.hostnameLength + 6)
  .refine(isRemoteHost, "must be a lowercase DNS name with an optional :port")
  .describe("`host[:port]`, lowercase DNS name (never an IP address or a loopback name).");

/** A remote host as a client sends it: trimmed and lowercased, then validated. */
export const RemoteHostInputSchema = z
  .string()
  .max(REMOTE_LIMITS.hostnameLength + 16)
  .trim()
  .toLowerCase()
  .refine(
    (host) => normalizeRemoteHost(host) === host,
    "must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)",
  );

const DeviceSettingFieldSchema = z.enum(["placement", "remoteHosts", "sync"]);

export const DeviceSyncSetupSchema = named(
  "DeviceSyncSetup",
  "This device's link to the sync service. The vault token is never returned.",
  z.looseObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .nullable()
      .describe("null: not syncing with the sync service."),
    vault: SyncDeviceIdSchema.nullable().describe("The sync vault id."),
    hasToken: z.boolean().describe("A vault token is saved."),
  }),
);

export const DeviceSettingsResponseSchema = named(
  "DeviceSettingsResponse",
  "This daemon's device-local settings (kept in `$DDL_HOME`, never synced).",
  z.looseObject({
    device: z.looseObject({ id: SyncDeviceIdSchema, name: SyncDeviceNameSchema }),
    placement: AgentPlacementSchema,
    remoteHosts: z
      .array(RemoteHostSchema)
      .max(REMOTE_LIMITS.remoteHosts)
      .describe("Names this daemon answers to besides loopback (e.g. its tailnet name)."),
    sync: DeviceSyncSetupSchema,
    lockedByEnv: z
      .array(DeviceSettingFieldSchema)
      .describe("Fields set by environment variables; clients show them read-only."),
  }),
);

export const DeviceSettingsPatchSchema = named(
  "DeviceSettingsPatch",
  "Body of `PATCH /api/device`: only the fields to change.",
  z.strictObject({
    name: DeviceNameInputSchema.optional().describe("Trimmed, then 1–64 characters."),
    placement: AgentPlacementSchema.optional(),
    remoteHosts: z
      .array(RemoteHostInputSchema)
      .max(REMOTE_LIMITS.remoteHosts)
      .refine((hosts) => new Set(hosts).size === hosts.length, "must not repeat a host")
      .optional()
      .describe(
        "DNS names with an optional `:port`, at most 8; trimmed and lowercased. No IPs, schemes or paths.",
      ),
  }),
);

export const DeviceSyncSetupRequestSchema = named(
  "DeviceSyncSetupRequest",
  "Body of `PUT /api/device/sync`: point this device at the sync service.",
  z.strictObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine(isSecureServiceUrl, "must use https (plain http only to loopback), no credentials")
      .describe("The sync service: https (plain http only to loopback)."),
    vault: SyncDeviceIdSchema.describe("The vault id printed by `ddl-sync vault create`."),
    token: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .optional()
      .describe("The vault token; omit to keep the saved one. Stored 0600 in `$DDL_HOME`."),
  }),
);

// ── Pairing ──────────────────────────────────────────────────────────────

/** A pairing code as a user types it: `XXXX-XXXX`, any case, spaces and dashes ignored. */
export const PairingCodeInputSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (code) => normalizePairingCode(code) !== null,
    `must be the ${PAIRING_CODE_LENGTH}-character pairing code (XXXX-XXXX)`,
  )
  .describe(
    `The pairing code: ${PAIRING_CODE_LENGTH} characters of \`${PAIRING_CODE_ALPHABET}\`, any case; spaces and dashes are ignored.`,
  );

export const PairedDeviceKindSchema = named(
  "PairedDeviceKind",
  "`browser` (gets an HttpOnly cookie), `app` (a native client) or `daemon` (another daemon relaying to this one).",
  z.enum(["browser", "app", "daemon"]),
);

export const PairedDeviceSchema = named(
  "PairedDevice",
  "A device holding a credential for this daemon.",
  z.looseObject({
    id: RuntimeIdSchema,
    name: DeviceNameSchema,
    kind: PairedDeviceKindSchema,
    createdAt: EpochMsSchema,
    lastSeenAt: EpochMsSchema.nullable().describe("Last use (updated at most once a minute)."),
    current: z.boolean().optional().describe("The device making this request."),
  }),
);

export const PairingCodeRequestSchema = named(
  "PairingCodeRequest",
  "Body of `POST /api/pairing-codes`.",
  z.strictObject({
    name: DeviceNameInputSchema.optional().describe("What the new device will be called."),
  }),
);

export const PairingCodeResponseSchema = named(
  "PairingCodeResponse",
  "A single-use pairing code.",
  z.looseObject({
    code: z
      .string()
      .length(PAIRING_CODE_LENGTH)
      .refine(isPairingCode, `must use only ${PAIRING_CODE_ALPHABET}`)
      .describe(
        `${PAIRING_CODE_LENGTH} characters of \`${PAIRING_CODE_ALPHABET}\`; show it as XXXX-XXXX.`,
      ),
    expiresAt: EpochMsSchema,
    url: z
      .string()
      .max(300)
      .refine(
        (url) => url.startsWith("https://") && isMachineUrl(url),
        "must be https://<remote host>",
      )
      .nullable()
      .describe("`https://<first remote host>` for a QR code; null without remote hosts."),
  }),
);

export const PairRequestSchema = named(
  "PairRequest",
  "Body of `POST /api/pair`: exchange a pairing code for a device credential.",
  z.strictObject({
    code: PairingCodeInputSchema,
    name: DeviceNameInputSchema,
    kind: PairedDeviceKindSchema,
  }),
);

export const PairResponseSchema = named(
  "PairResponse",
  "The paired device and, for `app` and `daemon` kinds, its token (shown once). A browser gets an HttpOnly cookie instead.",
  z.looseObject({
    device: PairedDeviceSchema,
    token: z
      .string()
      .min(16)
      .max(512)
      .optional()
      .describe("Send as `Authorization: Bearer <token>`."),
  }),
);

export const PairedDevicesResponseSchema = named(
  "PairedDevicesResponse",
  "Every device paired with this daemon.",
  z.looseObject({ devices: z.array(PairedDeviceSchema) }),
);

// ── The always-on machine ────────────────────────────────────────────────

export const MachineStatusResponseSchema = named(
  "MachineStatusResponse",
  "The always-on machine from this device's side: its address, this device's pairing and what the machine reports.",
  z.looseObject({
    machine: AlwaysOnMachineSchema.nullable().describe("null: no always-on machine configured."),
    paired: z.boolean().describe("This device holds a credential for the machine."),
    reachable: z.boolean().nullable().describe("null: not checked yet, or no machine."),
    checkedAt: EpochMsSchema.nullable(),
    version: VersionSchema.optional().describe("The machine's daemon version."),
    agent: z
      .looseObject({
        runsOn: AgentRunsOnSchema.nullable(),
        problem: z.string().optional(),
      })
      .optional()
      .describe("Where the agent runs, as the machine reports it."),
    readiness: AgentReadinessSchema.optional().describe("The machine's readiness."),
    error: z.string().optional().describe("Why the last check or pairing failed."),
  }),
);

export const MachinePairRequestSchema = named(
  "MachinePairRequest",
  "Body of `POST /api/machine/pair`: pair this device with the always-on machine.",
  z.strictObject({
    url: z
      .string()
      .min(1)
      .max(300)
      .refine(
        (url) => normalizeMachineUrl(url) !== null,
        "must be https://<host>[:port] without path, query or credentials (plain http only to loopback)",
      )
      .describe("`https://<tailnet name>[:port]`; case and a trailing `/` are normalized."),
    code: PairingCodeInputSchema,
    name: DeviceNameInputSchema.optional().describe("Default: the first label of the host."),
  }),
);
