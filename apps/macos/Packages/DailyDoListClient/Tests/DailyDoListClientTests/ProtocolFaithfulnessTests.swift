import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Everything the fake daemon produces, and every request the HTTP client sends, must conform to
/// the contract (checked against the generated JSON Schema in exact mode and the golden fixtures).
struct ProtocolFaithfulnessTests {
  static let today = "Daily/2026-09-23.md"

  /// Every response, error body and event of a session that exercises the whole API.
  struct Session {
    var events: [ServerEvent] = []
    var responses: [(schema: String, value: JSONValue)] = []

    mutating func record(_ value: some Encodable, as schema: String) throws {
      responses.append((schema, try JSONValue(encoding: value)))
    }

    mutating func recordError(_ body: () async throws -> Void) async throws {
      do {
        try await body()
        Issue.record("expected an error")
      } catch let error as DaemonClientError {
        switch error {
        case .conflict(let conflict): try record(conflict, as: "ConflictResponse")
        case .approvalConflict(let conflict): try record(conflict, as: "ApprovalConflictResponse")
        case .http(_, let body?): try record(body, as: "ApiErrorBody")
        case .pairingRejected(let message):
          try record(ApiErrorBody(error: .pairingRejected, message: message), as: "ApiErrorBody")
        default: Issue.record("unexpected error \(error)")
        }
      }
    }
  }

