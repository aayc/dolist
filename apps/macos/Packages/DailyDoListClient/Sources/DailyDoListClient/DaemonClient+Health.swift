import DailyDoListModels
import Foundation

extension DaemonClient {
  /// Polls `health()` until the daemon answers, e.g. right after launching it. Returns false when
  /// `timeout` elapses, the task is cancelled, or the daemon rejects the token (waiting won't
  /// help). The API version is not checked here: compare `health().apiVersion` separately.
  public func waitUntilHealthy(timeout: Duration, pollInterval: Duration = .milliseconds(100)) async
    -> Bool
  {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    var interval = pollInterval
    while !Task.isCancelled {
      switch await healthCheck(until: deadline) {
      case .healthy: return true
      case .hopeless: return false
      case .notYet: break
      }
      let remaining = clock.now.duration(to: deadline)
      guard remaining > .zero else { return false }
      do {
        try await Task.sleep(for: min(interval, remaining))
      } catch {
        return false
      }
      interval = min(interval * 2, .seconds(1))
    }
    return false
  }

  private func healthCheck(until deadline: ContinuousClock.Instant) async -> HealthCheck {
    await withTaskGroup(of: HealthCheck.self) { group in
      group.addTask {
        do {
          return try await self.health().ok ? .healthy : .notYet
        } catch DaemonClientError.unauthorized {
          return .hopeless
        } catch {
          return .notYet
        }
      }
      group.addTask {
        try? await Task.sleep(until: deadline, clock: .continuous)
        return .notYet
      }
      let first = await group.next() ?? .notYet
      group.cancelAll()
      return first
    }
  }
}

private enum HealthCheck: Sendable {
  case healthy
  case notYet
  /// The daemon answered but will never accept us.
  case hopeless
}
