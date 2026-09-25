/**
 * fast-check arbitraries for every named wire schema: realistic values mixed with edge cases
 * (unicode, empty-but-valid strings, maximum sizes, every enum value). Every generated value is
 * valid for its schema and survives a JSON round trip unchanged.
 */
import type * as core from "@ddl/core";
import { ORCHESTRATOR_THREAD_ID } from "@ddl/core";
import fc from "fast-check";
import type { WireSchemaName } from "../wire/catalog";
import { API_ERROR_CODES } from "../wire/errors";
import { WIRE_LIMITS } from "../wire/primitives";
import { SETTINGS_RANGES } from "../wire/settings";
import type { WireType } from "../wire/types";
import * as p from "./primitives";

type Arb<T> = fc.Arbitrary<T>;

const enumOf = <T extends string>(...values: T[]) => fc.constantFrom(...values);
const maybe = <T>(arb: Arb<T>) => fc.option(arb, { nil: null, freq: 4 });

const TASK_STATUSES: core.TaskAgentStatus[] = [
  "idle",
  "triaging",
  "queued",
  "working",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
  "ignored",
];
const ACTION_CATEGORIES: core.ActionCategory[] = [
  "read",
  "compute",
  "network",
  "file_write",
  "browser_input",
  "form_submission",
  "computer_control",
  "communication",
  "publishing",
  "payment",
  "booking",
  "account",
  "credentials",
  "privacy",
  "destructive",
  "system",
  "unknown",
];

// ── Domain ────────────────────────────────────────────────────────────────

const taskAgentStatus = () => enumOf(...TASK_STATUSES);
const riskLevel = () => enumOf<core.RiskLevel>("low", "medium", "high", "critical");
const actionCategory = () => enumOf(...ACTION_CATEGORIES);
const approvalScope = () => enumOf<core.ApprovalScope>("once", "task", "always");
const approvalDecision = () => enumOf<core.ApprovalDecision>("approve", "deny");
const approvalStatus = () =>
  enumOf<core.ApprovalStatus>("pending", "approved", "denied", "expired", "cancelled");
const artifactKind = () =>
  enumOf<core.ArtifactKind>("markdown", "code", "html", "image", "json", "text", "file");
const surfaceKind = () => enumOf<core.SurfaceKind>("browser", "computer");
const toolCallStatus = () => enumOf<core.ToolCallStatus>("running", "ok", "error", "blocked");
const toolName = () =>
  fc.oneof(
    {
      weight: 4,
      arbitrary: enumOf(
        "web_search",
        "browser_click",
        "read_note",
        "mock_irreversible_action",
        "mcp__mail__send",
      ),
    },
    { weight: 1, arbitrary: fc.constant("t".repeat(WIRE_LIMITS.nameLength)) },
  );

const messageAuthor = (): Arb<core.MessageAuthor> =>
  fc.oneof(
    enumOf<core.MessageAuthor>("you", "orchestrator", "system"),
    fc
      .oneof(
        enumOf("researcher", "browser", "operator", "builder", "assistant"),
        p.lengthWithin(fc.string({ minLength: 1, maxLength: 100 }), 1, 100),
      )
      .map((name): core.MessageAuthor => `subagent:${name}`),
  );

const taskAgentRecord = (): Arb<core.TaskAgentRecord> =>
  fc.record(
    {
      taskId: p.id("tsk"),
      notePath: p.notePath(),
      date: maybe(p.isoDate()),
      text: p.text(),
      line: p.count(),
      status: taskAgentStatus(),
      summary: p.text(300),
      threadId: maybe(p.runtimeId("thr")),
      updatedAt: p.epochMs(),
      unread: p.count(50),
      anchor: fc.constant("line" as const),
    },
    {
      requiredKeys: [
        "taskId",
        "notePath",
        "date",
        "text",
        "line",
        "status",
        "threadId",
        "updatedAt",
        "unread",
      ],
    },
  );

const approvalRequest = (): Arb<core.ApprovalRequest> =>
  fc.record(
    {
      id: p.runtimeId("apr"),
      threadId: maybe(p.runtimeId("thr")),
      taskId: maybe(p.id("tsk")),
      toolName: toolName(),
      toolLabel: p.label(),
      input: p.toolInput(),
      summary: p.text(500),
      risk: riskLevel(),
      categories: fc.uniqueArray(actionCategory(), { maxLength: 4 }),
      reason: p.text(500),
      status: approvalStatus(),
      scope: approvalScope(),
      decisionNote: p.text(WIRE_LIMITS.decisionNoteChars),
      createdAt: p.epochMs(),
      decidedAt: p.epochMs(),
      expiresAt: p.epochMs(),
    },
    {
      requiredKeys: [
        "id",
        "threadId",
        "taskId",
        "toolName",
        "input",
        "summary",
        "risk",
        "categories",
        "reason",
        "status",
        "createdAt",
      ],
    },
  );

const MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
  "image/png",
  "application/octet-stream",
];

const artifactMeta = (threadId?: Arb<string>): Arb<core.ArtifactMeta> =>
  fc.record(
    {
      id: p.runtimeId("art"),
      threadId: threadId ?? p.runtimeId("thr"),
      title: p.label(),
      kind: artifactKind(),
      mimeType: enumOf(...MIME_TYPES),
      language: enumOf("ts", "python", "json", ""),
      path: p.vaultPath(),
      size: p.count(10_000_000),
      createdAt: p.epochMs(),
    },
    { requiredKeys: ["id", "threadId", "title", "kind", "mimeType", "path", "size", "createdAt"] },
  );

const base = () => ({ id: p.id("msg"), author: messageAuthor(), createdAt: p.epochMs() });

const textMessage = (): Arb<core.TextMessage> =>
  fc.record(
    {
      ...base(),
      kind: fc.constant("text" as const),
      role: enumOf<core.TextMessage["role"]>("agent", "user", "system"),
      text: p.text(),
      streaming: fc.boolean(),
    },
    { requiredKeys: ["id", "author", "createdAt", "kind", "role", "text"] },
  );

const toolCallMessage = (): Arb<core.ToolCallMessage> =>
  fc.record(
    {
      ...base(),
      kind: fc.constant("tool_call" as const),
      toolCallId: p.id("call"),
      toolName: toolName(),
      label: p.label(),
      input: p.toolInput(),
      status: toolCallStatus(),
      resultPreview: p.text(500),
      endedAt: p.epochMs(),
    },
    {
      requiredKeys: [
        "id",
        "author",
        "createdAt",
        "kind",
        "toolCallId",
        "toolName",
        "input",
        "status",
      ],
    },
  );

const approvalMessage = (): Arb<core.ApprovalMessage> =>
  fc.record({ ...base(), kind: fc.constant("approval" as const), approvalId: p.runtimeId("apr") });

const artifactMessage = (): Arb<core.ArtifactMessage> =>
  fc.record({ ...base(), kind: fc.constant("artifact" as const), artifactId: p.runtimeId("art") });

const statusMessage = (): Arb<core.StatusMessage> =>
  fc.record(
    {
      ...base(),
      kind: fc.constant("status" as const),
      status: taskAgentStatus(),
      text: p.text(300),
    },
    { requiredKeys: ["id", "author", "createdAt", "kind", "status"] },
  );

const threadMessage = (): Arb<core.ThreadMessage> =>
  fc.oneof(textMessage(), toolCallMessage(), approvalMessage(), artifactMessage(), statusMessage());

const surfaces = () => fc.subarray<core.SurfaceKind>(["browser", "computer"]);

const orchestratorThreadId = (): Arb<core.OrchestratorThreadId> =>
  fc.constant(ORCHESTRATOR_THREAD_ID);

const threadBase = () => ({
  id: fc.oneof(
    { weight: 9, arbitrary: p.runtimeId("thr") },
    { weight: 1, arbitrary: orchestratorThreadId() },
  ),
  taskId: maybe(p.id("tsk")),
  notePath: maybe(p.notePath()),
  title: p.text(300),
  status: taskAgentStatus(),
  createdAt: p.epochMs(),
  updatedAt: p.epochMs(),
  surfaces: surfaces(),
  routineId: p.runtimeId("rtn"),
});

const citedSource = (): Arb<core.CitedSource> =>
  fc.record(
    { url: fc.webUrl(), title: p.text(120), snippet: p.text(300) },
    { requiredKeys: ["url"] },
  );

