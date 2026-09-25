/**
 * Type-level lockstep between the zod schemas and the TypeScript types in @ddl/core: for every
 * named schema, both `z.input` and `z.output` must be mutually assignable with the core type.
 * `tsc` checks these assertions (the test file is part of the package's tsconfig).
 */
import type * as core from "@ddl/core";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import {
  type API_ERROR_CODES,
  namedWireSchemas,
  REQUEST_SCHEMA_NAMES,
  type SettingsPatchSectionSchemas,
  WIRE_SCHEMAS,
  wireRegistry,
} from "../../src/wire";

/** The core type each named wire schema describes. */
interface Lockstep {
  TaskAgentStatus: core.TaskAgentStatus;
  TaskAgentRecord: core.TaskAgentRecord;
  RiskLevel: core.RiskLevel;
  ActionCategory: core.ActionCategory;
  ApprovalScope: core.ApprovalScope;
  ApprovalDecision: core.ApprovalDecision;
  ApprovalStatus: core.ApprovalStatus;
  ApprovalRequest: core.ApprovalRequest;
  ArtifactKind: core.ArtifactKind;
  ArtifactMeta: core.ArtifactMeta;
  MessageAuthor: core.MessageAuthor;
  TextMessage: core.TextMessage;
  ToolCallStatus: core.ToolCallStatus;
  ToolCallMessage: core.ToolCallMessage;
  ApprovalMessage: core.ApprovalMessage;
  ArtifactMessage: core.ArtifactMessage;
  StatusMessage: core.StatusMessage;
  ThreadMessage: core.ThreadMessage;
  SurfaceKind: core.SurfaceKind;
  OrchestratorThreadId: core.OrchestratorThreadId;
  Thread: core.Thread;
  CitedSource: core.CitedSource;
  ThreadSummary: core.ThreadSummary;
  RoutineNotify: core.RoutineNotify;
  RoutineUse: core.RoutineUse;
  RoutineRunTrigger: core.RoutineRunTrigger;
  RoutineRun: core.RoutineRun;
  Routine: core.Routine;
  RoutineTemplate: core.RoutineTemplate;
  RoutineNotification: core.RoutineNotification;
  SurfaceFrameAction: core.SurfaceFrameAction;
  SurfaceFrame: core.SurfaceFrame;
  ThemePreference: core.ThemePreference;
  EditorSettings: core.EditorSettings;
  DailyNoteSettings: core.DailyNoteSettings;
  WeeklyNoteSettings: core.WeeklyNoteSettings;
  AgentWatchWindow: core.AgentWatchWindow;
  AgentHarnessKind: core.AgentHarnessKind;
  ApprovalPolicy: core.ApprovalPolicy;
  AgentSettings: core.AgentSettings;
  AlwaysOnMachine: core.AlwaysOnMachine;
  RemoteSettings: core.RemoteSettings;
  AppSettings: core.AppSettings;
  UpdateSettingsRequest: core.UpdateSettingsRequest;
  AgentMode: core.AgentMode;
  HealthResponse: core.HealthResponse;
  VaultEntry: core.VaultEntry;
  VaultTreeResponse: core.VaultTreeResponse;
  NoteResponse: core.NoteResponse;
  WriteNoteRequest: core.WriteNoteRequest;
  WriteNoteResponse: core.WriteNoteResponse;
  RenameRequest: core.RenameRequest;
  FolderRenameResponse: core.FolderRenameResponse;
  RenameResponse: core.RenameResponse;
  CreateFolderRequest: core.CreateFolderRequest;
  CreateFolderResponse: core.CreateFolderResponse;
  TrashResponse: core.TrashResponse;
  OkResponse: core.OkResponse;
  ThreadActionResponse: core.ThreadActionResponse;
  DailyNoteResponse: core.DailyNoteResponse;
  SearchHit: core.SearchHit;
  SearchResponse: core.SearchResponse;
  SettingsResponse: core.SettingsResponse;
  ConnectorStatus: core.ConnectorStatus;
  ComputerHostApp: core.ComputerHostApp;
  ComputerAccess: core.ComputerAccess;
  ExecutionStatus: core.ExecutionStatus;
  AgentStatusResponse: core.AgentStatusResponse;
  SetAgentEnabledRequest: core.SetAgentEnabledRequest;
  TaskRecordsResponse: core.TaskRecordsResponse;
  ThreadListResponse: core.ThreadListResponse;
  ThreadResponse: core.ThreadResponse;
  PostMessageRequest: core.PostMessageRequest;
  ApprovalListResponse: core.ApprovalListResponse;
  ApprovalResponse: core.ApprovalResponse;
  ApprovalDecisionRequest: core.ApprovalDecisionRequest;
  ConnectorsResponse: core.ConnectorsResponse;
  RoutineListResponse: core.RoutineListResponse;
  RoutineResponse: core.RoutineResponse;
  CreateRoutineRequest: core.CreateRoutineRequest;
  RoutineRunResponse: core.RoutineRunResponse;
  SyncState: core.SyncState;
  SyncTargetKind: core.SyncTargetKind;
  SyncStatusResponse: core.SyncStatusResponse;
  ComputerPermissionPane: core.ComputerPermissionPane;
  ComputerPermissionsOpenRequest: core.ComputerPermissionsOpenRequest;
  AgentPlacement: core.AgentPlacement;
  AgentRunsOn: core.AgentRunsOn;
  RelayState: core.RelayState;
  AgentPlacementStatus: core.AgentPlacementStatus;
  AgentReadiness: core.AgentReadiness;
  DeviceSyncSetup: core.DeviceSyncSetup;
  DeviceSettingsResponse: core.DeviceSettingsResponse;
  DeviceSettingsPatch: core.DeviceSettingsPatch;
  DeviceSyncSetupRequest: core.DeviceSyncSetupRequest;
  PairedDeviceKind: core.PairedDeviceKind;
  PairedDevice: core.PairedDevice;
  PairingCodeRequest: core.PairingCodeRequest;
  PairingCodeResponse: core.PairingCodeResponse;
  PairRequest: core.PairRequest;
  PairResponse: core.PairResponse;
  PairedDevicesResponse: core.PairedDevicesResponse;
  MachineStatusResponse: core.MachineStatusResponse;
  MachinePairRequest: core.MachinePairRequest;
  DaemonRestart: core.DaemonRestart;
  DeviceVaultRequest: core.DeviceVaultRequest;
  DeviceVaultResponse: core.DeviceVaultResponse;
  ImportPathList: core.ImportPathList;
  ImportMove: core.ImportMove;
  ImportMoveList: core.ImportMoveList;
  ImportSkipReason: core.ImportSkipReason;
  ImportSkippedList: core.ImportSkippedList;
  AttachmentType: core.AttachmentType;
  AttachmentSummary: core.AttachmentSummary;
  ObsidianPluginSupport: core.ObsidianPluginSupport;
  ObsidianPlugin: core.ObsidianPlugin;
  ObsidianSettingsFound: core.ObsidianSettingsFound;
  DailyNotesSource: core.DailyNotesSource;
  CarryOverPlan: core.CarryOverPlan;
  ObsidianImportPreviewRequest: core.ObsidianImportPreviewRequest;
  ObsidianImportPreview: core.ObsidianImportPreview;
  ObsidianImportRequest: core.ObsidianImportRequest;
  ObsidianImportResult: core.ObsidianImportResult;
  ObsidianUpdateReport: core.ObsidianUpdateReport;
  ObsidianImportJob: core.ObsidianImportJob;
  ObsidianImportJobResponse: core.ObsidianImportJobResponse;
  ObsidianImportOrigin: core.ObsidianImportOrigin;
  ObsidianImportStatusResponse: core.ObsidianImportStatusResponse;
  ApiErrorCode: core.ApiErrorCode;
  ApiErrorBody: core.ApiErrorBody;
  ConflictResponse: core.ConflictResponse;
  ApprovalConflictResponse: core.ApprovalConflictResponse;
  VaultChangeOrigin: core.VaultChangeOrigin;
  VaultChange: core.VaultChange;
  WsErrorCode: core.WsErrorCode;
  ServerHelloEvent: core.ServerEventOf<"hello">;
  VaultChangedEvent: core.ServerEventOf<"vault.changed">;
  TaskRecordsEvent: core.ServerEventOf<"task.records">;
  TaskRecordEvent: core.ServerEventOf<"task.record">;
  ThreadUpsertEvent: core.ServerEventOf<"thread.upsert">;
  ThreadMessageEvent: core.ServerEventOf<"thread.message">;
  ThreadDeltaEvent: core.ServerEventOf<"thread.delta">;
  ApprovalUpsertEvent: core.ServerEventOf<"approval.upsert">;
  AgentStatusEvent: core.ServerEventOf<"agent.status">;
  SurfaceFrameEvent: core.ServerEventOf<"surface.frame">;
  SettingsChangedEvent: core.ServerEventOf<"settings.changed">;
  RoutinesChangedEvent: core.ServerEventOf<"routines.changed">;
  RoutineNotificationEvent: core.ServerEventOf<"routine.notification">;
  ImportProgressEvent: core.ServerEventOf<"import.progress">;
  ServerErrorEvent: core.ServerEventOf<"error">;
  ServerEvent: core.ServerEvent;
  ClientHelloEvent: core.ClientEventOf<"hello">;
  ClientPingEvent: core.ClientEventOf<"ping">;
  SurfaceSubscribeEvent: core.ClientEventOf<"surface.subscribe">;
  SurfaceUnsubscribeEvent: core.ClientEventOf<"surface.unsubscribe">;
  ThreadReadEvent: core.ClientEventOf<"thread.read">;
  EditorActivityEvent: core.ClientEventOf<"editor.activity">;
  ClientEvent: core.ClientEvent;
}

