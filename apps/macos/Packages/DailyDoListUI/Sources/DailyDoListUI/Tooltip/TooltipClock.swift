import Foundation

/// A scheduled action; cancelling is idempotent.
@MainActor
public final class TooltipTimer {
  private var onCancel: (() -> Void)?

  public init(onCancel: @escaping () -> Void) {
    self.onCancel = onCancel
  }

  public func cancel() {
    onCancel?()
    onCancel = nil
  }
}

/// Monotonic time and main-actor timers for the tooltip timing, so tests drive time by hand
/// (``ManualTooltipClock``) instead of sleeping.
@MainActor
public protocol TooltipClock: AnyObject {
  /// Seconds; only differences matter.
  var now: TimeInterval { get }
  func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> TooltipTimer
}

/// Real time: system uptime and the main queue.
@MainActor
public final class LiveTooltipClock: TooltipClock {
  public init() {}

  public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

  public func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> TooltipTimer
  {
    let item = DispatchWorkItem { MainActor.assumeIsolated { action() } }
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay), execute: item)
    return TooltipTimer { item.cancel() }
  }
}

/// Virtual time: nothing fires until ``advance(by:)``.
@MainActor
public final class ManualTooltipClock: TooltipClock {
  private struct Entry {
    let id: Int
    let due: TimeInterval
    let action: @MainActor () -> Void
  }

  public private(set) var now: TimeInterval
  private var entries: [Entry] = []
  private var nextId = 0

  public init(now: TimeInterval = 100) {
    self.now = now
  }

  /// Timers scheduled and neither fired nor cancelled.
  public var pendingCount: Int { entries.count }

  public func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void)
    -> TooltipTimer
  {
    nextId += 1
    let id = nextId
    entries.append(Entry(id: id, due: now + max(0, delay), action: action))
    return TooltipTimer { [weak self] in self?.entries.removeAll { $0.id == id } }
  }

  /// Moves time forward, firing what becomes due in order (including timers those schedule).
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
