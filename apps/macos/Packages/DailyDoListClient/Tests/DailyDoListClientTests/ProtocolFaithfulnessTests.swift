import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Every request the HTTP client sends must conform to the contract (checked against the
/// generated JSON Schema in exact mode), and the schema validator must agree with the golden
/// fixtures.
struct ProtocolFaithfulnessTests {
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
    "CreateRoutineRequest/blank instructions (trimmed to empty)", "DeviceVaultRequest/blank",
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

  static func fixtureValues(_ schema: String) throws -> [JSONValue] {
    let url = WireSchema.contractDirectory.appendingPathComponent(
      "fixtures/wire/\(schema).valid.json")
    let cases = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: url))
    return cases.compactMap { $0["value"] }
  }
}
