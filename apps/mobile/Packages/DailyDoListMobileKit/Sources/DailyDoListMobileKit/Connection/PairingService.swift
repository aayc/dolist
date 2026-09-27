import DailyDoListModels
import Foundation

/// Saves an empty profile before exchanging the single-use code. If the app terminates after
/// Keychain persistence, reconnect can recover that token even before device metadata was saved.
public actor PairingService {
  public typealias Exchange = @Sendable (ConnectionOrigin, PairRequest) async throws -> PairResponse
  public enum PairingError: LocalizedError {
    case invalidCode, invalidName, missingCredential, alreadyPairing
    public var errorDescription: String? {
      switch self {
      case .invalidCode: "Enter the eight-character pairing code from your host."
      case .invalidName: "Give this iPhone a name so you can recognize it on the host."
      case .missingCredential:
        "The host did not provide an app credential. Create a new pairing code."
      case .alreadyPairing: "This connection is already pairing."
      }
    }
  }

  private let profiles: any ConnectionProfileStore
  private let credentials: any ConnectionCredentials
  private let exchange: Exchange
  private var pending: [UUID: PairResponse] = [:]
  private var inFlight: Set<UUID> = []

  public init(
    profiles: any ConnectionProfileStore, credentials: any ConnectionCredentials,
    exchange: @escaping Exchange
  ) {
    self.profiles = profiles
    self.credentials = credentials
    self.exchange = exchange
  }

  public func pair(profile: ConnectionProfile, code: String, deviceName: String = "My iPhone")
    async throws -> ConnectionProfile
  {
    let code = code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    guard code.count == 8,
      code.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) })
    else { throw PairingError.invalidCode }
    let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 100 else { throw PairingError.invalidName }
    guard inFlight.insert(profile.id).inserted else { throw PairingError.alreadyPairing }
    defer { inFlight.remove(profile.id) }
    var saved = profile
    try await profiles.save(saved)
    let response: PairResponse
    if let recovered = pending[profile.id] {
      response = recovered
    } else {
      response = try await exchange(
        profile.origin,
        PairRequest(code: code, name: name, kind: .app))
      pending[profile.id] = response
    }
    guard let token = response.token, !token.isEmpty else { throw PairingError.missingCredential }
    // Keep the in-memory response on a storage failure so Retry never consumes another code.
    try await credentials.save(token, for: profile.id)
    saved.deviceID = response.device.id
    try await profiles.save(saved)
    pending[profile.id] = nil
    return saved
  }
}