const thread = (): Arb<core.Thread> =>
  fc
    .record(
      {
        ...threadBase(),
        messages: fc.array(threadMessage(), { maxLength: 8 }),
        artifacts: fc.array(artifactMeta(), { maxLength: 3 }),
        sources: fc.array(citedSource(), { maxLength: 3 }),
      },
      {
        requiredKeys: [
          "id",
          "taskId",
          "notePath",
          "title",
          "status",
          "createdAt",
          "updatedAt",
          "surfaces",
          "messages",
          "artifacts",
        ],
      },
    )
    .map((t) => ({ ...t, artifacts: t.artifacts.map((a) => ({ ...a, threadId: t.id })) }));

const threadSummary = (): Arb<core.ThreadSummary> =>
  fc.record(
    {
      ...threadBase(),
      messageCount: p.count(),
      lastMessagePreview: p.text(200),
      artifactCount: p.count(20),
      pendingApprovals: p.count(5),
    },
    {
      requiredKeys: [
        "id",
        "taskId",
        "notePath",
        "title",
        "status",
        "createdAt",
        "updatedAt",
        "surfaces",
        "messageCount",
        "artifactCount",
        "pendingApprovals",
      ],
    },
  );

const surfaceFrameAction = (): Arb<core.SurfaceFrameAction> =>
  fc.record(
    {
      kind: enumOf("click", "type", "scroll", "navigate", "key", "screenshot"),
      x: p.finiteNumber(0, 16_384),
      y: p.finiteNumber(0, 16_384),
      text: p.text(200),
    },
    { requiredKeys: ["kind"] },
  );

/** 1×1 grey JPEG (the web mock's fallback frame). */
export const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const frameSide = () =>
  fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 1, max: 2560 }) },
    { weight: 1, arbitrary: fc.constantFrom(1, WIRE_LIMITS.frameSide) },
  );

const surfaceFrameFields = () => ({
  threadId: p.runtimeId("thr"),
  surface: surfaceKind(),
  mimeType: enumOf<core.SurfaceFrame["mimeType"]>("image/jpeg", "image/png"),
  data: fc.oneof(p.base64(), fc.constant(TINY_JPEG_BASE64)),
  width: frameSide(),
  height: frameSide(),
  url: fc.oneof(fc.webUrl(), fc.constantFrom("about:blank", "")),
  title: p.label(),
  action: surfaceFrameAction(),
  ts: p.epochMs(),
});

const SURFACE_FRAME_REQUIRED = [
  "threadId",
  "surface",
  "mimeType",
  "data",
  "width",
  "height",
  "ts",
] as const;

const surfaceFrame = (): Arb<core.SurfaceFrame> =>
  fc.record(surfaceFrameFields(), { requiredKeys: [...SURFACE_FRAME_REQUIRED] });

// ── Settings ──────────────────────────────────────────────────────────────

const intIn = (r: { min: number; max: number }) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.integer(r) },
    { weight: 1, arbitrary: fc.constantFrom(r.min, r.max) },
  );

const themePreference = () => enumOf<core.ThemePreference>("system", "light", "dark");

const fontSize = () =>
  fc.oneof(
    intIn(SETTINGS_RANGES.fontSize),
    fc.double({
      min: SETTINGS_RANGES.fontSize.min,
      max: SETTINGS_RANGES.fontSize.max,
      noNaN: true,
    }),
  );

const vimrc = () =>
  fc.oneof(
    fc.constantFrom("", 'imap jj <Esc>\n" comment\nset clipboard=unnamed', "nmap j gj\nnmap k gk"),
    p.text(SETTINGS_RANGES.vimrcLength),
  );

const editorSettings = (): Arb<core.EditorSettings> =>
  fc.record({
    vimMode: fc.boolean(),
    vimrc: vimrc(),
    livePreview: fc.boolean(),
    readableLineLength: fc.boolean(),
    fontSize: fontSize(),
    spellcheck: fc.boolean(),
    showLineNumbers: fc.boolean(),
  });

const periodicNoteSettings = (defaults: core.DailyNoteSettings) =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(defaults) },
    {
      weight: 2,
      arbitrary: fc.record({
        folder: fc.oneof(
          fc.constantFrom("", "Daily", "Journal/Daily", "日记"),
          p.text(SETTINGS_RANGES.folderLength),
        ),
        format: fc.oneof(
          fc.constantFrom("YYYY-MM-DD", "YYYY/MM/YYYY-MM-DD", "gggg-[W]ww", "dddd, MMMM Do YYYY"),
          p.text(SETTINGS_RANGES.formatLength),
        ),
        template: fc.oneof(
          fc.constantFrom("", "Templates/Daily.md", "Templates/Daily"),
          p.text(SETTINGS_RANGES.templateLength),
        ),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.constant({
        folder: "f".repeat(SETTINGS_RANGES.folderLength),
        format: "Y".repeat(SETTINGS_RANGES.formatLength),
        template: "t".repeat(SETTINGS_RANGES.templateLength),
      }),
    },
  );

const dailyNoteSettings = () =>
  periodicNoteSettings({ folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily.md" });
const weeklyNoteSettings = () =>
  periodicNoteSettings({ folder: "Weekly", format: "gggg-[W]ww", template: "Templates/Weekly.md" });

const agentWatchWindow = (): Arb<core.AgentWatchWindow> =>
  fc.record({
    pastDays: intIn(SETTINGS_RANGES.watchDays),
    futureDays: intIn(SETTINGS_RANGES.watchDays),
  });

const agentHarnessKind = () => enumOf<core.AgentHarnessKind>("pi", "cursor");

const approvalPolicy = () =>
  enumOf<core.ApprovalPolicy>("ask_every_action", "ask_risky", "ask_high_risk", "run_everything");

const agentSettings = (): Arb<core.AgentSettings> =>
  fc.record({
    enabled: fc.boolean(),
    settleMs: intIn(SETTINGS_RANGES.settleMs),
    maxConcurrentSubagents: intIn(SETTINGS_RANGES.maxConcurrentSubagents),
    harness: agentHarnessKind(),
    model: p.modelId(),
    cursorModel: p.cursorModelId(),
    judgeModel: p.modelId(),
    watch: agentWatchWindow(),
    actOnExistingTasks: fc.boolean(),
    approvalTimeoutMs: intIn(SETTINGS_RANGES.approvalTimeoutMs),
    approvalPolicy: approvalPolicy(),
  });

const alwaysOnMachine = (): Arb<core.AlwaysOnMachine> =>
  fc.record({ name: p.deviceName(), url: p.machineUrl() });

const remoteSettings = (): Arb<core.RemoteSettings> =>
  fc.record({ alwaysOnMachine: maybe(alwaysOnMachine()) });

const appSettings = (): Arb<core.AppSettings> =>
  fc.record({
    theme: themePreference(),
    editor: editorSettings(),
    dailyNotes: dailyNoteSettings(),
    weeklyNotes: weeklyNoteSettings(),
    agent: agentSettings(),
    remote: remoteSettings(),
  });

/** Every key optional, recursively (absent keys, never `undefined` values). */
const partialOf = <T extends object>(arbs: { [K in keyof T]: Arb<T[K]> }) =>
  fc.record(arbs, { requiredKeys: [] }) as Arb<Partial<T>>;

const updateSettingsRequest = (): Arb<core.UpdateSettingsRequest> =>
  fc.record(
    {
      theme: themePreference(),
      editor: partialOf<core.EditorSettings>({
        vimMode: fc.boolean(),
        vimrc: vimrc(),
        livePreview: fc.boolean(),
        readableLineLength: fc.boolean(),
        fontSize: fontSize(),
        spellcheck: fc.boolean(),
        showLineNumbers: fc.boolean(),
      }),
      dailyNotes: dailyNoteSettings().chain((s) =>
        partialOf<core.DailyNoteSettings>({
          folder: fc.constant(s.folder),
          format: fc.constant(s.format),
          template: fc.constant(s.template),
        }),
      ),
      weeklyNotes: weeklyNoteSettings().chain((s) =>
        partialOf<core.WeeklyNoteSettings>({
          folder: fc.constant(s.folder),
          format: fc.constant(s.format),
          template: fc.constant(s.template),
        }),
      ),
      agent: fc.record(
        {
          enabled: fc.boolean(),
          settleMs: intIn(SETTINGS_RANGES.settleMs),
          maxConcurrentSubagents: intIn(SETTINGS_RANGES.maxConcurrentSubagents),
          harness: agentHarnessKind(),
          model: p.modelId(),
          cursorModel: p.cursorModelId(),
          judgeModel: p.modelId(),
          watch: partialOf<core.AgentWatchWindow>({
            pastDays: intIn(SETTINGS_RANGES.watchDays),
            futureDays: intIn(SETTINGS_RANGES.watchDays),
          }),
          actOnExistingTasks: fc.boolean(),
          approvalTimeoutMs: intIn(SETTINGS_RANGES.approvalTimeoutMs),
          approvalPolicy: approvalPolicy(),
        },
        { requiredKeys: [] },
      ),
      remote: partialOf<core.RemoteSettings>({ alwaysOnMachine: maybe(alwaysOnMachine()) }),
    },
    { requiredKeys: [] },
  );

// ── REST ──────────────────────────────────────────────────────────────────

const agentMode = () => enumOf<core.AgentMode>("live", "mock", "off");
const vaultName = () =>
  fc.oneof(fc.constantFrom("Memory vault", "My Vault", "Notes ☕", ""), p.text(100));

const healthResponse = (): Arb<core.HealthResponse> =>
  fc.record({
    ok: fc.constant(true as const),
    version: fc.constantFrom("0.1.0", "1.2.3-beta.1", "mock-0.1.0"),
    apiVersion: fc.integer({ min: 1, max: 3 }),
    vaultName: vaultName(),
    agentMode: agentMode(),
  });

const vaultEntry = (): Arb<core.VaultEntry> =>
  fc.oneof(
    fc.record({ path: p.folderPath(), kind: fc.constant("folder" as const) }),
    fc.record(
      {
        path: p.vaultPath(),
        kind: fc.constant("file" as const),
        size: p.count(10_000_000),
        mtime: p.epochMs(),
        version: p.contentVersion(),
      },
      { requiredKeys: ["path", "kind"] },
    ),
  );

const vaultTreeResponse = (): Arb<core.VaultTreeResponse> =>
  fc.record({ vaultName: vaultName(), entries: fc.array(vaultEntry(), { maxLength: 10 }) });

const MARKDOWN = [
  "",
  "- [ ] ",
  "- [ ] Find a dentist\n- [x] Paid rent\n",
  "# Title\n\nSome *markdown* with [[links]] and #tags\n",
  "---\ntags: [a, b]\n---\n- [ ] Book a table 🍽️\n  - prefer mornings\n",
];

const noteContent = () =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...MARKDOWN) },
    { weight: 2, arbitrary: p.text(5_000) },
  );

