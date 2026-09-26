import Foundation

/// Handle to an action scheduled on an ``AppScheduler``. Cancelling is idempotent.
@MainActor
public final class ScheduledAction {
  private var onCancel: (() -> Void)?

  init(onCancel: @escaping () -> Void) {
    self.onCancel = onCancel
  }

  public func cancel() {
    onCancel?()
    onCancel = nil
  }
}

/// Monotonic time source and main-actor timer factory. Stores debounce and autosave through it,
/// and tooltips time through it, so tests drive time deterministically with ``ManualScheduler``.
@MainActor
public protocol AppScheduler: AnyObject {
  /// Monotonic seconds (only differences are meaningful).
  var now: TimeInterval { get }
  /// Runs `action` on the main actor after `delay` seconds unless the returned handle is cancelled.
  @discardableResult
  func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> ScheduledAction
}

extension AppScheduler {
  /// Suspends for `delay` seconds of this scheduler's time.
  public func sleep(for delay: TimeInterval) async {
    await withCheckedContinuation { continuation in
      schedule(after: delay) { continuation.resume() }
    }
  }
}

/// Real time: `systemUptime` + the main dispatch queue.
@MainActor
public final class LiveScheduler: AppScheduler {
  public static let shared = LiveScheduler()

  public init() {}

  public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

  @discardableResult
  public func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> ScheduledAction
  {
    let item = DispatchWorkItem {
      MainActor.assumeIsolated { action() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay), execute: item)
    return ScheduledAction { item.cancel() }
  }
}

/// Virtual time for tests and previews: nothing runs until ``advance(by:)``.
@MainActor
public final class ManualScheduler: AppScheduler {
  private struct Entry {
    let id: Int
    let due: TimeInterval
    let action: @MainActor () -> Void
  }

  public private(set) var now: TimeInterval
  private var entries: [Entry] = []
  private var nextId = 0

  public init(now: TimeInterval = 1_000) {
    self.now = now
  }

  /// Number of scheduled, not yet fired (and not cancelled) actions.
  public var pendingCount: Int { entries.count }

  @discardableResult
  public func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> ScheduledAction
  {
    nextId += 1
    let id = nextId
    entries.append(Entry(id: id, due: now + max(0, delay), action: action))
    return ScheduledAction { [weak self] in
      self?.entries.removeAll { $0.id == id }
    }
  }

  /// Moves time forward, firing every action that becomes due in due order (FIFO for ties),
  /// including actions scheduled by actions fired during the advance. An action due within a
  /// nanosecond of the target fires, so sums of delays don't miss by a rounding error.
  public func advance(by interval: TimeInterval) {
    let target = now + max(0, interval)
    while let next = entries.filter({ $0.due <= target + 1e-9 }).min(by: {
      ($0.due, $0.id) < ($1.due, $1.id)
    }) {
      entries.removeAll { $0.id == next.id }
      now = max(now, next.due)
      next.action()
    }
    now = target
  }
}
