import Foundation

/// A scan only fills the pairing form. It never contacts a server or submits the code until the
/// user reviews the displayed HTTPS host. Existing host-address QR codes remain supported.
public struct PairingCodePayload: Sendable, Equatable {
  public let origin: ConnectionOrigin
  public let code: String?

  public enum InvalidPayload: LocalizedError {
    case invalid
    public var errorDescription: String? {
      "This is not a Daily Do List host address or pairing code."
    }
  }

  public init(_ scanned: String) throws {
    guard scanned.utf8.count <= 4096 else { throw InvalidPayload.invalid }
    if let origin = try? ConnectionOrigin(scanned) {
      self.origin = origin
      code = nil
      return
    }
    struct Payload: Decodable {
      let version: Int
      let url: String
      let code: String
    }
    guard let data = scanned.data(using: .utf8),
      let payload = try? JSONDecoder().decode(Payload.self, from: data), payload.version == 1,
      let origin = try? ConnectionOrigin(payload.url)
    else { throw InvalidPayload.invalid }
    let code = payload.code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    guard code.count == 8,
      code.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) })
    else { throw InvalidPayload.invalid }
    self.origin = origin
    self.code = code
  }
}