const noteResponse = (): Arb<core.NoteResponse> =>
  fc.record({
    path: p.notePath(),
    content: noteContent(),
    version: p.contentVersion(),
    mtime: p.epochMs(),
  });

const writeNoteRequest = (): Arb<core.WriteNoteRequest> =>
  fc.record(
    { content: noteContent(), baseVersion: fc.option(p.contentVersion(), { nil: null }) },
    { requiredKeys: ["content"] },
  );

const writeNoteResponse = (): Arb<core.WriteNoteResponse> =>
  fc.record({ path: p.notePath(), version: p.contentVersion(), mtime: p.epochMs() });

const requestPath = () =>
  fc.oneof(
    { weight: 6, arbitrary: p.notePath() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "Daily//2026-09-23.md",
        "./a.md",
        "a\\b.md",
        "p".repeat(WIRE_LIMITS.requestPathLength),
      ),
    },
  );

const renameRequest = (): Arb<core.RenameRequest> =>
  fc.record({ from: requestPath(), to: requestPath() });
const folderRenameResponse = (): Arb<core.FolderRenameResponse> =>
  fc.record({ path: p.folderPath(), moved: p.count(1_000) });
const renameResponse = (): Arb<core.RenameResponse> =>
  fc.oneof(writeNoteResponse(), folderRenameResponse());
const createFolderRequest = (): Arb<core.CreateFolderRequest> =>
  fc.record({ path: fc.oneof(p.folderPath(), requestPath()) });
const createFolderResponse = (): Arb<core.CreateFolderResponse> =>
  fc.record({ path: p.folderPath() });
const trashResponse = (): Arb<core.TrashResponse> =>
  fc.record({
    ok: fc.constant(true as const),
    trashedTo: p.vaultPath().map((path) => `.trash/${path}`),
  });
const okResponse = (): Arb<core.OkResponse> => fc.record({ ok: fc.constant(true as const) });
const threadActionResponse = (): Arb<core.ThreadActionResponse> =>
  fc.record(
    { ok: fc.constant(true as const), pending: fc.constant(true as const) },
    { requiredKeys: ["ok"] },
  );

const dailyNoteResponse = (): Arb<core.DailyNoteResponse> =>
  fc.record({
    path: p.notePath(),
    content: noteContent(),
    version: p.contentVersion(),
    mtime: p.epochMs(),
    date: p.isoDate(),
    created: fc.boolean(),
  });

const searchHit = (): Arb<core.SearchHit> =>
  fc.oneof(
    fc.record({
      path: p.notePath(),
      kind: fc.constant("name" as const),
      line: fc.constant(0),
      preview: p.text(200),
    }),
    fc.record({
      path: p.notePath(),
      kind: fc.constant("content" as const),
      line: p.count(),
      preview: p.text(200),
    }),
  );

const searchResponse = (): Arb<core.SearchResponse> =>
  fc.record({ hits: fc.array(searchHit(), { maxLength: 8 }) });
const settingsResponse = (): Arb<core.SettingsResponse> => fc.record({ settings: appSettings() });

const connectorStatus = (): Arb<core.ConnectorStatus> =>
  fc.record(
    {
      name: fc.oneof(
        enumOf("mail", "calendar", "notes", "github"),
        p.lengthWithin(p.label(), 1, WIRE_LIMITS.nameLength),
      ),
      transport: enumOf<core.ConnectorStatus["transport"]>("stdio", "http", "sse"),
      state: enumOf<core.ConnectorStatus["state"]>(
        "disabled",
        "idle",
        "connecting",
        "connected",
        "error",
      ),
      toolCount: p.count(100),
      error: p.text(300),
    },
    { requiredKeys: ["name", "transport", "state", "toolCount"] },
  );

const computerHostApp = (): Arb<core.ComputerHostApp> =>
  fc.record(
    {
      name: fc.oneof(
        enumOf("Daily Do List", "Terminal", "iTerm", "Cursor"),
        p.lengthWithin(p.label(), 1, WIRE_LIMITS.nameLength),
      ),
      path: enumOf(
        "/Applications/Daily Do List.app",
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Cursor.app",
      ),
      bundleId: enumOf("app.dailydolist.mac", "com.apple.Terminal", "com.example.editor"),
    },
    { requiredKeys: ["name"] },
  );

const computerAccess = (): Arb<core.ComputerAccess> =>
  fc.record(
    {
      accessibility: fc.boolean(),
      screenRecording: fc.boolean(),
      appControl: fc.boolean(),
      hostApp: computerHostApp(),
    },
    { requiredKeys: ["accessibility", "screenRecording", "appControl"] },
  );

const executionStatus = (): Arb<core.ExecutionStatus> =>
  fc.record(
    {
      provider: enumOf("local", "cloud", "none", "fake", "mock"),
      capabilities: fc.record({
        shell: fc.boolean(),
        browser: fc.boolean(),
        computer: fc.boolean(),
      }),
      computerAccess: computerAccess(),
    },
    { requiredKeys: ["provider", "capabilities"] },
  );

const computerPermissionPane = () =>
  enumOf<core.ComputerPermissionPane>("accessibility", "screenRecording");
const computerPermissionsOpenRequest = (): Arb<core.ComputerPermissionsOpenRequest> =>
  fc.record({ pane: computerPermissionPane() });

const agentStatusResponse = (): Arb<core.AgentStatusResponse> =>
  fc.record(
    {
      mode: agentMode(),
      enabled: fc.boolean(),
      model: p.modelId(),
      running: p.count(32),
      queued: p.count(100),
      pendingApprovals: p.count(20),
      connectors: fc.array(connectorStatus(), { maxLength: 4 }),
      execution: executionStatus(),
      problem: p.text(500),
      placement: agentPlacementStatus(),
      readiness: agentReadiness(),
    },
    {
      requiredKeys: [
        "mode",
        "enabled",
        "model",
        "running",
        "queued",
        "pendingApprovals",
        "connectors",
        "execution",
      ],
    },
  );

