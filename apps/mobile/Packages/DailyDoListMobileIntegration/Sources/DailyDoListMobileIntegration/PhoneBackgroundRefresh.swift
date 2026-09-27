#if os(iOS)
  @preconcurrency import BackgroundTasks
  import Foundation

  /// Optional best-effort refresh. Register during application startup and list the identifier in
  /// BGTaskSchedulerPermittedIdentifiers. No background mode can make the phone an always-on host.
  @MainActor public final class PhoneBackgroundRefresh {
    public let identifier: String
    private let integrations: PhoneIntegrations
    public init(identifier: String, integrations: PhoneIntegrations) {
      self.identifier = identifier
      self.integrations = integrations
    }
    @discardableResult public func register() -> Bool {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) {
        [weak self] task in
        MainActor.assumeIsolated {
          guard let self, let refresh = task as? BGAppRefreshTask else {
            task.setTaskCompleted(success: false)
            return
          }
          self.run(refresh)
        }
      }
    }
    public func schedule() async throws {
      guard await integrations.backgroundRefreshAllowed() else {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        return
      }
      let request = BGAppRefreshTaskRequest(identifier: identifier)
      request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
      try BGTaskScheduler.shared.submit(request)
    }
    private func run(_ task: BGAppRefreshTask) {
      let work = Task { @MainActor [integrations] in
        var success = false
        do {
          guard await integrations.backgroundRefreshAllowed() else {
            task.setTaskCompleted(success: false)
            return
          }
          try Task.checkCancellation()
          try await integrations.catchUp()
          success = !Task.isCancelled
        } catch { success = false }
        task.setTaskCompleted(success: success)
        try? await schedule()
      }
      task.expirationHandler = { work.cancel() }
    }
  }
#endif
