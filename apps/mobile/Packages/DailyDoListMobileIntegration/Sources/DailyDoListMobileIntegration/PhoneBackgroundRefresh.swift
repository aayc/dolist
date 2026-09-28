#if os(iOS)
  @preconcurrency import BackgroundTasks
  import Foundation

  /// Optional best-effort refresh. Register during application startup and list the identifier in
  /// BGTaskSchedulerPermittedIdentifiers. No background mode can make the phone an always-on host.
  @MainActor public final class PhoneBackgroundRefresh {
    public let identifier: String
    private let integrations: PhoneIntegrations
    private var currentWork: [UUID: Task<Void, Never>] = [:]
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
    /// Quiesce before a storage-protection change; no catch-up may retain its old SQLite handle.
    public func cancel() {
      for work in currentWork.values { work.cancel() }
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    }

    public func cancelAndWait() async {
      cancel()
      let pending = Array(currentWork.values)
      for work in pending { await work.value }
    }

    private func run(_ task: BGAppRefreshTask) {
      for work in currentWork.values { work.cancel() }
      let id = UUID()
      let work = Task { @MainActor [integrations] in
        defer { currentWork.removeValue(forKey: id) }
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
        if !Task.isCancelled { try? await schedule() }
      }
      currentWork[id] = work
      task.expirationHandler = { work.cancel() }
    }
  }
#endif
