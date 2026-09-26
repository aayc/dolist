import Foundation

public struct TimeoutError: Error, CustomStringConvertible {
  public let description: String

  public init(description: String) {
    self.description = description
  }
}

/// Polls `condition` (on the caller's actor) every few milliseconds until it holds, failing after
/// `timeout`. The default leaves room for CI's macOS runners, which can be many times slower than
/// a laptop.
public func eventually(
  _ what: @autoclosure () -> String = "condition", timeout: Duration = .seconds(10),
  isolation: isolated (any Actor)? = #isolation, _ condition: () -> Bool
) async throws {
  let deadline = ContinuousClock.now + timeout
  while !condition() {
    guard ContinuousClock.now < deadline else {
      throw TimeoutError(description: "timed out waiting for \(what())")
    }
    try await Task.sleep(for: .milliseconds(2))
  }
}
