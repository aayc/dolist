import Foundation

/// Trailing debounce that fires once `delay` has passed since the LAST ``poke()``.
///
/// Unlike re-creating a timer per call, one timer is kept and re-armed from the last poke time when
/// it fires early, so a burst of keystrokes costs O(1) each.
@MainActor
final class IdleTimer {
  private let scheduler: AppScheduler
  private let delay: TimeInterval
  private let action: @MainActor () -> Void
  private var lastPoke: TimeInterval = 0
  private var pending: ScheduledAction?

  init(scheduler: AppScheduler, delay: TimeInterval, action: @escaping @MainActor () -> Void) {
    self.scheduler = scheduler
    self.delay = delay
    self.action = action
  }

  var isArmed: Bool { pending != nil }

  func poke() {
    lastPoke = scheduler.now
    if pending == nil { arm(after: delay) }
  }

  func cancel() {
    pending?.cancel()
    pending = nil
  }

  /// Cancels the timer and runs the action immediately.
  func fireNow() {
    cancel()
    action()
  }

  private func arm(after interval: TimeInterval) {
    pending = scheduler.schedule(after: max(0, interval)) { [weak self] in
      self?.fire()
    }
  }

  private func fire() {
    pending = nil
    let idle = scheduler.now - lastPoke
    if idle + 1e-9 < delay {
      arm(after: delay - idle)
      return
    }
    action()
  }
}

/// Leading + trailing throttle: the first call runs immediately, later calls run at most once per
/// `interval` with the latest value.
@MainActor
final class Throttle<Value> {
  private let scheduler: AppScheduler
  private let interval: TimeInterval
  private let action: @MainActor (Value) -> Void
  private var lastRun: TimeInterval = -.infinity
  private var pendingValue: Value?
  private var pending: ScheduledAction?

  init(
    scheduler: AppScheduler, interval: TimeInterval, action: @escaping @MainActor (Value) -> Void
  ) {
    self.scheduler = scheduler
    self.interval = interval
    self.action = action
  }

  func call(_ value: Value) {
    let remaining = interval - (scheduler.now - lastRun)
    if remaining <= 0, pending == nil {
      run(value)
      return
    }
    pendingValue = value
    if pending == nil {
      pending = scheduler.schedule(after: max(0, remaining)) { [weak self] in
        guard let self else { return }
        self.pending = nil
        if let next = self.pendingValue {
          self.pendingValue = nil
          self.run(next)
        }
      }
    }
  }

  func cancel() {
    pending?.cancel()
    pending = nil
    pendingValue = nil
  }

  private func run(_ value: Value) {
    lastRun = scheduler.now
    action(value)
  }
}
