import Foundation
import Testing

@testable import DailyDoListModels

/// The vault switch and the Obsidian import: what the daemon sends and what clients send back.
struct ImportModelTests {
  static func json<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(value))
  }

  static func fixture<T: Decodable>(_ type: T.Type, _ schema: String, named prefix: String) throws
    -> T
  {
    let fixture = try #require(Fixtures.cases(schema).first { $0.name.hasPrefix(prefix) })
    return try Fixtures.decode(T.self, fixture.value)
  }

  @Test func switchingVaultsSaysWhoRestartsTheDaemon() throws {
    let supervised = try Self.fixture(
      DeviceVaultResponse.self, "DeviceVaultResponse", named: "switching, the Mac app")
    #expect(supervised.restart == .supervisor)
    let settled = try Self.fixture(
      DeviceVaultResponse.self, "DeviceVaultResponse", named: "the vault from config.json")
    #expect(settled.restart == nil && !settled.lockedByEnv)
    let newer = try Fixtures.decode(
      DeviceVaultResponse.self,
      ["path": "/Users/me/Notes", "lockedByEnv": false, "restart": "launchd"])
    #expect(newer.restart?.rawValue == "launchd")
  }

  @Test func requestsEncodeOnlyWhatIsSet() throws {
    #expect(try Self.json(DeviceVaultRequest(path: "~/Notebook")) == ["path": "~/Notebook"])
    #expect(
      try Self.json(ObsidianImportPreviewRequest(source: "~/Obsidian")) == ["source": "~/Obsidian"])
    #expect(try Self.json(ObsidianImportRequest(source: "~/Obsidian")) == ["source": "~/Obsidian"])
    #expect(
      try Self.json(ObsidianImportRequest(source: "~/Obsidian", destination: "~/New"))
        == ["source": "~/Obsidian", "destination": "~/New"])
  }

}
