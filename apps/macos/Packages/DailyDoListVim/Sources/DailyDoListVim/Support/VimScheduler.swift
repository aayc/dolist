import Foundation

/// Runs vim's delayed work (JavaScript's `setTimeout`): the search highlight after 50 ms and the
/// insert-mode timeout of multi-key mappings like `jk`. Tests inject `ManualVimScheduler`.
@MainActor
public protocol VimScheduler: AnyObject {
  /// Runs `action` after `delay` seconds unless the returned token is cancelled.
  func schedule(after delay: Double, _ action: @escaping () -> Void) -> VimTimer
}

/// A scheduled action.
@MainActor
public protocol VimTimer: AnyObject {
  func cancel()
}

/// The default scheduler: the main run loop.
@MainActor
public final class MainQueueVimScheduler: VimScheduler {
  public init() {}

  public func schedule(after delay: Double, _ action: @escaping () -> Void) -> VimTimer {
    let timer = MainQueueTimer()
    let job = MainQueueJob(timer: timer, action: action)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        if !job.timer.isCancelled { job.action() }
      }
    }
    return timer
  }

  private final class MainQueueTimer: VimTimer {
    var isCancelled = false
    func cancel() { isCancelled = true }
  }

  /// Carries the job to the main queue, where it was created and where it runs.
  private struct MainQueueJob: @unchecked Sendable {
    let timer: MainQueueTimer
    let action: () -> Void
  }
}

/// A scheduler that only runs actions when told to (for tests and replays).
@MainActor
public final class ManualVimScheduler: VimScheduler {
  private struct Entry {
    let due: Double
    let order: Int
    let timer: Timer
    let action: () -> Void
  }

  private final class Timer: VimTimer {
    var isCancelled = false
    func cancel() { isCancelled = true }
  }

  private var entries: [Entry] = []
  private var counter = 0
  /// The scheduler's clock, in seconds.
  public private(set) var now: Double = 0

  public init() {}

  public func schedule(after delay: Double, _ action: @escaping () -> Void) -> VimTimer {
    let timer = Timer()
    counter += 1
    entries.append(Entry(due: now + delay, order: counter, timer: timer, action: action))
    return timer
  }

  /// The number of actions waiting (cancelled ones excluded).
  public var pendingCount: Int { entries.filter { !$0.timer.isCancelled }.count }

  /// Advances the clock by `seconds`, running what falls due in order.
  public func advance(by seconds: Double) {
    let target = now + seconds
    while let next = entries.filter({ !$0.timer.isCancelled && $0.due <= target }).min(by: {
      ($0.due, $0.order) < ($1.due, $1.order)
    }) {
      entries.removeAll { $0.order == next.order }
      now = next.due
      next.action()
    }
    entries.removeAll { $0.timer.isCancelled }
    now = target
  }
}