/** Drops index signatures (zod's loose objects add `[k: string]: unknown`), recursively. */
type Plain<T> = T extends readonly (infer E)[]
  ? Plain<E>[]
  : T extends object
    ? {
        [K in keyof T as string extends K ? never : number extends K ? never : K]: Plain<T[K]>;
      }
    : T;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Schemas = typeof WIRE_SCHEMAS;
type InSync<K extends keyof Lockstep> =
  Mutual<Plain<z.output<Schemas[K]>>, Lockstep[K]> extends true
    ? Mutual<Plain<z.input<Schemas[K]>>, Lockstep[K]>
    : false;
/** Names whose schema and core type drifted apart (`never` when all are in sync). */
type OutOfSync = { [K in keyof Lockstep]: InSync<K> extends true ? never : K }[keyof Lockstep];

describe("schema ⇄ core type lockstep", () => {
  test("every named schema has a core counterpart and vice versa", () => {
    expectTypeOf<keyof Lockstep>().toEqualTypeOf<keyof Schemas>();
  });

  test("z.input and z.output of every schema are mutually assignable with the core type", () => {
    // On drift, the type error on this line names the schemas that are out of sync.
    const drifted: never = undefined as unknown as OutOfSync;
    expect(drifted).toBeUndefined();
    expectTypeOf<OutOfSync>().toEqualTypeOf<never>();
  });

  test("the lockstep check itself catches drift", () => {
    type Loose = z.ZodObject<{ a: z.ZodOptional<z.ZodString> }>;
    expectTypeOf<Mutual<Plain<z.output<Loose>>, { a: string }>>().toEqualTypeOf<false>();
    expectTypeOf<Mutual<"a" | "b", "a">>().toEqualTypeOf<false>();
    expectTypeOf<Mutual<{ a: string | null }, { a: string }>>().toEqualTypeOf<false>();
  });

  test("the settings patch sections are exactly the AppSettings sections", () => {
    expectTypeOf<keyof typeof SettingsPatchSectionSchemas>().toEqualTypeOf<
      keyof core.AppSettings
    >();
  });

  test("the error code list is exactly ApiErrorCode", () => {
    expectTypeOf<(typeof API_ERROR_CODES)[number]>().toEqualTypeOf<core.ApiErrorCode>();
  });
});

describe("schema catalog", () => {
  test("WIRE_SCHEMAS lists exactly the registered schemas, under their registry ids", () => {
    const registered = namedWireSchemas.map((entry) => entry.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect(Object.keys(WIRE_SCHEMAS).sort()).toEqual([...registered].sort());
    for (const [name, schema] of Object.entries(WIRE_SCHEMAS)) {
      expect(wireRegistry.get(schema)?.id, name).toBe(name);
    }
  });

  test("request schemas are named in the catalog", () => {
    for (const name of REQUEST_SCHEMA_NAMES) expect(WIRE_SCHEMAS).toHaveProperty(name);
  });
});