const setAgentEnabledRequest = (): Arb<core.SetAgentEnabledRequest> =>
  fc.record({ enabled: fc.boolean() });
const taskRecordsResponse = (): Arb<core.TaskRecordsResponse> =>
  fc.record({ records: fc.array(taskAgentRecord(), { maxLength: 6 }) });
const threadListResponse = (): Arb<core.ThreadListResponse> =>
  fc.record({ threads: fc.array(threadSummary(), { maxLength: 6 }) });
const threadResponse = (): Arb<core.ThreadResponse> =>
  fc.record({ thread: thread(), approvals: fc.array(approvalRequest(), { maxLength: 3 }) });
const postMessageRequest = (): Arb<core.PostMessageRequest> =>
  fc.record({ text: p.trimmedText(WIRE_LIMITS.userMessageChars) });
const approvalListResponse = (): Arb<core.ApprovalListResponse> =>
  fc.record({ approvals: fc.array(approvalRequest(), { maxLength: 4 }) });
const approvalResponse = (): Arb<core.ApprovalResponse> =>
  fc.record({ approval: approvalRequest() });
const approvalDecisionRequest = (): Arb<core.ApprovalDecisionRequest> =>
  fc.record(
    {
      decision: approvalDecision(),
      scope: approvalScope(),
      note: p.text(WIRE_LIMITS.decisionNoteChars),
    },
    { requiredKeys: ["decision"] },
  );
const connectorsResponse = (): Arb<core.ConnectorsResponse> =>
  fc.record({ connectors: fc.array(connectorStatus(), { maxLength: 4 }) });

// ── Routines ──────────────────────────────────────────────────────────────

const ROUTINE_USES: core.RoutineUse[] = [
  "web",
  "browser",
  "computer",
  "shell",
  "files",
  "connectors",
];
const routineNotify = () => enumOf<core.RoutineNotify>("always", "when_changed", "never");
const routineUse = () => enumOf(...ROUTINE_USES);
const routineRunTrigger = () => enumOf<core.RoutineRunTrigger>("schedule", "catch_up", "manual");
const schedulePhrase = () =>
  fc.oneof(
    { weight: 4, arbitrary: enumOf("every weekday at 7:30", "every 2 hours", "hourly") },
    { weight: 1, arbitrary: p.text(200) },
  );
const routineName = () =>
  fc.oneof(
    { weight: 4, arbitrary: enumOf("Morning briefing", "Price watch", "Café ☕ digest") },
    { weight: 1, arbitrary: p.segment() },
  );

const routineRun = (): Arb<core.RoutineRun> =>
  fc.record(
    {
      threadId: p.runtimeId("thr"),
      trigger: routineRunTrigger(),
      status: taskAgentStatus(),
      startedAt: p.epochMs(),
      finishedAt: p.epochMs(),
      summary: p.text(200),
      changed: fc.boolean(),
    },
    { requiredKeys: ["threadId", "trigger", "status", "startedAt"] },
  );

const routine = (): Arb<core.Routine> =>
  fc
    .record(
      {
        id: p.runtimeId("rtn"),
        name: routineName(),
        schedule: schedulePhrase(),
        scheduleText: p.text(200),
        notify: routineNotify(),
        uses: fc.uniqueArray(routineUse(), { maxLength: 6 }),
        paused: fc.boolean(),
        instructions: p.text(),
        error: p.text(300),
        nextRunAt: p.epochMs(),
        lastRun: routineRun(),
        runCount: p.count(500),
        extraRunsLeft: p.count(5),
      },
      {
        requiredKeys: [
          "id",
          "name",
          "schedule",
          "notify",
          "uses",
          "paused",
          "instructions",
          "runCount",
          "extraRunsLeft",
        ],
      },
    )
    .map((r) => ({ ...r, path: `Routines/${r.name}.md` }));

const routineTemplate = (): Arb<core.RoutineTemplate> =>
  fc.record({
    id: p.id("tpl"),
    name: routineName(),
    description: p.text(200),
    schedule: p.lengthWithin(schedulePhrase(), 1, 200),
    notify: routineNotify(),
    uses: fc.uniqueArray(routineUse(), { maxLength: 6 }),
    instructions: p.lengthWithin(p.text(), 1, 10_000),
  });

const routineNotification = (): Arb<core.RoutineNotification> =>
  fc.record({
    routineId: p.runtimeId("rtn"),
    title: routineName(),
    body: p.text(300),
    threadId: p.runtimeId("thr"),
    status: taskAgentStatus(),
    at: p.epochMs(),
  });

const routineListResponse = (): Arb<core.RoutineListResponse> =>
  fc.record({
    routines: fc.array(routine(), { maxLength: 4 }),
    templates: fc.array(routineTemplate(), { maxLength: 3 }),
  });
const routineResponse = (): Arb<core.RoutineResponse> => fc.record({ routine: routine() });
const createRoutineRequest = (): Arb<core.CreateRoutineRequest> =>
  fc.record(
    {
      name: routineName(),
      schedule: p.trimmedText(200),
      instructions: p.trimmedText(8_000),
      notify: routineNotify(),
      uses: fc.uniqueArray(routineUse(), { maxLength: 6 }),
      paused: fc.boolean(),
    },
    { requiredKeys: ["name", "schedule", "instructions"] },
  );
const routineRunResponse = (): Arb<core.RoutineRunResponse> =>
  fc.record({ routine: routine(), threadId: p.runtimeId("thr") });

// ── Sync ──────────────────────────────────────────────────────────────────

const syncState = () => enumOf<core.SyncState>("idle", "syncing", "error", "disabled");
const syncTargetKind = () => enumOf<core.SyncTargetKind>("none", "local", "s3", "remote");
const syncStatusResponse = (): Arb<core.SyncStatusResponse> =>
  fc.record(
    {
      state: syncState(),
      target: syncTargetKind(),
      lastSyncedAt: maybe(p.epochMs()),
      pendingChanges: p.count(10_000),
      conflicts: fc.array(
        p.notePath().map((path) => path.replace(/(\.[^./]+)?$/, " (conflict 2026-09-24 0915)$1")),
        { maxLength: 3 },
      ),
      lastError: p.text(300),
      remoteHost: enumOf("sync.example.com", "127.0.0.1:7332", "[::1]:8443", "notes.example.org"),
      deviceName: p.lengthWithin(p.label(), 1, 100),
    },
    { requiredKeys: ["state", "target", "lastSyncedAt", "pendingChanges", "conflicts"] },
  );

// ── Placement, device settings, pairing, the always-on machine ────────────

const agentPlacement = () =>
  enumOf<core.AgentPlacement>("this_device", "always_on_machine", "always_on_host");
const relayState = () =>
  enumOf<core.RelayState>("off", "connecting", "connected", "unreachable", "not_paired");

const agentRunsOn = (): Arb<core.AgentRunsOn> =>
  fc.record({
    deviceId: p.syncDeviceId(),
    name: p.syncDeviceName(),
    thisDevice: fc.boolean(),
    alwaysOnMachine: fc.boolean(),
  });

const PLACEMENT_NOTES = ["Taking over from vm-1…", "Handing the agent to vm-1…", ""];

function agentPlacementStatus(): Arb<core.AgentPlacementStatus> {
  return fc.record(
    {
      placement: agentPlacement(),
      heldHere: enumOf<NonNullable<core.AgentPlacementStatus["heldHere"]>>("no_machine", "no_sync"),
      runsOn: maybe(agentRunsOn()),
      relay: relayState(),
      note: fc.oneof(fc.constantFrom(...PLACEMENT_NOTES), p.text(200)),
    },
    { requiredKeys: ["placement", "runsOn", "relay"] },
  );
}

function agentReadiness(): Arb<core.AgentReadiness> {
  return fc.record({
    harness: fc.record(
      {
        kind: agentHarnessKind(),
        ready: fc.boolean(),
        problem: fc.oneof(
          fc.constantFrom("The Cursor CLI isn't signed in", "OPENROUTER_API_KEY is not set"),
          p.text(300),
        ),
      },
      { requiredKeys: ["kind", "ready"] },
    ),
    modelCredential: fc.boolean(),
    browser: fc.boolean(),
    computer: enumOf<core.AgentReadiness["computer"]>(
      "available",
      "needs_permissions",
      "unsupported",
    ),
    connectors: fc.record({ configured: p.count(20), connected: p.count(20) }),
  });
}

