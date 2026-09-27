import DailyDoListMobileKit
import Foundation
import Testing

struct KeychainIdentityTests {
  @Test func signedApplicationCanPersistItsPrivateCredential() async throws {
    let service = "app.dailydolist.tests." + UUID().uuidString
    let profile = UUID()
    let original = KeychainConnectionCredentials(service: service)
    try await original.save("synthetic-test-credential", for: profile)
    let reopened = KeychainConnectionCredentials(service: service)
    #expect(try await reopened.token(for: profile) == "synthetic-test-credential")
    try await reopened.remove(profile)
    #expect(try await original.token(for: profile) == nil)
  }
}
