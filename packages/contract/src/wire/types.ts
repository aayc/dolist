/**
 * The wire protocol's TypeScript types, inferred from the schemas: the one definition every client
 * and the daemon use. `@ddl/core` re-exports this module type-only, so code imports these types
 * from `@ddl/core`. Enums whose values core owns (`AgentHarnessKind`, `ApprovalPolicy`,
 * `OrchestratorThreadId`) are declared there and only checked here.
 */
import type { WireType } from "./infer";

// Domain
export type TaskAgentStatus = WireType<"TaskAgentStatus">;
export type TaskAgentRecord = WireType<"TaskAgentRecord">;
export type RiskLevel = WireType<"RiskLevel">;
export type ActionCategory = WireType<"ActionCategory">;
export type ApprovalScope = WireType<"ApprovalScope">;
export type ApprovalDecision = WireType<"ApprovalDecision">;
export type ApprovalStatus = WireType<"ApprovalStatus">;
export type ApprovalRequest = WireType<"ApprovalRequest">;
export type ArtifactKind = WireType<"ArtifactKind">;
export type ArtifactMeta = WireType<"ArtifactMeta">;
export type MessageAuthor = WireType<"MessageAuthor">;
export type TextMessage = WireType<"TextMessage">;
export type ToolCallStatus = WireType<"ToolCallStatus">;
export type ToolCallMessage = WireType<"ToolCallMessage">;
export type ApprovalMessage = WireType<"ApprovalMessage">;
export type ArtifactMessage = WireType<"ArtifactMessage">;
export type StatusMessage = WireType<"StatusMessage">;
export type ThreadMessage = WireType<"ThreadMessage">;
export type ThreadMessageKind = ThreadMessage["kind"];
export type SurfaceKind = WireType<"SurfaceKind">;
export type OrchestratorPhase = WireType<"OrchestratorPhase">;
export type OrchestratorTriggerKind = WireType<"OrchestratorTriggerKind">;
export type OrchestratorTrigger = WireType<"OrchestratorTrigger">;
export type OrchestratorOutcomeKind = WireType<"OrchestratorOutcomeKind">;
export type OrchestratorOutcome = WireType<"OrchestratorOutcome">;
export type OrchestratorActivity = WireType<"OrchestratorActivity">;
export type Thread = WireType<"Thread">;
export type CitedSource = WireType<"CitedSource">;
export type ThreadSummary = WireType<"ThreadSummary">;
export type RoutineNotify = WireType<"RoutineNotify">;
export type RoutineUse = WireType<"RoutineUse">;
export type RoutineRunTrigger = WireType<"RoutineRunTrigger">;
export type RoutineRun = WireType<"RoutineRun">;
export type Routine = WireType<"Routine">;
export type RoutineTemplate = WireType<"RoutineTemplate">;
export type RoutineNotification = WireType<"RoutineNotification">;
export type SurfaceFrameAction = WireType<"SurfaceFrameAction">;
export type SurfaceFrame = WireType<"SurfaceFrame">;

// Settings
export type ThemePreference = WireType<"ThemePreference">;
export type EditorSettings = WireType<"EditorSettings">;
export type DailyNoteSettings = WireType<"DailyNoteSettings">;
export type WeeklyNoteSettings = WireType<"WeeklyNoteSettings">;
export type AgentWatchWindow = WireType<"AgentWatchWindow">;
export type AgentSettings = WireType<"AgentSettings">;
export type AlwaysOnMachine = WireType<"AlwaysOnMachine">;
export type RemoteSettings = WireType<"RemoteSettings">;
export type AppSettings = WireType<"AppSettings">;
export type UpdateSettingsRequest = WireType<"UpdateSettingsRequest">;

// REST
export type AgentMode = WireType<"AgentMode">;
export type HealthResponse = WireType<"HealthResponse">;
export type VaultEntry = WireType<"VaultEntry">;
export type VaultTreeResponse = WireType<"VaultTreeResponse">;
export type NoteResponse = WireType<"NoteResponse">;
export type WriteNoteRequest = WireType<"WriteNoteRequest">;
export type WriteNoteResponse = WireType<"WriteNoteResponse">;
export type RenameRequest = WireType<"RenameRequest">;
export type FolderRenameResponse = WireType<"FolderRenameResponse">;
export type RenameResponse = WireType<"RenameResponse">;
export type CreateFolderRequest = WireType<"CreateFolderRequest">;
export type CreateFolderResponse = WireType<"CreateFolderResponse">;
export type TrashResponse = WireType<"TrashResponse">;
export type OkResponse = WireType<"OkResponse">;
export type ThreadActionResponse = WireType<"ThreadActionResponse">;
export type DailyNoteResponse = WireType<"DailyNoteResponse">;
export type SearchHit = WireType<"SearchHit">;
export type SearchResponse = WireType<"SearchResponse">;
export type SettingsResponse = WireType<"SettingsResponse">;
export type ConnectorStatus = WireType<"ConnectorStatus">;
export type ComputerHostApp = WireType<"ComputerHostApp">;
export type ComputerAccess = WireType<"ComputerAccess">;
export type ExecutionStatus = WireType<"ExecutionStatus">;
export type AgentStatusResponse = WireType<"AgentStatusResponse">;
export type SetAgentEnabledRequest = WireType<"SetAgentEnabledRequest">;
export type SetAgentEnabledResponse = AgentStatusResponse;
export type TaskRecordsResponse = WireType<"TaskRecordsResponse">;
export type ThreadListResponse = WireType<"ThreadListResponse">;
export type ThreadResponse = WireType<"ThreadResponse">;
export type PostMessageRequest = WireType<"PostMessageRequest">;
export type ApprovalListResponse = WireType<"ApprovalListResponse">;
export type ApprovalResponse = WireType<"ApprovalResponse">;
export type ApprovalDecisionRequest = WireType<"ApprovalDecisionRequest">;
export type ConnectorsResponse = WireType<"ConnectorsResponse">;
export type RoutineListResponse = WireType<"RoutineListResponse">;
export type RoutineResponse = WireType<"RoutineResponse">;
export type CreateRoutineRequest = WireType<"CreateRoutineRequest">;
export type RoutineRunResponse = WireType<"RoutineRunResponse">;
export type SyncState = WireType<"SyncState">;
export type SyncTargetKind = WireType<"SyncTargetKind">;
export type SyncStatusResponse = WireType<"SyncStatusResponse">;
export type ComputerPermissionPane = WireType<"ComputerPermissionPane">;
export type ComputerPermissionsOpenRequest = WireType<"ComputerPermissionsOpenRequest">;