const syncUrl = () =>
  enumOf(
    "https://sync.example.com",
    "https://vm-name.tailnet-name.ts.net:8443",
    "https://sync.example.com/ddl",
    "http://127.0.0.1:7332",
  );

const deviceSyncSetup = (): Arb<core.DeviceSyncSetup> =>
  fc.oneof(
    fc.record({ url: syncUrl(), vault: p.syncDeviceId(), hasToken: fc.boolean() }),
    fc.record({ url: fc.constant(null), vault: fc.constant(null), hasToken: fc.boolean() }),
  );

const LOCKABLE: Array<core.DeviceSettingsResponse["lockedByEnv"][number]> = [
  "placement",
  "remoteHosts",
  "sync",
];

const remoteHosts = () =>
  fc.oneof(
    { weight: 6, arbitrary: fc.uniqueArray(p.remoteHost(), { maxLength: 3 }) },
    {
      weight: 1,
      arbitrary: fc.constant(Array.from({ length: 8 }, (_, i) => `vm-${i}.tailnet-name.ts.net`)),
    },
  );

const deviceSettingsResponse = (): Arb<core.DeviceSettingsResponse> =>
  fc.record({
    device: fc.record({ id: p.syncDeviceId(), name: p.syncDeviceName() }),
    placement: agentPlacement(),
    remoteHosts: remoteHosts(),
    sync: deviceSyncSetup(),
    lockedByEnv: fc.subarray(LOCKABLE),
  });

const deviceSettingsPatch = (): Arb<core.DeviceSettingsPatch> =>
  fc.record(
    { name: p.deviceName(), placement: agentPlacement(), remoteHosts: remoteHosts() },
    { requiredKeys: [] },
  );

const deviceSyncSetupRequest = (): Arb<core.DeviceSyncSetupRequest> =>
  fc.record(
    {
      url: syncUrl(),
      vault: p.syncDeviceId(),
      token: fc.oneof(
        fc.string({ unit: fc.constantFrom(..."abcXYZ0189_-"), minLength: 43, maxLength: 43 }),
        fc.constantFrom("t", "k".repeat(1024)),
      ),
    },
    { requiredKeys: ["url", "vault"] },
  );

const pairedDeviceKind = () => enumOf<core.PairedDeviceKind>("browser", "app", "daemon");

const pairedDevice = (): Arb<core.PairedDevice> =>
  fc.record(
    {
      id: p.runtimeId("pdv"),
      name: p.deviceName(),
      kind: pairedDeviceKind(),
      createdAt: p.epochMs(),
      lastSeenAt: maybe(p.epochMs()),
      current: fc.boolean(),
    },
    { requiredKeys: ["id", "name", "kind", "createdAt", "lastSeenAt"] },
  );

const pairingCodeRequest = (): Arb<core.PairingCodeRequest> =>
  fc.record({ name: p.deviceName() }, { requiredKeys: [] });

const pairingCodeResponse = (): Arb<core.PairingCodeResponse> =>
  fc.record({
    code: p.pairingCode(),
    expiresAt: p.epochMs(),
    url: maybe(p.machineUrl().filter((url) => url.startsWith("https://"))),
  });

const pairRequest = (): Arb<core.PairRequest> =>
  fc.record({ code: p.pairingCodeInput(), name: p.deviceName(), kind: pairedDeviceKind() });

const deviceToken = () =>
  fc.oneof(
    fc.string({ unit: fc.constantFrom(..."abcXYZ0189_-"), minLength: 43, maxLength: 43 }),
    fc.constantFrom("t".repeat(16), "T".repeat(512)),
  );

const pairResponse = (): Arb<core.PairResponse> =>
  fc.record({ device: pairedDevice(), token: deviceToken() }, { requiredKeys: ["device"] });

const pairedDevicesResponse = (): Arb<core.PairedDevicesResponse> =>
  fc.record({ devices: fc.array(pairedDevice(), { maxLength: 5 }) });

const machineStatusResponse = (): Arb<core.MachineStatusResponse> =>
  fc.record(
    {
      machine: maybe(alwaysOnMachine()),
      paired: fc.boolean(),
      reachable: maybe(fc.boolean()),
      checkedAt: maybe(p.epochMs()),
      version: fc.constantFrom("0.1.0", "1.2.3-beta.1", "v".repeat(100)),
      agent: fc.record(
        { runsOn: maybe(agentRunsOn()), problem: p.text(300) },
        { requiredKeys: ["runsOn"] },
      ),
      readiness: agentReadiness(),
      error: fc.oneof(fc.constantFrom("The machine didn't answer in 5 s"), p.text(300)),
    },
    { requiredKeys: ["machine", "paired", "reachable", "checkedAt"] },
  );

const machinePairRequest = (): Arb<core.MachinePairRequest> =>
  fc.record(
    {
      url: fc.oneof(
        p.machineUrl(),
        p.machineUrl().map((url) => `${url}/`),
        p.machineUrl().map((url) => url.toUpperCase()),
      ),
      code: p.pairingCodeInput(),
      name: p.deviceName(),
    },
    { requiredKeys: ["url", "code"] },
  );

// ── Switching vaults, importing from Obsidian ─────────────────────────────

const folder = () =>
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.constantFrom("/Users/me/DailyDoList", "/Volumes/Notes/Café ☕ vault"),
    },
    { weight: 1, arbitrary: p.folderPath().map((path) => `/${path}`) },
    { weight: 1, arbitrary: fc.constant(`/${"v".repeat(WIRE_LIMITS.responsePathLength - 1)}`) },
  );
const folderInput = () =>
  fc.oneof(
    fc.constantFrom("/Users/me/Obsidian/Notebook", "~/Obsidian/Notebook", "~/Documents/Vault ☕"),
    p.folderPath().map((path) => `/${path}`),
    fc.constant(`/${"v".repeat(WIRE_LIMITS.requestPathLength - 1)}`),
  );
const reportPath = () =>
  fc.oneof(
    { weight: 4, arbitrary: p.vaultPath() },
    { weight: 1, arbitrary: fc.constantFrom(".obsidian/app.json", "back\\slash.md", "__proto__") },
  );
const bounded = <T>(item: Arb<T>) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.array(item, { maxLength: 4 }) },
    { weight: 1, arbitrary: fc.array(item, { minLength: 200, maxLength: 200 }) },
  );
const listCount = <T>(items: T[]) =>
  fc.integer({ min: items.length, max: items.length + 10_000 }).map((count) => ({ count, items }));

const daemonRestart = () => enumOf<core.DaemonRestart>("supervisor", "manual");

const deviceVaultRequest = (): Arb<core.DeviceVaultRequest> => fc.record({ path: folderInput() });

const deviceVaultResponse = (): Arb<core.DeviceVaultResponse> =>
  fc.record(
    { path: folder(), lockedByEnv: fc.boolean(), restart: daemonRestart() },
    { requiredKeys: ["path", "lockedByEnv"] },
  );

const importPathList = (): Arb<core.ImportPathList> =>
  bounded(reportPath())
    .chain(listCount)
    .map(({ count, items }) => ({ count, paths: items }));

const importMove = (): Arb<core.ImportMove> => fc.record({ from: reportPath(), to: reportPath() });

const importMoveList = (): Arb<core.ImportMoveList> => bounded(importMove()).chain(listCount);

const importSkipReason = () =>
  enumOf<core.ImportSkipReason>(
    "symlink_outside",
    "symlink_folder",
    "special_file",
    "unreadable",
    "sidecar",
  );

const importSkippedList = (): Arb<core.ImportSkippedList> =>
  bounded(fc.record({ path: reportPath(), reason: importSkipReason() })).chain(listCount);

const attachmentType = () => enumOf<core.AttachmentType>("image", "pdf", "audio", "video", "other");

const attachmentSummary = (): Arb<core.AttachmentSummary> =>
  fc.record({
    count: p.count(),
    bytes: fc.oneof(p.count(), fc.constant(Number.MAX_SAFE_INTEGER)),
    byType: fc.uniqueArray(
      fc.record({ type: attachmentType(), count: p.count(), bytes: p.count() }),
      { selector: (entry) => entry.type, maxLength: 5 },
    ),
  });

const obsidianPluginSupport = () =>
  enumOf<core.ObsidianPluginSupport>("supported", "partial", "unsupported", "unknown");

