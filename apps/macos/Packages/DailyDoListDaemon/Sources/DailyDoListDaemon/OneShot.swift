import Foundation

/// A value that is set once and can be awaited by any number of tasks. Waiting is cancellable:
/// a cancelled waiter gets nil (so racing it against a timeout in a task group never hangs).
final class OneShot<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value?
  private var waiters: [UUID: CheckedContinuation<Value?, Never>] = [:]

  init() {}

  var current: Value? { lock.withLock { value } }

  /// Sets the value (only the first call wins) and wakes every waiter.
  func fulfill(_ newValue: Value) {
    let woken: [CheckedContinuation<Value?, Never>] = lock.withLock {
      guard value == nil else { return [] }
      value = newValue
      defer { waiters.removeAll() }
      return Array(waiters.values)
    }
    for waiter in woken { waiter.resume(returning: newValue) }
  }

  /// The value once set, or nil if the calling task is cancelled first.
  func wait() async -> Value? {
    let id = UUID()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Value?, Never>) in
        lock.lock()
        if let value {
          lock.unlock()
          continuation.resume(returning: value)
        } else if Task.isCancelled {
          lock.unlock()
          continuation.resume(returning: nil)
        } else {
          waiters[id] = continuation
          lock.unlock()
        }
      }
    } onCancel: {
      let waiter = lock.withLock { waiters.removeValue(forKey: id) }
      waiter?.resume(returning: nil)
    }
  }

  /// The value if it is set within `timeout` (measured with `clock`), else nil.
  func wait(timeout: Duration, clock: any DaemonClock) async -> Value? {
    if let current { return current }
    let result = await withTaskGroup(of: Value?.self) { group in
      group.addTask { await self.wait() }
      group.addTask {
        try? await clock.sleep(for: timeout)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    return result ?? current
  }
}
