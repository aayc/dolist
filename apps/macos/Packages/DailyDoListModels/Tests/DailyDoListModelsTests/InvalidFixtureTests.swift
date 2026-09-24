import Foundation
import Testing

@testable import DailyDoListModels

/// The invalid golden fixtures of `@ddl/contract`. Swift decoding is a structural check (types and
/// required fields), not a validator: it rejects values it can't represent and deliberately
/// tolerates the rest (value constraints, formats, unknown keys, unknown enum values, unknown event
/// types and message kinds). Every case is listed here with the reason, so a new fixture case
/// fails until someone decides which side it falls on.
struct InvalidFixtureTests {
  enum Expectation: Sendable {
    /// Decoding throws.
    case rejected
    /// Decoding succeeds on purpose (the reason documents why).
    case tolerated(String)
  }

  static let constraint = "value constraints (lengths, ranges, formats) are the producer's job"
  static let unknownKey = "unknown keys are ignored when decoding; Swift never produces them"
  static let openEnum = "open enum (WireEnum): unknown values decode and round-trip"

  static let expectations: [String: [String: Expectation]] = [
    "ApiErrorBody": [
      "unknown code": .tolerated("ApiErrorCode is open: unknown codes are handled by HTTP status"),
      "missing code": .rejected,
      "numeric message": .rejected,
    ],
    "AppSettings": [
      "missing agent section": .rejected,
      "model with surrounding whitespace": .tolerated(constraint),
      "watch window over a year": .tolerated(constraint),
      "vimrc that is not a string": .rejected,
      "unknown harness": .tolerated("a harness a newer daemon added decodes as .pi (AgentSettings.harness)"),
      "empty Cursor model": .tolerated(constraint),
      "agent settings of a daemon older than the harness setting": .tolerated(
        "absent harness and cursorModel decode as .pi and the default Cursor model"),
    ],
    "ApprovalDecisionRequest": [
      "unknown decision": .rejected,
      "unknown scope": .rejected,
      "extra key": .tolerated(unknownKey),
      "null note": .tolerated("optional fields decode null as nil; Swift omits nil when encoding"),
    ],
    "ApprovalRequest": [
      "unknown risk level": .tolerated(openEnum),
      "unknown category": .tolerated(openEnum),
      "missing input": .tolerated("an absent `input` decodes as JSONValue.null"),
      "negative createdAt": .tolerated(constraint),
      "id with a slash": .tolerated("ids are opaque; the HTTP client refuses unsafe ids before a request"),
      "dot-segment id (URL parsers would drop it)": .tolerated(
        "ids are opaque; the HTTP client refuses unsafe ids before a request"),
    ],
    "ClientEvent": [
      "unknown event type": .rejected,
      "extra key in hello (client events are strict)": .tolerated(unknownKey),
      "client id with a space": .tolerated(constraint),
      "client id over 128 characters": .tolerated(constraint),
      "fractional apiVersion": .rejected,
      "unknown surface": .tolerated(openEnum),
      "empty thread id": .tolerated(constraint),
      "negative line": .tolerated(constraint),
      "empty note path": .tolerated(constraint),
      "ping with a payload": .tolerated(unknownKey),
    ],
    "ConflictResponse": [
      "another code": .tolerated("`error` is an open ApiErrorCode"),
      "missing current": .tolerated(
        "decodes with current == nil; the HTTP client checks for the key to tell note conflicts apart"),
    ],
    "CreateFolderRequest": [
      "empty path": .tolerated(constraint),
      "path is null": .rejected,
      "extra key": .tolerated(unknownKey),
    ],
    "HealthResponse": [
      "ok false": .tolerated("`ok` is a plain Bool"),
      "string apiVersion": .rejected,
      "unknown agent mode": .tolerated(openEnum),
    ],
    "PostMessageRequest": [
      "empty text": .tolerated(constraint),
      "whitespace only (trimmed to empty)": .tolerated(constraint),
      "missing text": .rejected,
      "extra key": .tolerated(unknownKey),
    ],
    "RenameRequest": [
      "missing to": .rejected,
      "empty from": .tolerated(constraint),
      "extra key": .tolerated(unknownKey),
    ],
    "ServerEvent": [
      "unknown event type": .tolerated("unknown event types decode as .unknown (forward compatibility)"),
      "missing discriminant": .rejected,
      "hello with apiVersion 0": .tolerated("the client's version check reports it as incompatible"),
      "vault.changed with a non-canonical path": .tolerated(constraint),
      "vault.changed with an unknown origin": .tolerated(openEnum),
      "task.record with an unknown status": .tolerated(openEnum),
      "thread.delta without messageId": .rejected,
      "thread.message with an unknown message kind": .tolerated(
        "unknown message kinds decode as ThreadMessage.unknown (forward compatibility)"),
      "surface.frame with non-base64 data": .tolerated("SurfaceFrame.imageData returns nil"),
      "surface.frame with a negative timestamp": .tolerated(constraint),
      "surface.frame with a zero width": .tolerated(constraint),
      "approval.upsert with an unsafe integer timestamp": .tolerated(
        "EpochMillis is a Double, like a JavaScript number"),
      "error with an unknown code": .tolerated(openEnum),
    ],
    "SetAgentEnabledRequest": [
      "string boolean": .rejected,
      "missing": .rejected,
      "extra key": .tolerated(unknownKey),
    ],
    "TaskAgentRecord": [
      "impossible date": .tolerated(constraint),
      "date in the wrong format": .tolerated(constraint),
      "fractional line": .rejected,
      "missing date (null is required when not a daily note)": .tolerated(
        "required-but-nullable fields decode a missing key as nil"),
      "empty task id": .tolerated(constraint),
      "path escaping the vault": .tolerated(constraint),
      "negative unread": .tolerated(constraint),
    ],
    "ThreadActionResponse": [
      "pending false": .tolerated("`pending` is a plain Bool?"),
      "not ok": .tolerated("`ok` is a plain Bool"),
    ],
    "ThreadResponse": [
      "thread id that can't be used in a URL": .tolerated(
        "ids are opaque; the HTTP client refuses unsafe ids before a request"),
      "tool call without input": .tolerated("an absent `input` decodes as JSONValue.null"),
      "unknown author": .tolerated("MessageAuthor is a plain String"),
      "negative artifact size": .tolerated(constraint),
      "unknown surface": .tolerated(openEnum),
      "missing approvals": .rejected,
    ],
    "TrashResponse": [
      "empty destination": .tolerated(constraint),
      "absolute destination": .tolerated(constraint),
    ],
    "UpdateSettingsRequest": [
      "unknown theme": .rejected,
      "font size too big": .tolerated(constraint),
      "unknown nested key": .tolerated(unknownKey),
      "unknown section": .tolerated(unknownKey),
      "negative settle delay": .tolerated(constraint),
      "fractional concurrency": .rejected,
      "approval timeout under a minute": .tolerated(constraint),
      "blank model": .tolerated(constraint),
      "unknown watch key": .tolerated(unknownKey),
      "section replaced by null": .tolerated("a null section decodes as nil (not patched)"),
      "vimrc of the wrong type": .rejected,
      "unknown harness": .rejected,
      "blank Cursor model": .tolerated(constraint),
      "Cursor model over 200 characters": .tolerated(constraint),
    ],
    "WriteNoteRequest": [
      "missing content": .rejected,
      "unknown key": .tolerated(unknownKey),
      "misspelled baseVersion": .tolerated("the misspelled key is ignored: decodes as .unconditional"),
      "empty baseVersion": .tolerated(constraint),
      "numeric baseVersion": .rejected,
      "content is not a string": .rejected,
      "body is an array": .rejected,
    ],
  ]