const obsidianPlugin = (): Arb<core.ObsidianPlugin> =>
  fc.record(
    {
      id: fc.constantFrom("dataview", "obsidian-excalidraw-plugin", "x", "p".repeat(100)),
      name: fc.constantFrom("Dataview", "Café ☕ widgets", "n".repeat(200)),
      support: obsidianPluginSupport(),
      note: fc.constantFrom("Queries show as text.", "n".repeat(500)),
    },
    { requiredKeys: ["id", "support", "note"] },
  );

const obsidianSettingsFound = (): Arb<core.ObsidianSettingsFound> =>
  fc.record(
    {
      files: fc.subarray([
        ".obsidian/daily-notes.json",
        ".obsidian/app.json",
        ".obsidian/appearance.json",
        ".obsidian.vimrc",
      ]),
      dailyNotes: maybe(dailyNoteSettings()),
      editor: fc.record(
        {
          vimMode: fc.boolean(),
          livePreview: fc.boolean(),
          readableLineLength: fc.boolean(),
          showLineNumbers: fc.boolean(),
          spellcheck: fc.boolean(),
        },
        { requiredKeys: [] },
      ),
      vimrc: fc.boolean(),
      theme: themePreference(),
    },
    { requiredKeys: ["files", "dailyNotes", "editor", "vimrc"] },
  );

const dailyNotesSource = () =>
  enumOf<core.DailyNotesSource>("obsidian", "obsidian_defaults", "daily_do_list");

const carryOverPlan = (): Arb<core.CarryOverPlan> =>
  fc.record({
    vault: folder(),
    dailyNotes: dailyNoteSettings(),
    dailyNotesFrom: dailyNotesSource(),
    notes: importMoveList(),
    daily: bounded(
      fc.record({ date: p.isoDate(), from: reportPath(), to: reportPath(), merged: fc.boolean() }),
    )
      .chain(listCount)
      .chain(({ count, items }) =>
        fc.integer({ min: 0, max: count }).map((merged) => ({ count, merged, items })),
      ),
    collisions: importMoveList(),
    routines: p.count(),
    drawings: p.count(),
    agent: fc.record({
      threads: p.count(),
      detached: p.count(),
      records: p.count(),
      approvals: p.count(),
      routines: p.count(),
      trackedNotes: p.count(),
      journal: p.count(),
    }),
    watchedOpenTasks: p.count(),
    actOnExistingTasks: fc.boolean(),
    leftBehind: importPathList(),
  });

const obsidianImportPreviewRequest = (): Arb<core.ObsidianImportPreviewRequest> =>
  fc.record({ source: folderInput() });

const obsidianImportPreview = (): Arb<core.ObsidianImportPreview> =>
  fc.record({
    source: folder(),
    defaultDestination: folder(),
    isObsidianVault: fc.boolean(),
    files: p.count(),
    bytes: p.count(),
    notes: p.count(),
    folders: p.count(),
    attachments: attachmentSummary(),
    settings: obsidianSettingsFound(),
    templates: fc.record({ folder: maybe(reportPath()), count: p.count() }),
    plugins: fc.array(obsidianPlugin(), { maxLength: 4 }),
    canvases: importPathList(),
    drawings: importPathList(),
    skipped: importSkippedList(),
    carryOver: carryOverPlan(),
    warnings: fc.array(p.trimmedText(300), { maxLength: 3 }),
  });

const obsidianImportRequest = (): Arb<core.ObsidianImportRequest> =>
  fc.record({ source: folderInput(), destination: folderInput() }, { requiredKeys: ["source"] });

const obsidianImportResult = (): Arb<core.ObsidianImportResult> =>
  fc.record({
    copied: fc.record({ files: p.count(), bytes: p.count() }),
    skipped: importSkippedList(),
    carryOver: carryOverPlan(),
    manifest: fc.constant(".daily-do-list/import/obsidian.json"),
  });

const obsidianUpdateReport = (): Arb<core.ObsidianUpdateReport> =>
  fc.record({
    added: importPathList(),
    updated: importPathList(),
    restored: importPathList(),
    conflicts: importMoveList(),
    deletedInSource: importPathList(),
    unchanged: p.count(),
    skipped: importSkippedList(),
  });

const obsidianImportJob = (): Arb<core.ObsidianImportJob> =>
  fc.record(
    {
      id: p.runtimeId("imp"),
      kind: enumOf<core.ObsidianImportJobKind>("import", "update"),
      state: enumOf<core.ObsidianImportJobState>("running", "done", "failed", "cancelled"),
      phase: enumOf<core.ObsidianImportPhase>("checking", "copying", "carrying_over", "finishing"),
      source: folder(),
      destination: folder(),
      startedAt: p.epochMs(),
      finishedAt: p.epochMs(),
      progress: fc.record({
        files: p.count(),
        totalFiles: p.count(),
        bytes: p.count(),
        totalBytes: p.count(),
      }),
      error: fc.constantFrom("The disk is full", "Notes/a.md in the current vault can't be read"),
      result: obsidianImportResult(),
      update: obsidianUpdateReport(),
    },
    {
      requiredKeys: [
        "id",
        "kind",
        "state",
        "phase",
        "source",
        "destination",
        "startedAt",
        "progress",
      ],
    },
  );

const obsidianImportJobResponse = (): Arb<core.ObsidianImportJobResponse> =>
  fc.record({ job: obsidianImportJob() });

const obsidianImportStatusResponse = (): Arb<core.ObsidianImportStatusResponse> =>
  fc.record({ job: maybe(obsidianImportJob()) });

const importProgressEvent = (): Arb<core.ServerEventOf<"import.progress">> =>
  fc.record({ type: fc.constant("import.progress" as const), job: obsidianImportJob() });

// ── Errors ────────────────────────────────────────────────────────────────

const apiErrorCode = () => enumOf<core.ApiErrorCode>(...API_ERROR_CODES);
const apiErrorBody = (): Arb<core.ApiErrorBody> =>
  fc.record({ error: apiErrorCode(), message: p.text(500) }, { requiredKeys: ["error"] });
const conflictResponse = (): Arb<core.ConflictResponse> =>
  fc.record(
    {
      error: fc.constant("conflict" as const),
      message: p.text(200),
      current: maybe(noteResponse()),
    },
    { requiredKeys: ["error", "current"] },
  );
const approvalConflictResponse = (): Arb<core.ApprovalConflictResponse> =>
  fc.record(
    {
      error: fc.constant("conflict" as const),
      message: p.text(200),
      approval: approvalRequest().filter((a) => a.status !== "pending"),
    },
    { requiredKeys: ["error", "approval"] },
  );

// ── WebSocket ─────────────────────────────────────────────────────────────

const vaultChangeOrigin = () =>
  enumOf<core.VaultChangeOrigin>("external", "client", "agent", "sync");
const vaultChange = (): Arb<core.VaultChange> =>
  fc.record(
    {
      path: p.vaultPath(),
      kind: enumOf<core.VaultChange["kind"]>("created", "modified", "deleted"),
      version: p.contentVersion(),
    },
    { requiredKeys: ["path", "kind"] },
  );
const wsErrorCode = () =>
  enumOf<core.WsErrorCode>(
    "invalid_json",
    "invalid_message",
    "binary_unsupported",
    "too_many_subscriptions",
    "subscribe_failed",
    "incompatible_api_version",
  );

type EventOf<T extends core.ServerEventType> = core.ServerEventOf<T>;

const serverHelloEvent = (): Arb<EventOf<"hello">> =>
  fc.record({
    type: fc.constant("hello" as const),
    serverVersion: fc.constantFrom("0.1.0", "mock-0.1.0", "2.0.0-rc.1"),
    apiVersion: fc.integer({ min: 1, max: 3 }),
  });
const vaultChangedEvent = (): Arb<EventOf<"vault.changed">> =>
  fc.record(
    {
      type: fc.constant("vault.changed" as const),
      changes: fc.array(vaultChange(), { minLength: 1, maxLength: 5 }),
      origin: vaultChangeOrigin(),
      clientId: p.clientId(),
    },
    { requiredKeys: ["type", "changes", "origin"] },
  );
const taskRecordsEvent = (): Arb<EventOf<"task.records">> =>
  fc.record({
    type: fc.constant("task.records" as const),
    notePath: p.notePath(),
    records: fc.array(taskAgentRecord(), { maxLength: 5 }),
  });
const taskRecordEvent = (): Arb<EventOf<"task.record">> =>
  fc.record({ type: fc.constant("task.record" as const), record: taskAgentRecord() });