// Placement, device settings, pairing, the always-on machine
export type AgentPlacement = WireType<"AgentPlacement">;
export type AgentRunsOn = WireType<"AgentRunsOn">;
export type RelayState = WireType<"RelayState">;
export type AgentPlacementStatus = WireType<"AgentPlacementStatus">;
export type AgentReadiness = WireType<"AgentReadiness">;
export type DeviceSyncSetup = WireType<"DeviceSyncSetup">;
export type DeviceSettingsResponse = WireType<"DeviceSettingsResponse">;
export type DeviceSettingsPatch = WireType<"DeviceSettingsPatch">;
export type DeviceSyncSetupRequest = WireType<"DeviceSyncSetupRequest">;
export type PairedDeviceKind = WireType<"PairedDeviceKind">;
export type PairedDevice = WireType<"PairedDevice">;
export type PairingCodeRequest = WireType<"PairingCodeRequest">;
export type PairingCodeResponse = WireType<"PairingCodeResponse">;
export type PairRequest = WireType<"PairRequest">;
export type PairResponse = WireType<"PairResponse">;
export type PairedDevicesResponse = WireType<"PairedDevicesResponse">;
export type MachineStatusResponse = WireType<"MachineStatusResponse">;
export type MachinePairRequest = WireType<"MachinePairRequest">;

// Switching vaults, importing from Obsidian
export type DaemonRestart = WireType<"DaemonRestart">;
export type DeviceVaultRequest = WireType<"DeviceVaultRequest">;
export type DeviceVaultResponse = WireType<"DeviceVaultResponse">;
export type ImportPathList = WireType<"ImportPathList">;
export type ImportMove = WireType<"ImportMove">;
export type ImportMoveList = WireType<"ImportMoveList">;
export type ImportSkipReason = WireType<"ImportSkipReason">;
export type ImportSkippedList = WireType<"ImportSkippedList">;
export type ImportSkipped = ImportSkippedList["items"][number];
export type AttachmentType = WireType<"AttachmentType">;
export type AttachmentSummary = WireType<"AttachmentSummary">;
export type ObsidianPluginSupport = WireType<"ObsidianPluginSupport">;
export type ObsidianPlugin = WireType<"ObsidianPlugin">;
export type ObsidianSettingsFound = WireType<"ObsidianSettingsFound">;
export type ObsidianEditorSettings = ObsidianSettingsFound["editor"];
export type DailyNotesSource = WireType<"DailyNotesSource">;
export type CarryOverPlan = WireType<"CarryOverPlan">;
export type CarryOverAgent = CarryOverPlan["agent"];
export type ObsidianImportPreviewRequest = WireType<"ObsidianImportPreviewRequest">;
export type ObsidianImportPreview = WireType<"ObsidianImportPreview">;
export type ObsidianImportRequest = WireType<"ObsidianImportRequest">;
export type ObsidianImportResult = WireType<"ObsidianImportResult">;
export type ObsidianUpdateReport = WireType<"ObsidianUpdateReport">;
export type ObsidianImportJob = WireType<"ObsidianImportJob">;
export type ObsidianImportJobKind = ObsidianImportJob["kind"];
export type ObsidianImportPhase = ObsidianImportJob["phase"];
export type ObsidianImportJobResponse = WireType<"ObsidianImportJobResponse">;
export type ObsidianImportOrigin = WireType<"ObsidianImportOrigin">;
export type ObsidianImportStatusResponse = WireType<"ObsidianImportStatusResponse">;

// Errors
export type ApiErrorCode = WireType<"ApiErrorCode">;
export type ApiErrorBody = WireType<"ApiErrorBody">;
export type ConflictResponse = WireType<"ConflictResponse">;
export type ApprovalConflictResponse = WireType<"ApprovalConflictResponse">;

// WebSocket
export type VaultChangeOrigin = WireType<"VaultChangeOrigin">;
export type VaultChange = WireType<"VaultChange">;
export type WsErrorCode = WireType<"WsErrorCode">;
export type ServerEvent = WireType<"ServerEvent">;
export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
/** A server event's fields without its `type` tag. */
export type ServerEventPayload<T extends ServerEventType> = Omit<ServerEventOf<T>, "type">;
export type ClientEvent = WireType<"ClientEvent">;