  static let invalidSchemas = ((try? Fixtures.schemas(.invalid)) ?? []).sorted()

  @Test(arguments: invalidSchemas)
  func invalidFixturesAreRejectedOrDeliberatelyTolerated(schema: String) throws {
    let model = try #require(Fixtures.models[schema], "no Swift model for \(schema)")
    let expected = try #require(Self.expectations[schema], "no expectations for \(schema)")
    let cases = try Fixtures.cases(schema, .invalid)
    #expect(Set(cases.map(\.name)) == Set(expected.keys), "cases and expectations differ for \(schema)")
    for fixture in cases {
      guard let expectation = expected[fixture.name] else { continue }
      let decoded = Self.decodes(model, fixture.value)
      switch expectation {
      case .rejected:
        #expect(!decoded, "\(schema) — \(fixture.name) should be rejected")
      case .tolerated:
        #expect(decoded, "\(schema) — \(fixture.name) should decode")
      }
    }
  }

  static func decodes<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> Bool {
    (try? Fixtures.decode(T.self, value)) != nil
  }

  /// Forward compatibility: what a newer daemon may send that this client still understands.
  @Test func documentedLeniencies() throws {
    // Unknown server event types are delivered as `.unknown` with the raw payload.
    let event = try Fixtures.decode(ServerEvent.self, ["type": "task.deleted", "taskId": "tsk_1"])
    guard case .unknown(let type, let raw) = event else {
      Issue.record("expected .unknown, got \(event)")
      return
    }
    #expect(type == "task.deleted")
    #expect(raw["taskId"] == "tsk_1")
    #expect(try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(event)) == raw)

    // Unknown message kinds keep their id so a thread still renders.
    let message = try Fixtures.decode(
      ThreadMessage.self, ["id": "msg_1", "author": "system", "createdAt": 1, "kind": "image", "url": "x.png"])
    guard case .unknown(let kind, let id, _) = message else {
      Issue.record("expected .unknown, got \(message)")
      return
    }
    #expect(kind == "image" && id == "msg_1" && message.createdAt == 1)

    // Open enums keep unknown values (and re-encode them unchanged).
    let status = try Fixtures.decode(TaskAgentStatus.self, "zombie")
    #expect(status.rawValue == "zombie" && !status.isActive && !TaskAgentStatus.active.contains(status))
    #expect(try Fixtures.decode(ApiErrorCode.self, "teapot").rawValue == "teapot")
    #expect(try Fixtures.decode(ActionCategory.self, "money") == ActionCategory(rawValue: "money"))
    #expect(try Fixtures.decode(SurfaceKind.self, "terminal").rawValue == "terminal")
    #expect(try Fixtures.decode(VaultChangeOrigin.self, "cloud").rawValue == "cloud")
    #expect(try Fixtures.decode(AgentMode.self, "auto").rawValue == "auto")
    #expect(try JSONEncoder.daemon.encode(RiskLevel(rawValue: "extreme")) == Data(#""extreme""#.utf8))

    // Unknown keys in responses are ignored.
    let health = try Fixtures.decode(
      HealthResponse.self,
      ["ok": true, "version": "9.0.0", "apiVersion": 1, "vaultName": "V", "agentMode": "live", "uptime": 5])
    #expect(health.version == "9.0.0")

    // Closed Swift enums (fields clients send, and response shapes the contract fixes) reject
    // unknown values: adding one is a breaking change per the contract's compatibility rules.
    #expect(!Self.decodes(ApprovalDecision.self, "maybe"))
    #expect(!Self.decodes(ApprovalScope.self, "forever"))
    #expect(!Self.decodes(ThemePreference.self, "neon"))
    #expect(!Self.decodes(VaultEntryKind.self, "symlink"))
    #expect(!Self.decodes(AgentHarnessKind.self, "claude"))
  }
}