const threadUpsertEvent = (): Arb<EventOf<"thread.upsert">> =>
  fc.record({ type: fc.constant("thread.upsert" as const), thread: threadSummary() });
const threadMessageEvent = (): Arb<EventOf<"thread.message">> =>
  fc.record({
    type: fc.constant("thread.message" as const),
    threadId: p.runtimeId("thr"),
    message: threadMessage(),
  });
const threadDeltaEvent = (): Arb<EventOf<"thread.delta">> =>
  fc.record({
    type: fc.constant("thread.delta" as const),
    threadId: p.runtimeId("thr"),
    messageId: p.id("msg"),
    delta: p.text(200),
  });
const approvalUpsertEvent = (): Arb<EventOf<"approval.upsert">> =>
  fc.record({ type: fc.constant("approval.upsert" as const), approval: approvalRequest() });
const agentStatusEvent = (): Arb<EventOf<"agent.status">> =>
  fc.record({ type: fc.constant("agent.status" as const), status: agentStatusResponse() });
const surfaceFrameEvent = (): Arb<EventOf<"surface.frame">> =>
  fc.record(
    { type: fc.constant("surface.frame" as const), ...surfaceFrameFields() },
    { requiredKeys: ["type", ...SURFACE_FRAME_REQUIRED] },
  );
const settingsChangedEvent = (): Arb<EventOf<"settings.changed">> =>
  fc.record({ type: fc.constant("settings.changed" as const), settings: appSettings() });
const routinesChangedEvent = (): Arb<EventOf<"routines.changed">> =>
  fc.record({
    type: fc.constant("routines.changed" as const),
    routines: fc.array(routine(), { maxLength: 4 }),
  });
const routineNotificationEvent = (): Arb<EventOf<"routine.notification">> =>
  fc.record({
    type: fc.constant("routine.notification" as const),
    notification: routineNotification(),
  });
const serverErrorEvent = (): Arb<EventOf<"error">> =>
  fc.record(
    { type: fc.constant("error" as const), message: p.text(300), code: wsErrorCode() },
    { requiredKeys: ["type", "message"] },
  );

const serverEvent = (): Arb<core.ServerEvent> =>
  fc.oneof(
    serverHelloEvent(),
    vaultChangedEvent(),
    taskRecordsEvent(),
    taskRecordEvent(),
    threadUpsertEvent(),
    threadMessageEvent(),
    threadDeltaEvent(),
    approvalUpsertEvent(),
    agentStatusEvent(),
    surfaceFrameEvent(),
    settingsChangedEvent(),
    routinesChangedEvent(),
    routineNotificationEvent(),
    importProgressEvent(),
    serverErrorEvent(),
  );

type ClientOf<T extends core.ClientEventType> = core.ClientEventOf<T>;

const clientHelloEvent = (): Arb<ClientOf<"hello">> =>
  fc.record(
    {
      type: fc.constant("hello" as const),
      clientId: p.clientId(),
      apiVersion: fc.integer({ min: 1, max: 3 }),
      clientVersion: fc.constantFrom("web/0.1.0", "ios/1.0 (42)", "v"),
    },
    { requiredKeys: ["type", "clientId"] },
  );
const clientPingEvent = (): Arb<ClientOf<"ping">> =>
  fc.record({ type: fc.constant("ping" as const) });
const surfaceSubscribeEvent = (): Arb<ClientOf<"surface.subscribe">> =>
  fc.record({
    type: fc.constant("surface.subscribe" as const),
    threadId: p.id("thr"),
    surface: surfaceKind(),
  });
const surfaceUnsubscribeEvent = (): Arb<ClientOf<"surface.unsubscribe">> =>
  fc.record({
    type: fc.constant("surface.unsubscribe" as const),
    threadId: p.id("thr"),
    surface: surfaceKind(),
  });
const threadReadEvent = (): Arb<ClientOf<"thread.read">> =>
  fc.record({ type: fc.constant("thread.read" as const), threadId: p.id("thr") });
const editorActivityEvent = (): Arb<ClientOf<"editor.activity">> =>
  fc.record({
    type: fc.constant("editor.activity" as const),
    notePath: requestPath(),
    line: p.count(),
  });

const clientEvent = (): Arb<core.ClientEvent> =>
  fc.oneof(
    clientHelloEvent(),
    clientPingEvent(),
    surfaceSubscribeEvent(),
    surfaceUnsubscribeEvent(),
    threadReadEvent(),
    editorActivityEvent(),
  );

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

// biome-ignore lint/suspicious/noExplicitAny: factories of any arity and value type
function plainFactories<T extends Record<string, (...args: any[]) => Arb<unknown>>>(
  factories: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, factory] of Object.entries(factories)) {
    out[name] = (...args: unknown[]) => factory(...args).map(toPlain);
  }
  return out as T;
}

