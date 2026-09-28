import Foundation
import Security

public protocol ConnectionCredentials: Sendable {
  func token(for profile: UUID) async throws -> String?
  func save(_ token: String, for profile: UUID) async throws
  func remove(_ profile: UUID) async throws
}

/// No iCloud synchronization or shared access group. Protected data failures remain errors;
/// they must never be mistaken for revocation or silently erase a profile's offline drafts.
public actor KeychainConnectionCredentials: ConnectionCredentials {
  public typealias Protection = MobileStorageProtectionMode
  public struct KeychainError: LocalizedError, Sendable {
    public let status: OSStatus
    public var errorDescription: String? {
      switch status {
      case errSecInteractionNotAllowed:
        "Unlock this iPhone, then try accessing the connection again."
      case errSecMissingEntitlement:
        "This build is missing its Keychain identity. Rebuild with signing enabled. Your saved notes are preserved."
      default:
        "The iPhone could not access this connection's credential (Keychain \(status)). Your saved notes are preserved."
      }
    }
  }
  private let service: String
  private var protection: Protection

  public init(
    service: String = "app.dailydolist.iphone.connections",
    protection: Protection = .afterFirstUnlock
  ) {
    self.service = service
    self.protection = protection
  }

  public func token(for profile: UUID) throws -> String? {
    var query = query(profile)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    guard let data = result as? Data, let token = String(data: data, encoding: .utf8),
      !token.isEmpty
    else {
      throw KeychainError(status: errSecDecode)
    }
    return token
  }

  public func save(_ token: String, for profile: UUID) throws {
    guard !token.isEmpty else { throw KeychainError(status: errSecParam) }
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: protection == .afterFirstUnlock
        ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        : kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let key = query(profile)
    let status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let inserted = SecItemAdd(key.merging(attributes) { _, new in new } as CFDictionary, nil)
      guard inserted == errSecSuccess else { throw KeychainError(status: inserted) }
    } else if status != errSecSuccess {
      throw KeychainError(status: status)
    }
  }

  /// Updates only accessibility attributes in this app's existing non-synchronizing service.
  /// Tokens are never exported, deleted/reinserted, or copied into settings during migration.
  public func setProtection(_ value: Protection) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: false,
    ]
    let attributes = [
      kSecAttrAccessible as String: value == .afterFirstUnlock
        ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status)
    }
    protection = value
  }

  public func remove(_ profile: UUID) throws {
    let status = SecItemDelete(query(profile) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status)
    }
  }

  private func query(_ profile: UUID) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: profile.uuidString,
      kSecAttrSynchronizable as String: false,
    ]
  }
}