  static func fullSession() async throws -> Session {
    let client = InMemoryDaemonClient(seed: .demo, clock: .manual(), clientId: "macos_test")
    var session = Session()
    let recorder = StreamRecorder(client.events())
    await client.connect()

    try session.record(try await client.health(), as: "HealthResponse")
    try session.record(try await client.tree(), as: "VaultTreeResponse")
    let daily = try await client.dailyNote("today", create: true)
    try session.record(daily, as: "DailyNoteResponse")
    try session.record(
      try await client.dailyNote("2026-09-25", create: true), as: "DailyNoteResponse")
    try session.record(try await client.readNote(Self.today), as: "NoteResponse")
    let content =
      daily.content
      + "Browse for a quiet dishwasher\n- [ ] Order a new kettle\n- [ ] Send the invoice to Sam\n"
    try session.record(
      try await client.writeNote(Self.today, content: content, baseVersion: .match(daily.version)),
      as: "WriteNoteResponse")
    try await session.recordError {
      _ = try await client.writeNote(Self.today, content: "x", baseVersion: .match("stale"))
    }
    try await session.recordError { _ = try await client.readNote("missing.md") }
    try await session.recordError {
      _ = try await client.updateSettings(SettingsPatch(editor: .init(fontSize: 99)))
    }

    await client.advance(by: .milliseconds(1200 + 700))
    for record in try await client.taskRecords(notePath: Self.today) {
      if let threadId = record.threadId {
        await client.send(.surfaceSubscribe(threadId: threadId, surface: .browser))
      }
    }
    await client.runUntilIdle()
    let records = try await client.taskRecords(notePath: Self.today)
    try session.record(TaskRecordsResponse(records: records), as: "TaskRecordsResponse")
    let pending = try await client.approvals(status: .pending)
    try session.record(ApprovalListResponse(approvals: pending), as: "ApprovalListResponse")
    #expect(pending.count == 2)
    let approved = try await client.decideApproval(
      pending[0].id, ApprovalDecisionRequest(decision: .approve, scope: .task))
    try session.record(ApprovalResponse(approval: approved), as: "ApprovalResponse")
    let denied = try await client.decideApproval(
      pending[1].id, ApprovalDecisionRequest(decision: .deny, note: "Not now"))
    try session.record(ApprovalResponse(approval: denied), as: "ApprovalResponse")
    try await session.recordError {
      _ = try await client.decideApproval(
        pending[1].id, ApprovalDecisionRequest(decision: .approve))
    }
    await client.runUntilIdle()

    for summary in try await client.threads(notePath: nil, taskId: nil) {
      let thread = try await client.thread(summary.id)
      try session.record(thread, as: "ThreadResponse")
      for artifact in thread.thread.artifacts {
        let payload = try await client.artifact(threadId: summary.id, artifactId: artifact.id)
        #expect(payload.mimeType == artifact.mimeType && payload.data.count == artifact.size)
      }
    }
    let threadId = try #require(records.first?.threadId)
    try session.record(
      try await client.postMessage(threadId: threadId, text: "Thanks"), as: "ThreadActionResponse")
    try session.record(try await client.retryThread(threadId), as: "ThreadActionResponse")
    await client.advance(by: .milliseconds(1000))
    try session.record(try await client.cancelThread(threadId), as: "ThreadActionResponse")
    await client.send(.threadRead(threadId: threadId))
    await client.runUntilIdle()
    try session.record(
      ThreadListResponse(threads: try await client.threads(notePath: Self.today, taskId: nil)),
      as: "ThreadListResponse")

    try session.record(try await client.routines(), as: "RoutineListResponse")
    let routine = try await client.createRoutine(
      CreateRoutineRequest(
        name: "Tea time", schedule: "every day at 16:00", instructions: "Remind me to rest.",
        notify: .always, uses: [.web]))
    try session.record(RoutineResponse(routine: routine), as: "RoutineResponse")
    try await session.recordError {
      _ = try await client.createRoutine(
        CreateRoutineRequest(name: "Tea time", schedule: "hourly", instructions: "x"))
    }
    try await session.recordError {
      _ = try await client.createRoutine(
        CreateRoutineRequest(name: "Later", schedule: "whenever", instructions: "x"))
    }
    let run = try await client.runRoutine(routine.id)
    try session.record(run, as: "RoutineRunResponse")
    try await session.recordError { _ = try await client.runRoutine(routine.id) }
    await client.runUntilIdle()
    try session.record(
      RoutineResponse(routine: try await client.pauseRoutine(routine.id)), as: "RoutineResponse")
    try session.record(
      RoutineResponse(routine: try await client.resumeRoutine(routine.id)), as: "RoutineResponse")
    try session.record(
      RoutineResponse(routine: try await client.routine(routine.id)), as: "RoutineResponse")
    try session.record(
      ThreadListResponse(threads: try await client.threads(routineId: routine.id)),
      as: "ThreadListResponse")
    try session.record(try await client.thread(run.threadId), as: "ThreadResponse")

    try session.record(try await client.search("kettle", limit: nil), as: "SearchResponse")
    try session.record(
      try await client.rename(from: "Ideas.md", to: "Archive/Ideas.md"), as: "RenameResponse")
    try session.record(
      try await client.rename(from: "Projects", to: "Work/Projects"), as: "RenameResponse")
    try await session.recordError {
      _ = try await client.rename(from: "Welcome.md", to: "Archive/Ideas.md")
    }
    try session.record(try await client.createFolder("Inbox/Later"), as: "CreateFolderResponse")
    try session.record(try await client.deleteNote("Welcome.md"), as: "TrashResponse")
    try session.record(try await client.deleteFolder("Work"), as: "TrashResponse")
    try await client.simulateExternalEdit("Outside.md", content: "- [ ] Research lamps")
    try session.record(
      SettingsResponse(settings: try await client.updateSettings(SettingsPatch(theme: .dark))),
      as: "SettingsResponse")
    try session.record(try await client.setAgentEnabled(false), as: "AgentStatusResponse")
    try session.record(
      ConnectorsResponse(connectors: try await client.connectors()), as: "ConnectorsResponse")
    try session.record(try await client.agentStatus(), as: "AgentStatusResponse")

    // This device, pairing and the always-on machine.
    try session.record(try await client.syncStatus(), as: "SyncStatusResponse")
    try session.record(try await client.deviceSettings(), as: "DeviceSettingsResponse")
    try session.record(
      try await client.updateDeviceSettings(
        DeviceSettingsPatch(name: "Studio Mac", remoteHosts: ["studio.tailnet-name.ts.net"])),
      as: "DeviceSettingsResponse")
    try await session.recordError {
      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(remoteHosts: ["10.0.0.1"]))
    }
    try session.record(
      try await client.setUpSync(
        DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_1", token: "t0k3n")),
      as: "DeviceSettingsResponse")
    try session.record(try await client.syncStatus(), as: "SyncStatusResponse")
    try session.record(try await client.machineStatus(), as: "MachineStatusResponse")
    try session.record(
      try await client.pairMachine(
        MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net", code: "ABCD2345")),
      as: "MachineStatusResponse")
    try session.record(try await client.checkMachine(), as: "MachineStatusResponse")
    _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .alwaysOnMachine))
    try session.record(try await client.agentStatus(), as: "AgentStatusResponse")
    await client.advance(by: .seconds(3))
    try session.record(try await client.agentStatus(), as: "AgentStatusResponse")
    await client.simulateMachine(reachable: false)
    try session.record(try await client.checkMachine(), as: "MachineStatusResponse")
    try await session.recordError { _ = try await client.retryThread(threadId) }
    await client.simulateMachine(reachable: true)
    let code = try await client.createPairingCode(PairingCodeRequest(name: "Phone"))
    try session.record(code, as: "PairingCodeResponse")
    try session.record(
      try await client.pair(PairRequest(code: code.code, name: "Phone", kind: .app)),
      as: "PairResponse")
    try await session.recordError {
      _ = try await client.pair(PairRequest(code: code.code, name: "Phone", kind: .app))
    }
    try session.record(
      PairedDevicesResponse(devices: try await client.pairedDevices()), as: "PairedDevicesResponse"
    )
    try await session.recordError { try await client.revokeDevice("pdv_missing") }
    try session.record(try await client.forgetMachine(), as: "MachineStatusResponse")
    try session.record(try await client.turnOffSync(), as: "DeviceSettingsResponse")