/** One arbitrary factory per named wire schema. */
export const wireArbitraries: { [K in WireSchemaName]: () => Arb<WireType<K>> } = plainFactories({
  TaskAgentStatus: taskAgentStatus,
  TaskAgentRecord: taskAgentRecord,
  RiskLevel: riskLevel,
  ActionCategory: actionCategory,
  ApprovalScope: approvalScope,
  ApprovalDecision: approvalDecision,
  ApprovalStatus: approvalStatus,
  ApprovalRequest: approvalRequest,
  ArtifactKind: artifactKind,
  ArtifactMeta: () => artifactMeta(),
  MessageAuthor: messageAuthor,
  TextMessage: textMessage,
  ToolCallStatus: toolCallStatus,
  ToolCallMessage: toolCallMessage,
  ApprovalMessage: approvalMessage,
  ArtifactMessage: artifactMessage,
  StatusMessage: statusMessage,
  ThreadMessage: threadMessage,
  SurfaceKind: surfaceKind,
  OrchestratorThreadId: orchestratorThreadId,
  Thread: thread,
  CitedSource: citedSource,
  ThreadSummary: threadSummary,
  RoutineNotify: routineNotify,
  RoutineUse: routineUse,
  RoutineRunTrigger: routineRunTrigger,
  RoutineRun: routineRun,
  Routine: routine,
  RoutineTemplate: routineTemplate,
  RoutineNotification: routineNotification,
  SurfaceFrameAction: surfaceFrameAction,
  SurfaceFrame: surfaceFrame,
  ThemePreference: themePreference,
  EditorSettings: editorSettings,
  DailyNoteSettings: dailyNoteSettings,
  WeeklyNoteSettings: weeklyNoteSettings,
  AgentWatchWindow: agentWatchWindow,
  AgentHarnessKind: agentHarnessKind,
  ApprovalPolicy: approvalPolicy,
  AgentSettings: agentSettings,
  AlwaysOnMachine: alwaysOnMachine,
  RemoteSettings: remoteSettings,
  AppSettings: appSettings,
  UpdateSettingsRequest: updateSettingsRequest,
  AgentMode: agentMode,
  HealthResponse: healthResponse,
  VaultEntry: vaultEntry,
  VaultTreeResponse: vaultTreeResponse,
  NoteResponse: noteResponse,
  WriteNoteRequest: writeNoteRequest,
  WriteNoteResponse: writeNoteResponse,
  RenameRequest: renameRequest,
  FolderRenameResponse: folderRenameResponse,
  RenameResponse: renameResponse,
  CreateFolderRequest: createFolderRequest,
  CreateFolderResponse: createFolderResponse,
  TrashResponse: trashResponse,
  OkResponse: okResponse,
  ThreadActionResponse: threadActionResponse,
  DailyNoteResponse: dailyNoteResponse,
  SearchHit: searchHit,
  SearchResponse: searchResponse,
  SettingsResponse: settingsResponse,
  ConnectorStatus: connectorStatus,
  ComputerHostApp: computerHostApp,
  ComputerAccess: computerAccess,
  ExecutionStatus: executionStatus,
  AgentStatusResponse: agentStatusResponse,
  SetAgentEnabledRequest: setAgentEnabledRequest,
  TaskRecordsResponse: taskRecordsResponse,
  ThreadListResponse: threadListResponse,
  ThreadResponse: threadResponse,
  PostMessageRequest: postMessageRequest,
  ApprovalListResponse: approvalListResponse,
  ApprovalResponse: approvalResponse,
  ApprovalDecisionRequest: approvalDecisionRequest,
  ConnectorsResponse: connectorsResponse,
  RoutineListResponse: routineListResponse,
  RoutineResponse: routineResponse,
  CreateRoutineRequest: createRoutineRequest,
  RoutineRunResponse: routineRunResponse,
  SyncState: syncState,
  SyncTargetKind: syncTargetKind,
  SyncStatusResponse: syncStatusResponse,
  ComputerPermissionPane: computerPermissionPane,
  ComputerPermissionsOpenRequest: computerPermissionsOpenRequest,
  AgentPlacement: agentPlacement,
  AgentRunsOn: agentRunsOn,
  RelayState: relayState,
  AgentPlacementStatus: agentPlacementStatus,
  AgentReadiness: agentReadiness,
  DeviceSyncSetup: deviceSyncSetup,
  DeviceSettingsResponse: deviceSettingsResponse,
  DeviceSettingsPatch: deviceSettingsPatch,
  DeviceSyncSetupRequest: deviceSyncSetupRequest,
  PairedDeviceKind: pairedDeviceKind,
  PairedDevice: pairedDevice,
  PairingCodeRequest: pairingCodeRequest,
  PairingCodeResponse: pairingCodeResponse,
  PairRequest: pairRequest,
  PairResponse: pairResponse,
  PairedDevicesResponse: pairedDevicesResponse,
  MachineStatusResponse: machineStatusResponse,
  MachinePairRequest: machinePairRequest,
  DaemonRestart: daemonRestart,
  DeviceVaultRequest: deviceVaultRequest,
  DeviceVaultResponse: deviceVaultResponse,
  ImportPathList: importPathList,
  ImportMove: importMove,
  ImportMoveList: importMoveList,
  ImportSkipReason: importSkipReason,
  ImportSkippedList: importSkippedList,
  AttachmentType: attachmentType,
  AttachmentSummary: attachmentSummary,
  ObsidianPluginSupport: obsidianPluginSupport,
  ObsidianPlugin: obsidianPlugin,
  ObsidianSettingsFound: obsidianSettingsFound,
  DailyNotesSource: dailyNotesSource,
  CarryOverPlan: carryOverPlan,
  ObsidianImportPreviewRequest: obsidianImportPreviewRequest,
  ObsidianImportPreview: obsidianImportPreview,
  ObsidianImportRequest: obsidianImportRequest,
  ObsidianImportResult: obsidianImportResult,
  ObsidianUpdateReport: obsidianUpdateReport,
  ObsidianImportJob: obsidianImportJob,
  ObsidianImportJobResponse: obsidianImportJobResponse,
  ObsidianImportStatusResponse: obsidianImportStatusResponse,
  ApiErrorCode: apiErrorCode,
  ApiErrorBody: apiErrorBody,
  ConflictResponse: conflictResponse,
  ApprovalConflictResponse: approvalConflictResponse,
  VaultChangeOrigin: vaultChangeOrigin,
  VaultChange: vaultChange,
  WsErrorCode: wsErrorCode,
  ServerHelloEvent: serverHelloEvent,
  VaultChangedEvent: vaultChangedEvent,
  TaskRecordsEvent: taskRecordsEvent,
  TaskRecordEvent: taskRecordEvent,
  ThreadUpsertEvent: threadUpsertEvent,
  ThreadMessageEvent: threadMessageEvent,
  ThreadDeltaEvent: threadDeltaEvent,
  ApprovalUpsertEvent: approvalUpsertEvent,
  AgentStatusEvent: agentStatusEvent,
  SurfaceFrameEvent: surfaceFrameEvent,
  SettingsChangedEvent: settingsChangedEvent,
  RoutinesChangedEvent: routinesChangedEvent,
  RoutineNotificationEvent: routineNotificationEvent,
  ImportProgressEvent: importProgressEvent,
  ServerErrorEvent: serverErrorEvent,
  ServerEvent: serverEvent,
  ClientHelloEvent: clientHelloEvent,
  ClientPingEvent: clientPingEvent,
  SurfaceSubscribeEvent: surfaceSubscribeEvent,
  SurfaceUnsubscribeEvent: surfaceUnsubscribeEvent,
  ThreadReadEvent: threadReadEvent,
  EditorActivityEvent: editorActivityEvent,
  ClientEvent: clientEvent,
});

/** Arbitraries by camelCase name (`arb.thread()`, `arb.serverEvent()`), plus primitives. */
export const arb = plainFactories({
  taskAgentStatus,
  taskAgentRecord,
  riskLevel,
  actionCategory,
  approvalScope,
  approvalDecision,
  approvalStatus,
  approvalRequest,
  artifactKind,
  artifactMeta,
  messageAuthor,
  textMessage,
  toolCallStatus,
  toolCallMessage,
  approvalMessage,
  artifactMessage,
  statusMessage,
  threadMessage,
  surfaceKind,
  orchestratorThreadId,
  thread,
  threadSummary,
  surfaceFrameAction,
  surfaceFrame,
  themePreference,
  editorSettings,
  dailyNoteSettings,
  weeklyNoteSettings,
  agentWatchWindow,
  agentHarnessKind,
  approvalPolicy,
  agentSettings,
  alwaysOnMachine,
  remoteSettings,
  appSettings,
  updateSettingsRequest,
  agentMode,
  healthResponse,
  vaultEntry,
  vaultTreeResponse,
  noteResponse,
  writeNoteRequest,
  writeNoteResponse,
  renameRequest,
  folderRenameResponse,
  renameResponse,
  createFolderRequest,
  createFolderResponse,
  trashResponse,
  okResponse,
  threadActionResponse,
  dailyNoteResponse,
  searchHit,
  searchResponse,
  settingsResponse,
  connectorStatus,
  computerHostApp,
  computerAccess,
  executionStatus,
  agentStatusResponse,
  setAgentEnabledRequest,
  taskRecordsResponse,
  threadListResponse,
  threadResponse,
  postMessageRequest,
  approvalListResponse,
  approvalResponse,
  approvalDecisionRequest,
  connectorsResponse,
  routineNotify,
  routineUse,
  routineRunTrigger,
  routineRun,
  routine,
  routineTemplate,
  routineNotification,
  routineListResponse,
  routineResponse,
  createRoutineRequest,
  routineRunResponse,
  computerPermissionPane,
  computerPermissionsOpenRequest,
  agentPlacement,
  agentRunsOn,
  relayState,
  agentPlacementStatus,
  agentReadiness,
  deviceSyncSetup,
  deviceSettingsResponse,
  deviceSettingsPatch,
  deviceSyncSetupRequest,
  pairedDeviceKind,
  pairedDevice,
  pairingCodeRequest,
  pairingCodeResponse,
  pairRequest,
  pairResponse,
  pairedDevicesResponse,
  machineStatusResponse,
  machinePairRequest,
  apiErrorCode,
  apiErrorBody,
  conflictResponse,
  approvalConflictResponse,
  vaultChangeOrigin,
  vaultChange,
  wsErrorCode,
  serverHelloEvent,
  vaultChangedEvent,
  taskRecordsEvent,
  taskRecordEvent,
  threadUpsertEvent,
  threadMessageEvent,
  threadDeltaEvent,
  approvalUpsertEvent,
  agentStatusEvent,
  surfaceFrameEvent,
  settingsChangedEvent,
  routinesChangedEvent,
  routineNotificationEvent,
  deviceVaultRequest,
  deviceVaultResponse,
  obsidianImportPreview,
  obsidianImportJob,
  obsidianImportJobResponse,
  obsidianImportStatusResponse,
  importProgressEvent,
  serverErrorEvent,
  serverEvent,
  clientHelloEvent,
  clientPingEvent,
  surfaceSubscribeEvent,
  surfaceUnsubscribeEvent,
  threadReadEvent,
  editorActivityEvent,
  clientEvent,
  // Primitives
  id: p.id,
  runtimeId: p.runtimeId,
  clientId: p.clientId,
  epochMs: p.epochMs,
  count: p.count,
  isoDate: p.isoDate,
  text: p.text,
  trimmedText: p.trimmedText,
  notePath: p.notePath,
  folderPath: p.folderPath,
  vaultPath: p.vaultPath,
  requestPath,
  contentVersion: p.contentVersion,
  jsonValue: p.jsonValue,
  base64: p.base64,
  modelId: p.modelId,
  cursorModelId: p.cursorModelId,
  deviceName: p.deviceName,
  remoteHost: p.remoteHost,
  machineUrl: p.machineUrl,
  pairingCode: p.pairingCode,
});
