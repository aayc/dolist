import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// REST behavior of `HTTPDaemonClient` against a `URLProtocol` stub.
struct HTTPDaemonClientRESTTests {
  /// One protocol method: what it must send and how it decodes the answer.
  struct Operation: Sendable, CustomTestStringConvertible {
    let name: String
    let method: String
    /// Raw target (percent-encoded path + query).
    let target: String
    let body: JSONValue?
    let attributed: Bool
    let response: StubBehavior
    let call: @Sendable (HTTPDaemonClient) async throws -> any Sendable
    let verify: @Sendable (any Sendable) -> Bool

    var testDescription: String { name }
  }

  static let notePath = "Daily/Café #1 50%.md"
  static let encodedNotePath = "/api/notes/Daily/Caf%C3%A9%20%231%2050%25.md"

  static let operations: [Operation] = [
    Operation(
      name: "health", method: "GET", target: "/api/health", body: nil, attributed: false,
      response: .json(value: SampleWire.health), call: { try await $0.health() },
      verify: { ($0 as? HealthResponse) == SampleWire.health }),
    Operation(
      name: "tree", method: "GET", target: "/api/vault/tree", body: nil, attributed: false,
      response: .json(
        #"{"vaultName":"V","entries":[{"path":"Daily","kind":"folder"},{"path":"a.md","kind":"file","size":3,"mtime":1,"version":"v"}]}"#
      ),
      call: { try await $0.tree() },
      verify: { ($0 as? VaultTreeResponse)?.entries.map(\.path) == ["Daily", "a.md"] }),
    Operation(
      name: "readNote", method: "GET", target: encodedNotePath, body: nil, attributed: false,
      response: .json(value: SampleWire.note), call: { try await $0.readNote(notePath) },
      verify: { ($0 as? NoteResponse) == SampleWire.note }),
    Operation(
      name: "writeNote (match)", method: "PUT", target: encodedNotePath,
      body: ["content": "- [ ] x", "baseVersion": "v1"], attributed: true,
      response: .json(201, #"{"path":"Daily/Café #1 50%.md","version":"v2","mtime":5}"#),
      call: { try await $0.writeNote(notePath, content: "- [ ] x", baseVersion: .match("v1")) },
      verify: { ($0 as? WriteNoteResponse)?.version == "v2" }),
    Operation(
      name: "writeNote (createOnly)", method: "PUT", target: encodedNotePath,
      body: ["content": "", "baseVersion": nil], attributed: true,
      response: .json(201, #"{"path":"Daily/Café #1 50%.md","version":"v0","mtime":5}"#),
      call: { try await $0.writeNote(notePath, content: "", baseVersion: .createOnly) },
      verify: { ($0 as? WriteNoteResponse)?.version == "v0" }),
    Operation(
      name: "writeNote (unconditional)", method: "PUT", target: encodedNotePath,
      body: ["content": "x"], attributed: true,
      response: .json(#"{"path":"Daily/Café #1 50%.md","version":"v3","mtime":5}"#),
      call: { try await $0.writeNote(notePath, content: "x", baseVersion: .unconditional) },
      verify: { ($0 as? WriteNoteResponse)?.version == "v3" }),
    Operation(
      name: "deleteNote", method: "DELETE", target: encodedNotePath, body: nil, attributed: true,
      response: .json(#"{"ok":true,"trashedTo":".trash/Daily/Café #1 50%.md"}"#),
      call: { try await $0.deleteNote(notePath) },
      verify: { ($0 as? TrashResponse)?.trashedTo == ".trash/Daily/Café #1 50%.md" }),
    Operation(
      name: "rename (note)", method: "POST", target: "/api/notes-rename",
      body: ["from": "Ideas.md", "to": "Archive/Ideas.md"], attributed: true,
      response: .json(#"{"path":"Archive/Ideas.md","version":"v","mtime":1}"#),
      call: { try await $0.rename(from: "Ideas.md", to: "Archive/Ideas.md") },
      verify: {
        ($0 as? RenameResponse)
          == .note(WriteNoteResponse(path: "Archive/Ideas.md", version: "v", mtime: 1))
      }),
    Operation(
      name: "rename (folder)", method: "POST", target: "/api/notes-rename",
      body: ["from": "Projects", "to": "Work/Projects"], attributed: true,
      response: .json(#"{"path":"Work/Projects","moved":3}"#),
      call: { try await $0.rename(from: "Projects", to: "Work/Projects") },
      verify: {
        ($0 as? RenameResponse) == .folder(FolderRenameResponse(path: "Work/Projects", moved: 3))
      }),
    Operation(
      name: "createFolder", method: "POST", target: "/api/folders", body: ["path": "Projects/New"],
      attributed: true, response: .json(201, #"{"path":"Projects/New"}"#),
      call: { try await $0.createFolder("Projects/New") },
      verify: { ($0 as? CreateFolderResponse)?.path == "Projects/New" }),
    Operation(
      name: "deleteFolder", method: "DELETE", target: "/api/folders?path=Projects%2FOld%20stuff",
      body: nil, attributed: true,
      response: .json(#"{"ok":true,"trashedTo":".trash/Projects/Old stuff"}"#),
      call: { try await $0.deleteFolder("Projects/Old stuff") },
      verify: { ($0 as? TrashResponse)?.trashedTo == ".trash/Projects/Old stuff" }),
    Operation(
      name: "dailyNote (create)", method: "GET", target: "/api/daily/today?create=1", body: nil,
      attributed: true,
      response: .json(
        #"{"path":"Daily/2026-09-23.md","content":"- [ ] ","version":"v","mtime":1,"date":"2026-09-23","created":true}"#
      ),
      call: { try await $0.dailyNote("today", create: true) },
      verify: { ($0 as? DailyNoteResponse)?.created == true }),
    Operation(
      name: "dailyNote (read)", method: "GET", target: "/api/daily/2026-09-22", body: nil,
      attributed: false,
      response: .json(
        #"{"path":"Daily/2026-09-22.md","content":"","version":"v","mtime":1,"date":"2026-09-22","created":false}"#
      ),
      call: { try await $0.dailyNote("2026-09-22", create: false) },
      verify: { ($0 as? DailyNoteResponse)?.date == "2026-09-22" }),
    Operation(
      name: "search", method: "GET", target: "/api/search?q=buy%20milk%20%26%20eggs&limit=5",
      body: nil,
      attributed: false,
      response: .json(
        #"{"hits":[{"path":"a.md","kind":"content","line":3,"preview":"buy milk"}]}"#),
      call: { try await $0.search("buy milk & eggs", limit: 5) },
      verify: { ($0 as? SearchResponse)?.hits.first?.line == 3 }),
    Operation(
      name: "settings", method: "GET", target: "/api/settings", body: nil, attributed: false,
      response: .json(value: SettingsResponse(settings: .defaults)),
      call: { try await $0.settings() },
      verify: { ($0 as? AppSettings) == .defaults }),
    Operation(
      name: "updateSettings", method: "PUT", target: "/api/settings",
      body: ["editor": ["vimMode": true], "agent": ["watch": ["futureDays": 14]]], attributed: true,
      response: .json(value: SettingsResponse(settings: .defaults)),
      call: {
        try await $0.updateSettings(
          SettingsPatch(editor: .init(vimMode: true), agent: .init(watch: .init(futureDays: 14))))
      },
      verify: { ($0 as? AppSettings) == .defaults }),
    Operation(
      name: "agentStatus", method: "GET", target: "/api/agent/status", body: nil, attributed: false,
      response: .json(value: SampleWire.status), call: { try await $0.agentStatus() },
      verify: { ($0 as? AgentStatusResponse) == SampleWire.status }),
    Operation(
      name: "setAgentEnabled", method: "PUT", target: "/api/agent/enabled",
      body: ["enabled": false],
      attributed: true, response: .json(value: SampleWire.status),
      call: { try await $0.setAgentEnabled(false) },
      verify: { ($0 as? AgentStatusResponse) == SampleWire.status }),
    Operation(
      name: "connectors", method: "GET", target: "/api/connectors", body: nil, attributed: false,
      response: .json(value: ConnectorsResponse(connectors: SampleWire.status.connectors)),
      call: { try await $0.connectors() },
      verify: { ($0 as? [ConnectorStatus]) == SampleWire.status.connectors }),
    Operation(
      name: "taskRecords", method: "GET", target: "/api/tasks?notePath=Daily%2F2026-09-23.md",
      body: nil,
      attributed: false, response: .json(value: TaskRecordsResponse(records: [SampleWire.record])),
      call: { try await $0.taskRecords(notePath: "Daily/2026-09-23.md") },
      verify: { ($0 as? [TaskAgentRecord]) == [SampleWire.record] }),
    Operation(
      name: "threads (filtered)", method: "GET",
      target: "/api/threads?notePath=Daily%2F2026-09-23.md&taskId=tsk_1",
      body: nil, attributed: false,
      response: .json(value: ThreadListResponse(threads: [SampleWire.summary])),
      call: { try await $0.threads(notePath: "Daily/2026-09-23.md", taskId: "tsk_1") },
      verify: { ($0 as? [ThreadSummary]) == [SampleWire.summary] }),
    Operation(
      name: "threads (all)", method: "GET", target: "/api/threads", body: nil, attributed: false,
      response: .json(#"{"threads":[]}"#),
      call: { try await $0.threads(notePath: nil, taskId: nil) },
      verify: { ($0 as? [ThreadSummary])?.isEmpty == true }),
    Operation(
      name: "thread", method: "GET", target: "/api/threads/thr_1", body: nil, attributed: false,
      response: .json(
        value: ThreadResponse(thread: SampleWire.thread, approvals: [SampleWire.approval])),
      call: { try await $0.thread("thr_1") },
      verify: { ($0 as? ThreadResponse)?.approvals == [SampleWire.approval] }),
    Operation(
      name: "postMessage (202)", method: "POST", target: "/api/threads/thr_1/messages",
      body: ["text": "Prefer mornings"], attributed: true,
      response: .json(202, #"{"ok":true,"pending":true}"#),
      call: { try await $0.postMessage(threadId: "thr_1", text: "Prefer mornings") },
      verify: { ($0 as? ThreadActionResponse) == ThreadActionResponse(pending: true) }),
    Operation(
      name: "cancelThread (200)", method: "POST", target: "/api/threads/thr_1/cancel", body: nil,
      attributed: true, response: .json(#"{"ok":true}"#),
      call: { try await $0.cancelThread("thr_1") },
      verify: { ($0 as? ThreadActionResponse) == ThreadActionResponse() }),
    Operation(
      name: "retryThread (202)", method: "POST", target: "/api/threads/thr%3A1.a-b/retry",
      body: nil,
      attributed: true, response: .json(202, #"{"ok":true,"pending":true}"#),
      call: { try await $0.retryThread("thr:1.a-b") },
      verify: { ($0 as? ThreadActionResponse)?.pending == true }),
    Operation(
      name: "approvals", method: "GET", target: "/api/approvals?status=pending", body: nil,
      attributed: false,
      response: .json(value: ApprovalListResponse(approvals: [SampleWire.approval])),
      call: { try await $0.approvals(status: .pending) },
      verify: { ($0 as? [ApprovalRequest]) == [SampleWire.approval] }),
    Operation(
      name: "decideApproval", method: "POST", target: "/api/approvals/apr_1",
      body: ["decision": "deny", "note": "I'll call instead"], attributed: true,
      response: .json(value: ApprovalResponse(approval: SampleWire.approval)),
      call: {
        try await $0.decideApproval(
          "apr_1", ApprovalDecisionRequest(decision: .deny, note: "I'll call instead"))
      },
      verify: { ($0 as? ApprovalRequest) == SampleWire.approval }),
    Operation(
      name: "routines", method: "GET", target: "/api/routines", body: nil, attributed: false,
      response: .json(
        value: RoutineListResponse(routines: [SampleWire.routine], templates: [SampleWire.template])
      ),
      call: { try await $0.routines() },
      verify: {
        ($0 as? RoutineListResponse)
          == RoutineListResponse(routines: [SampleWire.routine], templates: [SampleWire.template])
      }),
    Operation(
      name: "routine", method: "GET", target: "/api/routines/rtn_0a1b2c3d4e5f60", body: nil,
      attributed: false, response: .json(value: RoutineResponse(routine: SampleWire.routine)),
      call: { try await $0.routine("rtn_0a1b2c3d4e5f60") },
      verify: { ($0 as? Routine) == SampleWire.routine }),
    Operation(
      name: "createRoutine (201)", method: "POST", target: "/api/routines",
      body: [
        "name": "Morning briefing", "schedule": "every weekday at 7:30",
        "instructions": "Brief me for the day.", "notify": "when_changed", "uses": ["web"],
      ],
      attributed: true, response: .json(201, value: RoutineResponse(routine: SampleWire.routine)),
      call: {
        try await $0.createRoutine(
          CreateRoutineRequest(
            name: "Morning briefing", schedule: "every weekday at 7:30",
            instructions: "Brief me for the day.", notify: .whenChanged, uses: [.web]))
      },
      verify: { ($0 as? Routine) == SampleWire.routine }),
    Operation(
      name: "runRoutine", method: "POST", target: "/api/routines/rtn_0a1b2c3d4e5f60/run",
      body: nil, attributed: true,
      response: .json(value: RoutineRunResponse(routine: SampleWire.routine, threadId: "thr_new")),
      call: { try await $0.runRoutine("rtn_0a1b2c3d4e5f60") },
      verify: { ($0 as? RoutineRunResponse)?.threadId == "thr_new" }),
    Operation(
      name: "pauseRoutine", method: "POST", target: "/api/routines/rtn_0a1b2c3d4e5f60/pause",
      body: nil, attributed: true,
      response: .json(value: RoutineResponse(routine: SampleWire.routine)),
      call: { try await $0.pauseRoutine("rtn_0a1b2c3d4e5f60") },
      verify: { ($0 as? Routine) == SampleWire.routine }),
    Operation(
      name: "resumeRoutine", method: "POST", target: "/api/routines/rtn_0a1b2c3d4e5f60/resume",
      body: nil, attributed: true,
      response: .json(value: RoutineResponse(routine: SampleWire.routine)),
      call: { try await $0.resumeRoutine("rtn_0a1b2c3d4e5f60") },
      verify: { ($0 as? Routine) == SampleWire.routine }),
    Operation(
      name: "threads (routine)", method: "GET", target: "/api/threads?routineId=rtn_0a1b2c3d4e5f60",
      body: nil, attributed: false,
      response: .json(value: ThreadListResponse(threads: [SampleWire.runSummary])),
      call: { try await $0.threads(routineId: "rtn_0a1b2c3d4e5f60") },
      verify: { ($0 as? [ThreadSummary]) == [SampleWire.runSummary] }),
    Operation(
      name: "syncStatus", method: "GET", target: "/api/sync/status", body: nil, attributed: false,
      response: .json(value: SampleWire.syncStatus), call: { try await $0.syncStatus() },
      verify: { ($0 as? SyncStatusResponse) == SampleWire.syncStatus }),
    Operation(
      name: "deviceSettings", method: "GET", target: "/api/device", body: nil, attributed: false,
      response: .json(value: SampleWire.device), call: { try await $0.deviceSettings() },
      verify: { ($0 as? DeviceSettingsResponse) == SampleWire.device }),
    Operation(
      name: "updateDeviceSettings", method: "PATCH", target: "/api/device",
      body: ["placement": "this_device", "remoteHosts": ["vm-name.tailnet-name.ts.net"]],
      attributed: true, response: .json(value: SampleWire.device),
      call: {
        try await $0.updateDeviceSettings(
          DeviceSettingsPatch(placement: .thisDevice, remoteHosts: ["vm-name.tailnet-name.ts.net"]))
      },
      verify: { ($0 as? DeviceSettingsResponse) == SampleWire.device }),
    Operation(
      name: "setUpSync", method: "PUT", target: "/api/device/sync",
      body: ["url": "https://sync.example.com", "vault": "vault_1", "token": "vault-token"],
      attributed: true, response: .json(value: SampleWire.device),
      call: {
        try await $0.setUpSync(
          DeviceSyncSetupRequest(
            url: "https://sync.example.com", vault: "vault_1", token: "vault-token"))
      },
      verify: { ($0 as? DeviceSettingsResponse)?.sync.hasToken == true }),
    Operation(
      name: "setUpSync (keeps the token)", method: "PUT", target: "/api/device/sync",
      body: ["url": "https://sync.example.com", "vault": "vault_2"], attributed: true,
      response: .json(value: SampleWire.device),
      call: {
        try await $0.setUpSync(
          DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_2"))
      },
      verify: { $0 is DeviceSettingsResponse }),
    Operation(
      name: "turnOffSync", method: "DELETE", target: "/api/device/sync", body: nil,
      attributed: true, response: .json(value: SampleWire.device),
      call: { try await $0.turnOffSync() }, verify: { $0 is DeviceSettingsResponse }),
    Operation(
      name: "createPairingCode (201)", method: "POST", target: "/api/pairing-codes",
      body: ["name": "Phone"], attributed: true,
      response: .json(201, value: SampleWire.pairingCode),
      call: { try await $0.createPairingCode(PairingCodeRequest(name: "Phone")) },
      verify: { ($0 as? PairingCodeResponse) == SampleWire.pairingCode }),
    Operation(
      name: "pairedDevices", method: "GET", target: "/api/devices", body: nil, attributed: false,
      response: .json(value: PairedDevicesResponse(devices: [SampleWire.pairedDevice])),
      call: { try await $0.pairedDevices() },
      verify: { ($0 as? [PairedDevice]) == [SampleWire.pairedDevice] }),
    Operation(
      name: "revokeDevice (204)", method: "DELETE", target: "/api/devices/pdv_1", body: nil,
      attributed: true, response: .respond(status: 204, headers: [:], body: Data()),
      call: { try await $0.revokeDevice("pdv_1") }, verify: { $0 is Void }),
    Operation(
      name: "machineStatus", method: "GET", target: "/api/machine", body: nil, attributed: false,
      response: .json(value: SampleWire.machine), call: { try await $0.machineStatus() },
      verify: { ($0 as? MachineStatusResponse) == SampleWire.machine }),
    Operation(
      name: "pairMachine", method: "POST", target: "/api/machine/pair",
      body: ["url": "https://vm-name.tailnet-name.ts.net", "code": "abcd-2345"], attributed: true,
      response: .json(value: SampleWire.machine),
      call: {
        try await $0.pairMachine(
          MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net", code: "abcd-2345"))
      },
      verify: { ($0 as? MachineStatusResponse) == SampleWire.machine }),
    Operation(
      name: "checkMachine", method: "POST", target: "/api/machine/check", body: nil,
      attributed: true, response: .json(value: SampleWire.machine),
      call: { try await $0.checkMachine() },
      verify: { ($0 as? MachineStatusResponse) == SampleWire.machine }),
    Operation(
      name: "forgetMachine", method: "DELETE", target: "/api/machine/pairing", body: nil,
      attributed: true, response: .json(value: SampleWire.machine),
      call: { try await $0.forgetMachine() }, verify: { $0 is MachineStatusResponse }),
  ]

  @Test(arguments: operations)
  func sendsTheRequestAndDecodesTheAnswer(_ operation: Operation) async throws {
    let stub = Stub { _ in operation.response }
    let client = stub.client()
    let result = try await operation.call(client)
    #expect(operation.verify(result), "unexpected result \(result)")

    let request = try #require(stub.requests.first)
    #expect(stub.requests.count == 1)
    #expect(request.method == operation.method)
    #expect(request.target == operation.target)
    #expect(request.header("Authorization") == "Bearer test-token")
    #expect(request.header("Accept") == "application/json")
    #expect(
      request.header(DaemonProtocol.clientIdHeader) == (operation.attributed ? "macos_test" : nil))
    #expect(request.jsonBody == operation.body)
    #expect(request.header("Content-Type") == (operation.body == nil ? nil : "application/json"))
    #expect(request.header("Origin") == nil)
  }

  @Test func artifactReturnsBytesAndTheBareMediaType() async throws {
    let bytes = Data("# Plan\n".utf8)
    let stub = Stub { _ in
      .respond(status: 200, headers: ["Content-Type": "text/markdown; charset=utf-8"], body: bytes)
    }
    let payload = try await stub.client().artifact(threadId: "thr_1", artifactId: "art_1")
    #expect(payload == ArtifactPayload(data: bytes, mimeType: "text/markdown"))
    let request = try #require(stub.requests.first)
    #expect(request.method == "GET")
    #expect(request.target == "/api/artifacts/thr_1/art_1")
    #expect(request.header("Authorization") == "Bearer test-token")
    #expect(request.header("Accept") == "*/*")
    #expect(request.header(DaemonProtocol.clientIdHeader) == nil)

    stub.setHandler { _ in .respond(status: 200, headers: [:], body: Data([0xFF])) }
    let untyped = try await stub.client().artifact(threadId: "thr_1", artifactId: "art_2")
    #expect(untyped.mimeType == "application/octet-stream")
  }

  // MARK: - Pairing

  @Test func pairSendsTheCodeWithoutTheToken() async throws {
    let response = PairResponse(
      device: SampleWire.pairedDevice, token: String(repeating: "d", count: 32))
    let stub = Stub { _ in .json(201, value: response) }
    let paired = try await stub.client().pair(
      PairRequest(code: "abcd-2345", name: "Studio Mac", kind: .app))
    #expect(paired == response)
    let request = try #require(stub.requests.first)
    #expect(request.method == "POST")
    #expect(request.target == "/api/pair")
    #expect(request.header("Authorization") == nil, "the code is the credential")
    #expect(request.jsonBody == ["code": "abcd-2345", "name": "Studio Mac", "kind": "app"])
  }

  @Test func aRejectedPairingCodeIsNotARejectedToken() async throws {
    let rejected = #"{"error":"pairing_rejected","message":"That code expired."}"#
    let stub = Stub { _ in .json(401, rejected) }
    let client = stub.client()
    await #expect(throws: DaemonClientError.pairingRejected("That code expired.")) {
      try await client.pair(PairRequest(code: "ABCD2345", name: "Phone", kind: .app))
    }
    let pairMachine = { @Sendable in
      try await client.pairMachine(
        MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net", code: "ABCD2345"))
    }
    await #expect(throws: DaemonClientError.pairingRejected("That code expired.")) {
      try await pairMachine()
    }
    let error = DaemonClientError.pairingRejected("That code expired.")
    #expect(error.httpStatus == 401 && error.apiErrorCode == .pairingRejected)

    // The machine pairing route also checks the bearer token: its 401 is still "unauthorized".
    stub.setHandler { _ in .json(401, #"{"error":"unauthorized"}"#) }
    await #expect(throws: DaemonClientError.unauthorized) { try await pairMachine() }
    // Every other route treats any 401 as a rejected token.
    stub.setHandler { _ in .json(401, rejected) }
    await #expect(throws: DaemonClientError.unauthorized) { try await client.deviceSettings() }
    await #expect(throws: DaemonClientError.unauthorized) {
      try await client.createPairingCode(PairingCodeRequest())
    }
  }

  @Test func pairingAndDeviceErrorsKeepTheDaemonsReason() async throws {
    let stub = Stub { _ in .json(429, #"{"error":"rate_limited","message":"Try again soon."}"#) }
    let client = stub.client()
    await #expect(
      throws: DaemonClientError.http(
        status: 429, body: ApiErrorBody(error: .rateLimited, message: "Try again soon."))
    ) {
      try await client.createPairingCode(PairingCodeRequest())
    }
    stub.setHandler { _ in
      .json(502, #"{"error":"machine_unreachable","message":"No answer from vm-name."}"#)
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 502,
        body: ApiErrorBody(error: .machineUnreachable, message: "No answer from vm-name."))
    ) {
      try await client.pairMachine(
        MachinePairRequest(url: "https://vm-name.tailnet-name.ts.net", code: "ABCD2345"))
    }
    stub.setHandler { _ in
      .json(409, #"{"error":"locked_by_env","message":"Set by DDL_AGENT_PLACEMENT."}"#)
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 409, body: ApiErrorBody(error: .lockedByEnv, message: "Set by DDL_AGENT_PLACEMENT.")
      )
    ) {
      try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .thisDevice))
    }
    stub.setHandler { _ in .json(404, #"{"error":"not_found","message":"Unknown device"}"#) }
    await #expect(
      throws: DaemonClientError.http(
        status: 404, body: ApiErrorBody(error: .notFound, message: "Unknown device"))
    ) {
      try await client.revokeDevice("pdv_9")
    }
    let before = stub.requests.count
    for id in ["..", "pdv/1", ""] {
      await #expect(
        throws: DaemonClientError.http(
          status: 400, body: ApiErrorBody(error: .invalidRequest, message: "Invalid device id"))
      ) {
        try await client.revokeDevice(id)
      }
    }
    #expect(stub.requests.count == before)
  }

  // MARK: - Status mapping

  @Test func unauthorizedIsMapped() async throws {
    let stub = Stub { _ in
      .json(401, #"{"error":"unauthorized","message":"Missing or invalid bearer token"}"#)
    }
    await #expect(throws: DaemonClientError.unauthorized) { try await stub.client().tree() }
  }

  @Test func notFoundCarriesTheErrorBody() async throws {
    let stub = Stub { _ in .json(404, #"{"error":"not_found","message":"No note at \"x.md\""}"#) }
    await #expect(
      throws: DaemonClientError.http(
        status: 404, body: ApiErrorBody(error: .notFound, message: #"No note at "x.md""#))
    ) {
      try await stub.client().readNote("x.md")
    }
  }

  @Test func noteConflictsCarryTheCurrentNote() async throws {
    let stub = Stub { _ in .json(409, value: ConflictResponse(current: SampleWire.note)) }
    let client = stub.client()
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: SampleWire.note))) {
      try await client.writeNote("Ideas.md", content: "mine", baseVersion: .match("old"))
    }
    stub.setHandler { _ in .json(409, #"{"error":"conflict","current":null}"#) }
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: nil))) {
      try await client.writeNote("Ideas.md", content: "mine", baseVersion: .match("old"))
    }
    stub.setHandler { _ in .json(409, value: ConflictResponse(current: SampleWire.note)) }
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: SampleWire.note))) {
      try await client.rename(from: "Old.md", to: "Ideas.md")
    }
  }

  @Test func folderRenameConflictsArePlainHTTPErrors() async throws {
    let stub = Stub { _ in .json(409, #"{"error":"conflict","message":"\"Work\" already exists"}"#)
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 409, body: ApiErrorBody(error: .conflict, message: #""Work" already exists"#))
    ) {
      try await stub.client().rename(from: "Projects", to: "Work")
    }
  }

  @Test func approvalConflictsCarryTheApproval() async throws {
    var decided = SampleWire.approval
    decided.status = .denied
    decided.decidedAt = 1_790_000_009_000
    let body = ApprovalConflictResponse(message: "Approval is already denied", approval: decided)
    let stub = Stub { _ in .json(409, value: body) }
    await #expect(throws: DaemonClientError.approvalConflict(body)) {
      try await stub.client().decideApproval("apr_1", ApprovalDecisionRequest(decision: .approve))
    }
    // A 409 elsewhere is a plain HTTP error.
    stub.setHandler { _ in .json(409, value: body) }
    await #expect(
      throws: DaemonClientError.http(
        status: 409, body: ApiErrorBody(error: .conflict, message: "Approval is already denied"))
    ) {
      try await stub.client().createFolder("x")
    }
  }

  @Test func badRequestsAndServerErrorsAreMapped() async throws {
    let stub = Stub { _ in .json(400, #"{"error":"invalid_request","message":"✖ Too big"}"#) }
    let client = stub.client()
    await #expect(
      throws: DaemonClientError.http(
        status: 400, body: ApiErrorBody(error: .invalidRequest, message: "✖ Too big"))
    ) {
      try await client.updateSettings(SettingsPatch(editor: .init(fontSize: 400)))
    }
    stub.setHandler { _ in
      .respond(status: 500, headers: ["Content-Type": "text/plain"], body: Data("boom".utf8))
    }
    await #expect(throws: DaemonClientError.http(status: 500, body: nil)) {
      try await client.health()
    }
    stub.setHandler { _ in .json(503, #"{"error":"agent_unavailable","message":"off"}"#) }
    do {
      _ = try await client.retryThread("thr_1")
      Issue.record("expected an error")
    } catch let error as DaemonClientError {
      #expect(error.httpStatus == 503 && error.apiErrorCode == .agentUnavailable)
    }
  }

  @Test func routineErrorsKeepTheDaemonsReason() async throws {
    let busy = #"{"error":"conflict","message":"“Morning briefing” is already running."}"#
    let stub = Stub { _ in .json(409, busy) }
    let client = stub.client()
    await #expect(
      throws: DaemonClientError.http(
        status: 409,
        body: ApiErrorBody(error: .conflict, message: "“Morning briefing” is already running."))
    ) {
      try await client.runRoutine("rtn_1")
    }
    stub.setHandler { _ in
      .json(503, #"{"error":"agent_unavailable","message":"The agent is paused"}"#)
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 503, body: ApiErrorBody(error: .agentUnavailable, message: "The agent is paused"))
    ) {
      try await client.runRoutine("rtn_1")
    }
    stub.setHandler { _ in
      .json(400, #"{"error":"invalid_request","message":"Couldn't read “whenever”."}"#)
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 400,
        body: ApiErrorBody(error: .invalidRequest, message: "Couldn't read “whenever”."))
    ) {
      try await client.createRoutine(
        CreateRoutineRequest(name: "A", schedule: "whenever", instructions: "x"))
    }
    stub.setHandler { _ in .json(409, #"{"error":"conflict","message":"It exists."}"#) }
    await #expect(
      throws: DaemonClientError.http(
        status: 409, body: ApiErrorBody(error: .conflict, message: "It exists."))
    ) {
      try await client.createRoutine(
        CreateRoutineRequest(name: "A", schedule: "hourly", instructions: "x"))
    }
    for id in ["..", "rtn/1", ""] {
      await #expect(
        throws: DaemonClientError.http(
          status: 400, body: ApiErrorBody(error: .invalidRequest, message: "Invalid routine id"))
      ) {
        try await client.pauseRoutine(id)
      }
    }
    #expect(stub.requests.count == 4)
  }

  @Test func malformedBodiesAreDecodingErrors() async throws {
    let stub = Stub { _ in .json(#"{"ok":true,"version":"1"#) }
    let client = stub.client()
    do {
      _ = try await client.health()
      Issue.record("expected a decoding error")
    } catch let DaemonClientError.decoding(detail) {
      #expect(detail.hasPrefix("HealthResponse at <root>: "), "\(detail)")
    }
    stub.setHandler { _ in
      .json(
        #"{"thread":{"id":"thr_1","taskId":null,"notePath":null,"title":"x","status":"idle","createdAt":0,"updatedAt":0,"messages":[{"id":"m","author":"system","createdAt":"soon","kind":"status","status":"done"}],"artifacts":[],"surfaces":[]},"approvals":[]}"#
      )
    }
    do {
      _ = try await client.thread("thr_1")
      Issue.record("expected a decoding error")
    } catch let DaemonClientError.decoding(detail) {
      #expect(detail.hasPrefix("ThreadResponse at thread.messages[0].createdAt: "), "\(detail)")
    }
    stub.setHandler { _ in
      .json(
        #"{"thread":{"id":"t","taskId":null,"notePath":null,"title":"","status":"idle","createdAt":0,"updatedAt":0,"messages":[],"artifacts":[],"surfaces":[]}}"#
      )
    }
    do {
      _ = try await client.thread("thr_1")
      Issue.record("expected a decoding error")
    } catch let DaemonClientError.decoding(detail) {
      #expect(detail.hasPrefix("ThreadResponse at approvals: "), "\(detail)")
    }
  }

  // MARK: - Transport failures

  @Test func aClosedPortIsUnreachable() async throws {
    let port = try closedLocalPort()
    let client = HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "t"),
      session: URLSession(configuration: .ephemeral))
    do {
      _ = try await client.health()
      Issue.record("expected .unreachable")
    } catch let DaemonClientError.unreachable(reason) {
      #expect(!reason.isEmpty)
    }
  }

  @Test func timeoutsAreUnreachable() async throws {
    let stub = Stub { _ in .hang }
    let client = stub.client(options: .init(requestTimeout: .milliseconds(200)))
    do {
      _ = try await withTimeout { try await client.health() }
      Issue.record("expected .unreachable")
    } catch let DaemonClientError.unreachable(reason) {
      #expect(!reason.isEmpty)
    }
    stub.setHandler { _ in .fail(URLError(.networkConnectionLost)) }
    await #expect(
      throws: DaemonClientError.unreachable(URLError(.networkConnectionLost).localizedDescription)
    ) {
      try await client.health()
    }
  }

  @Test func cancellationIsReported() async throws {
    let stub = Stub { _ in .hang }
    let client = stub.client()
    let call = Task { try await client.health() }
    try await waitUntil("request to arrive") { !stub.requests.isEmpty }
    call.cancel()
    let result = await call.result
    #expect(throws: DaemonClientError.cancelled) { try result.get() }

    let cancelledBeforeStart = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await client.tree()
    }
    await #expect(throws: DaemonClientError.cancelled) { try await cancelledBeforeStart.value }
  }

  // MARK: - Local guards

  @Test func unsafePathsAndIdsFailBeforeAnyRequest() async throws {
    let stub = Stub { _ in .json(#"{}"#) }
    let client = stub.client()
    for path in ["a/../b.md", "./x.md", "a/./b.md", ".."] {
      await #expect(
        throws: DaemonClientError.http(
          status: 400,
          body: ApiErrorBody(error: .invalidPath, message: "Invalid note path \"\(path)\""))
      ) {
        try await client.readNote(path)
      }
    }
    for id in ["..", ".", "thr/1", "", "thr 1", String(repeating: "t", count: 201)] {
      await #expect(
        throws: DaemonClientError.http(
          status: 400, body: ApiErrorBody(error: .invalidRequest, message: "Invalid thread id"))
      ) {
        try await client.thread(id)
      }
    }
    await #expect(throws: DaemonClientError.self) {
      try await client.decideApproval("..", ApprovalDecisionRequest(decision: .approve))
    }
    await #expect(throws: DaemonClientError.self) {
      try await client.artifact(threadId: "thr_1", artifactId: "a/b")
    }
    #expect(stub.requests.isEmpty)
  }

  @Test func clientIdsAreValid() {
    #expect(HTTPDaemonClient.isValidClientID(HTTPDaemonClient.makeClientID()))
    #expect(HTTPDaemonClient.makeClientID() != HTTPDaemonClient.makeClientID())
    #expect(!HTTPDaemonClient.isValidClientID("web k3j9"))
    #expect(HTTPDaemonClient.defaultClientVersion.hasPrefix("macos/"))
  }
}

/// A 127.0.0.1 port nothing listens on (bound, then released).
func closedLocalPort() throws -> UInt16 {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { throw TimeoutError(description: "socket() failed") }
  defer { close(fd) }
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  address.sin_port = 0
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
  }
  guard bound == 0 else { throw TimeoutError(description: "bind() failed") }
  let named = withUnsafeMutablePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
  }
  guard named == 0 else { throw TimeoutError(description: "getsockname() failed") }
  return UInt16(bigEndian: address.sin_port)
}
