import AppKit
import Observation

/// Shows the number of pending approvals on the Dock icon while started.
@MainActor
public final class DockBadge {
  private let store: AgentStore
  private let setLabel: @MainActor (String?) -> Void
  private var isRunning = false
  private var shown: String??

  /// - Parameter setLabel: where the label goes (defaults to `NSApp.dockTile.badgeLabel`).
  public init(
    store: AgentStore,
    setLabel: @escaping @MainActor (String?) -> Void = { NSApp?.dockTile.badgeLabel = $0 }
  ) {
    self.store = store
    self.setLabel = setLabel
  }

  /// The badge text for a count: nil for none, "99+" beyond 99.
  nonisolated public static func label(forPendingCount count: Int) -> String? {
    guard count > 0 else { return nil }
    return count > 99 ? "99+" : String(count)
  }

  public func start() {
    guard !isRunning else { return }
    isRunning = true
    update()
    observe()
  }

  /// Stops updating and clears the badge.
  public func stop() {
    isRunning = false
    shown = .none
    setLabel(nil)
  }

  func update() {
    let label = Self.label(forPendingCount: store.pendingApprovalCount)
    guard shown != .some(label) else { return }
    shown = .some(label)
    setLabel(label)
  }

  private func observe() {
    guard isRunning else { return }
    withObservationTracking {
      _ = store.approvals
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.isRunning else { return }
        self.update()
        self.observe()
      }
    }
  }
}