    await client.disconnect()
    try await recorder.waitForFinish()
    session.events = recorder.events
    return session
  }

  @Test func everythingTheFakeProducesConformsExactly() async throws {
    let schema = try WireSchema.load()
    let session = try await Self.fullSession()
    #expect(session.events.count > 200)
    let types = Set(session.events.map(\.type))
    #expect(
      types == [
        "hello", "vault.changed", "task.records", "task.record", "thread.upsert", "thread.message",
        "thread.delta",
        "approval.upsert", "agent.status", "surface.frame", "settings.changed", "routines.changed",
        "routine.notification",
      ])
    for event in session.events {
      let issues = schema.validate(event, as: "ServerEvent")
      #expect(issues.isEmpty, "\(event.type): \(issues)")
    }
    for (name, value) in session.responses {
      let issues = schema.validate(value, as: name)
      #expect(issues.isEmpty, "\(name): \(issues)")
    }
    #expect(Set(session.responses.map(\.schema)).count >= 20)
  }

  @Test func fakeOutputRoundTripsThroughTheSwiftModels() async throws {
    let session = try await Self.fullSession()
    for event in session.events {
      let data = try JSONEncoder.daemon.encode(event)
      #expect(try JSONDecoder.daemon.decode(ServerEvent.self, from: data) == event)
    }
  }

  /// Keys the fixtures of a type all carry must be present; any other key must be declared.
  @Test func eventKeySetsMatchTheContractFixtures() async throws {
    let schema = try WireSchema.load()
    let fixtures = try Self.fixtureValues("ServerEvent")
    let session = try await Self.fullSession()
    var compared: Set<String> = []
    for event in session.events {
      let value = try JSONValue(encoding: event)
      let samples = fixtures.filter { $0["type"] == .string(event.type) }
      guard !samples.isEmpty else { continue }
      compared.insert(event.type)
      let definition = Self.eventDefinition[event.type] ?? ""
      Self.compareKeys(value, samples, schema: schema, definition: definition, label: event.type)
      // One level down for wrapped payloads.
      for (key, definition) in [
        ("record", "TaskAgentRecord"), ("thread", "ThreadSummary"), ("approval", "ApprovalRequest"),
        ("status", "AgentStatusResponse"), ("settings", "AppSettings"),
      ] {
        guard let payload = value[key], case .object = payload else { continue }
        Self.compareKeys(
          payload, samples.compactMap { $0[key] }, schema: schema, definition: definition,
          label: "\(event.type).\(key)")
      }
      if case .threadMessage(let message) = event {
        let kind = message.message.kind
        let messageSamples = try Self.fixtureMessages().filter { $0["kind"] == .string(kind) }
        if !messageSamples.isEmpty {
          Self.compareKeys(
            try JSONValue(encoding: message.message), messageSamples, schema: schema,
            definition: Self.messageDefinition[kind] ?? "", label: "message.\(kind)")
        }
      }
    }
    #expect(compared.count >= 10, "compared \(compared.sorted())")
  }

  @Test func requestsTheHTTPClientSendsConformToTheStrictSchemas() throws {
    let schema = try WireSchema.load()
    let requests: [(String, any Encodable)] = [
      ("WriteNoteRequest", WriteNoteRequest(content: "- [ ] x", baseVersion: .unconditional)),
      ("WriteNoteRequest", WriteNoteRequest(content: "", baseVersion: .createOnly)),
      (
        "WriteNoteRequest", WriteNoteRequest(content: "Café", baseVersion: .match("0b5f3c2a91d4e7"))
      ),
      ("RenameRequest", RenameRequest(from: "a.md", to: "b.md")),
      ("CreateFolderRequest", CreateFolderRequest(path: "Projects/New")),
      ("SetAgentEnabledRequest", SetAgentEnabledRequest(enabled: false)),
      ("PostMessageRequest", PostMessageRequest(text: "Prefer mornings")),
      (
        "CreateRoutineRequest",
        CreateRoutineRequest(
          name: "Morning briefing", schedule: "every weekday at 7:30", instructions: "Brief me.")
      ),
      (
        "CreateRoutineRequest",
        CreateRoutineRequest(
          name: "Price watch", schedule: "every 2 hours", instructions: "Check the price.",
          notify: .whenChanged, uses: [.web], paused: true)
      ),
      ("ApprovalDecisionRequest", ApprovalDecisionRequest(decision: .approve)),
      (
        "ApprovalDecisionRequest",
        ApprovalDecisionRequest(decision: .deny, scope: .task, note: "no")
      ),
      ("UpdateSettingsRequest", SettingsPatch()),
      (
        "UpdateSettingsRequest",
        SettingsPatch(
          theme: .dark, editor: .init(vimMode: true), agent: .init(watch: .init(futureDays: 14)))
      ),
      (
        "UpdateSettingsRequest",
        SettingsPatch(agent: .init(harness: .cursor, cursorModel: "gpt-5.5[reasoning=high]"))
      ),
      ("DeviceSettingsPatch", DeviceSettingsPatch()),
      ("DeviceSettingsPatch", DeviceSettingsPatch(placement: .alwaysOnMachine)),
      (
        "DeviceSettingsPatch",
        DeviceSettingsPatch(name: "Work laptop", remoteHosts: ["laptop.tailnet-name.ts.net"])
      ),
      (
        "DeviceSyncSetupRequest",
        DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_1", token: "t0k3n")
      ),
      ("DeviceSyncSetupRequest", DeviceSyncSetupRequest(url: "http://127.0.0.1:7332", vault: "v")),
      ("PairingCodeRequest", PairingCodeRequest()),
      ("PairingCodeRequest", PairingCodeRequest(name: "Phone")),
      ("PairRequest", PairRequest(code: "abcd-2345", name: "Studio Mac", kind: .app)),
      (
        "MachinePairRequest",
        MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net/", code: "ABCD 2345")
      ),
      (
        "MachinePairRequest",
        MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net", code: "ABCD2345", name: "VM")
      ),
      (
        "ClientEvent",
        ClientEvent.hello(
          clientId: HTTPDaemonClient.makeClientID(),
          clientVersion: HTTPDaemonClient.defaultClientVersion)
      ),
      ("ClientEvent", ClientEvent.ping),
      ("ClientEvent", ClientEvent.surfaceSubscribe(threadId: "thr_1", surface: .browser)),
      ("ClientEvent", ClientEvent.surfaceUnsubscribe(threadId: "thr_1", surface: .computer)),
      ("ClientEvent", ClientEvent.threadRead(threadId: "thr_1")),
      ("ClientEvent", ClientEvent.editorActivity(notePath: "Daily/2026-09-23.md", line: 3)),
    ]
    for (name, request) in requests {
      let issues = schema.validate(request, as: name)
      #expect(issues.isEmpty, "\(name): \(issues)")
    }
    // The validator does reject what the daemon rejects.
    #expect(
      !schema.validate(
        ["decision": "deny", "note": nil] as JSONValue, as: "ApprovalDecisionRequest"
      ).isEmpty)
    #expect(!schema.validate(["type": "ping", "at": 1] as JSONValue, as: "ClientEvent").isEmpty)
    #expect(
      !schema.validate(["type": "thread.read", "threadId": ""] as JSONValue, as: "ClientEvent")
        .isEmpty)
    #expect(
      !schema.validate(["ok": true, "pending": false] as JSONValue, as: "ThreadActionResponse")
        .isEmpty)
  }

  @Test func contractFixturesPassTheValidator() throws {
    let schema = try WireSchema.load()
    let directory = WireSchema.contractDirectory.appendingPathComponent("fixtures/wire")
    for file in try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    where file.hasSuffix(".valid.json") {
      let name = String(file.dropLast(".valid.json".count))
      for value in try Self.fixtureValues(name) {
        #expect(
          schema.validate(value, as: name).isEmpty, "\(name): \(schema.validate(value, as: name))")
      }
    }
  }

  /// Invalid only after zod's `.trim()`, which JSON Schema can't express.
  static let trimmedCases: Set<String> = [
    "PostMessageRequest/whitespace only (trimmed to empty)", "UpdateSettingsRequest/blank model",
    "UpdateSettingsRequest/blank Cursor model",
    "UpdateSettingsRequest/blank always-on machine name", "DeviceSettingsPatch/blank name",
    "DeviceSyncSetupRequest/blank token",
    "CreateRoutineRequest/blank instructions (trimmed to empty)",
  ]

  /// The validator is strict enough to matter: it rejects every invalid fixture except the
  /// `custom` refinements (canonical vault paths) and trimmed strings JSON Schema can't express.
  @Test func contractInvalidFixturesFailTheValidator() throws {
    struct Case: Decodable {
      let name: String
      let value: JSONValue
      let code: String
    }
    let schema = try WireSchema.load()
    let directory = WireSchema.contractDirectory.appendingPathComponent("fixtures/wire")
    var checked = 0
    for file in try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    where file.hasSuffix(".invalid.json") {
      let name = String(file.dropLast(".invalid.json".count))
      let cases = try JSONDecoder().decode(
        [Case].self, from: Data(contentsOf: directory.appendingPathComponent(file)))
      for fixture in cases
      where fixture.code != "custom" && !Self.trimmedCases.contains("\(name)/\(fixture.name)") {
        #expect(
          !schema.validate(fixture.value, as: name).isEmpty,
          "\(name) — \(fixture.name) passed the validator")
        checked += 1
      }
    }
    #expect(checked > 80)
  }

  // MARK: - Helpers

  static let eventDefinition: [String: String] = [
    "hello": "ServerHelloEvent", "vault.changed": "VaultChangedEvent",
    "task.records": "TaskRecordsEvent",
    "task.record": "TaskRecordEvent", "thread.upsert": "ThreadUpsertEvent",
    "thread.message": "ThreadMessageEvent",
    "thread.delta": "ThreadDeltaEvent", "approval.upsert": "ApprovalUpsertEvent",
    "agent.status": "AgentStatusEvent",
    "surface.frame": "SurfaceFrameEvent", "settings.changed": "SettingsChangedEvent",
    "routines.changed": "RoutinesChangedEvent", "routine.notification": "RoutineNotificationEvent",
    "error": "ServerErrorEvent",
  ]

  static let messageDefinition: [String: String] = [
    "text": "TextMessage", "tool_call": "ToolCallMessage", "approval": "ApprovalMessage",
    "artifact": "ArtifactMessage",
    "status": "StatusMessage",
  ]

  /// The keys every fixture sample carries (unless the contract makes them optional) must be
  /// present; every other key must appear in a sample or be declared by the contract.
  static func compareKeys(
    _ value: JSONValue, _ samples: [JSONValue], schema: WireSchema, definition: String,
    label: String
  ) {
    let keys = value.objectKeys
    let sampleKeys = samples.map(\.objectKeys)
    let common = sampleKeys.dropFirst().reduce(sampleKeys.first ?? []) { $0.intersection($1) }
    let mandatory = common.intersection(schema.required(of: definition))
    let known = sampleKeys.reduce(schema.properties(of: definition)) { $0.union($1) }
    #expect(!mandatory.isEmpty, "\(label): nothing to compare")
    #expect(
      mandatory.isSubset(of: keys), "\(label): missing \(mandatory.subtracting(keys).sorted())")
    #expect(keys.isSubset(of: known), "\(label): unexpected \(keys.subtracting(known).sorted())")
  }

  static func fixtureValues(_ schema: String) throws -> [JSONValue] {
    let url = WireSchema.contractDirectory.appendingPathComponent(
      "fixtures/wire/\(schema).valid.json")
    let cases = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: url))
    return cases.compactMap { $0["value"] }
  }

  /// Thread messages from the fixtures (events and the ThreadResponse cases).
  static func fixtureMessages() throws -> [JSONValue] {
    var messages = try fixtureValues("ServerEvent").compactMap { $0["message"] }
    for response in try fixtureValues("ThreadResponse") {
      if case .array(let list)? = response["thread"]?["messages"] { messages += list }
    }
    return messages
  }
}
