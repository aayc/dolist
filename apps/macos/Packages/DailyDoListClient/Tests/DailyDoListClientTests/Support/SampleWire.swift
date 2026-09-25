import DailyDoListModels
import Foundation

/// Synthetic wire values for tests.
enum SampleWire {
  static let note = NoteResponse(
    path: "Ideas.md", content: "theirs", version: "9f8e7d6c5b4a39", mtime: 1_790_000_000_000)

  static let record = TaskAgentRecord(
    taskId: "tsk_1", notePath: "Daily/2026-09-23.md", date: "2026-09-23", text: "Book a table",
    line: 2, status: .waitingApproval, summary: "Needs approval", threadId: "thr_1",
    updatedAt: 1_790_000_000_000, unread: 1)

  static let approval = ApprovalRequest(
    id: "apr_1", threadId: "thr_1", taskId: "tsk_1", toolName: "browser_click", toolLabel: "Click",
    input: ["element": "Book button"], summary: "Click “Book”", risk: .high, categories: [.booking],
    reason: "Books in your name", status: .pending, createdAt: 1_790_000_002_000,
    expiresAt: 1_790_043_202_000)

  static let summary = ThreadSummary(
    id: "thr_1", taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "Book a table",
    status: .working, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_005_000, messageCount: 2,
    lastMessagePreview: "On it", artifactCount: 0, surfaces: [.browser], pendingApprovals: 1)

  static let thread = AgentThread(
    id: "thr_1", taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "Book a table",
    status: .working, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_005_000,
    messages: [
      .text(
        TextMessage(
          id: "msg_1", author: "orchestrator", createdAt: 1_790_000_001_000, role: .agent,
          text: "On it"))
    ])

  static let status = AgentStatusResponse(
    mode: .live, enabled: true, model: "test/model", running: 1, queued: 0, pendingApprovals: 1,
    connectors: [ConnectorStatus(name: "mail", transport: .http, state: .connected, toolCount: 3)],
    execution: ExecutionStatus(
      provider: "local",
      capabilities: ExecutionCapabilities(shell: true, browser: true, computer: false)))

  static let health = HealthResponse(
    version: "0.1.0", apiVersion: 1, vaultName: "Test Vault", agentMode: .live)

  static let routine = Routine(
    id: "rtn_0a1b2c3d4e5f60", path: "Routines/Morning briefing.md", name: "Morning briefing",
    schedule: "every weekday at 7:30", scheduleText: "Every weekday at 7:30 AM", notify: .always,
    uses: [.web], instructions: "Brief me for the day.", nextRunAt: 1_790_749_800_000,
    lastRun: RoutineRun(
      threadId: "thr_r1", trigger: .schedule, status: .done, startedAt: 1_790_663_400_000,
      finishedAt: 1_790_663_460_000, summary: "3 meetings"),
    runCount: 12, extraRunsLeft: 5)

  static let template = RoutineTemplate(
    id: "morning-briefing", name: "Morning briefing", description: "Your day at a glance.",
    schedule: "every weekday at 7:30", uses: [.web], instructions: "Brief me for the day.")

  static let runSummary = ThreadSummary(
    id: "thr_r1", taskId: "run_1", notePath: "Routines/Morning briefing.md",
    title: "Morning briefing", status: .done, createdAt: 1_790_663_400_000,
    updatedAt: 1_790_663_460_000, messageCount: 3, artifactCount: 0, surfaces: [],
    pendingApprovals: 0, routineId: "rtn_0a1b2c3d4e5f60")

  static let device = DeviceSettingsResponse(
    device: .init(id: "dev_laptop", name: "Work laptop"), placement: .alwaysOnMachine,
    remoteHosts: ["laptop.tailnet-name.ts.net"],
    sync: DeviceSyncSetup(url: "https://sync.example.com", vault: "vault_1", hasToken: true),
    lockedByEnv: [.remoteHosts])

  static let syncStatus = SyncStatusResponse(
    state: .idle, target: .remote, lastSyncedAt: 1_790_000_000_000, pendingChanges: 0,
    conflicts: [], remoteHost: "sync.example.com", deviceName: "Work laptop")

  static let pairingCode = PairingCodeResponse(
    code: "ABCD2345", expiresAt: 1_790_000_300_000, url: "https://laptop.tailnet-name.ts.net")

  static let pairedDevice = PairedDevice(
    id: "pdv_1", name: "Phone", kind: .app, createdAt: 1_790_000_000_000,
    lastSeenAt: 1_790_000_060_000)

  static let machine = MachineStatusResponse(
    machine: AlwaysOnMachine(name: "vm-name", url: "https://vm-name.tailnet-name.ts.net"),
    paired: true, reachable: true, checkedAt: 1_790_000_000_000, version: "0.1.0",
    agent: .init(
      runsOn: AgentRunsOn(
        deviceId: "dev_vm", name: "vm-name", thisDevice: false, alwaysOnMachine: true)),
    readiness: AgentReadiness(
      harness: .init(kind: .cursor, ready: true), modelCredential: true, browser: true,
      computer: .unsupported, connectors: .init(configured: 2, connected: 2)))
}
