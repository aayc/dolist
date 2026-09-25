import Foundation

@testable import DailyDoListModels

/// Golden vectors of `@ddl/contract` (`packages/contract/fixtures/wire`): each file is a JSON array
/// of `{ name, value }` cases (invalid ones add the expected zod issue `path` and `code`).
enum Fixtures {
  static let directory: URL = {
    // .../apps/macos/Packages/DailyDoListModels/Tests/DailyDoListModelsTests/<this file>
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../../packages/contract/fixtures/wire")
      .standardizedFileURL
  }()

  struct Case: Decodable {
    let name: String
    let value: JSONValue
  }

  enum Kind: String {
    case valid, invalid
  }

  static func cases(_ schema: String, _ kind: Kind = .valid) throws -> [Case] {
    let url = directory.appendingPathComponent("\(schema).\(kind.rawValue).json")
    return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
  }

  /// Schema names that have a `<Name>.<kind>.json` file.
  static func schemas(_ kind: Kind) throws -> Set<String> {
    let suffix = ".\(kind.rawValue).json"
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    return Set(files.filter { $0.hasSuffix(suffix) }.map { String($0.dropLast(suffix.count)) })
  }

  /// The Swift model of every contract schema that has fixtures. A new fixture file fails
  /// `everyFixtureFileHasASwiftModel` until it is mapped here.
  static let models: [String: any (Codable & Equatable & Sendable).Type] = [
    "AgentStatusResponse": AgentStatusResponse.self,
    "ApiErrorBody": ApiErrorBody.self,
    "AppSettings": AppSettings.self,
    "ApprovalDecisionRequest": ApprovalDecisionRequest.self,
    "ApprovalRequest": ApprovalRequest.self,
    "ClientEvent": ClientEvent.self,
    "ComputerPermissionsOpenRequest": ComputerPermissionsOpenRequest.self,
    "ConflictResponse": ConflictResponse.self,
    "CreateFolderRequest": CreateFolderRequest.self,
    "HealthResponse": HealthResponse.self,
    "PostMessageRequest": PostMessageRequest.self,
    "RenameRequest": RenameRequest.self,
    "ServerEvent": ServerEvent.self,
    "SetAgentEnabledRequest": SetAgentEnabledRequest.self,
    "SyncStatusResponse": SyncStatusResponse.self,
    "TaskAgentRecord": TaskAgentRecord.self,
    "ThreadActionResponse": ThreadActionResponse.self,
    "ThreadResponse": ThreadResponse.self,
    "TrashResponse": TrashResponse.self,
    "UpdateSettingsRequest": SettingsPatch.self,
    "WriteNoteRequest": WriteNoteRequest.self,
  ]

  static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
    try JSONDecoder.daemon.decode(T.self, from: JSONEncoder.daemon.encode(value))
  }
}
