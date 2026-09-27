import Foundation
import Testing

@testable import DailyDoListMobileKit

struct ConnectionOriginTests {
  @Test func normalizesOnlyAnHTTPSOrigin() throws {
    let origin = try ConnectionOrigin(" HTTPS://NOTES.EXAMPLE.TEST:443/ \n")
    #expect(origin.url.absoluteString == "https://notes.example.test")
    let decoded = try JSONDecoder().decode(
      ConnectionOrigin.self, from: JSONEncoder().encode(origin))
    #expect(decoded == origin)
  }

  @Test(arguments: [
    "http://notes.example.test", "file:///notes", "https://", "https://u:p@notes.example.test",
    "https://notes.example.test/api", "https://notes.example.test?token=example",
    "https://notes.example.test#code", "https://notes.example.test:0",
    "https://notes.example.test:65536",
  ])
  func rejectsNonOrigins(_ value: String) {
    #expect(throws: ConnectionOrigin.ValidationError.self) { try ConnectionOrigin(value) }
  }
}
