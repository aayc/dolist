import os

/// Fans stream items out to any number of `AsyncStream`s, in one global order. A new stream
/// starts with the current connection state; `finishAll` ends every stream that exists.
///
/// Lock-based rather than an actor so `events()` can register synchronously: a consumer never
/// misses an item emitted right after it subscribed.
final class EventBroadcaster: Sendable {
  typealias Continuation = AsyncStream<DaemonStreamItem>.Continuation

  private struct State {
    var current: ConnectionState
    var subscribers: [UInt64: Continuation] = [:]
    var nextID: UInt64 = 0
  }

  private let state: OSAllocatedUnfairLock<State>

  init(initial: ConnectionState = .idle) {
    state = OSAllocatedUnfairLock(initialState: State(current: initial))
  }

  var currentState: ConnectionState { state.withLock { $0.current } }

  var subscriberCount: Int { state.withLock { $0.subscribers.count } }

  /// A new stream that yields the current state first. Buffering is unbounded: consumers are
  /// expected to keep up, and dropping an event would silently corrupt their state.
  func stream() -> AsyncStream<DaemonStreamItem> {
    let (stream, continuation) = AsyncStream<DaemonStreamItem>.makeStream(
      bufferingPolicy: .unbounded)
    let id = state.withLock { state in
      defer { state.nextID &+= 1 }
      return state.nextID
    }
    continuation.onTermination = { [weak self] _ in self?.remove(id) }
    state.withLock { state in
      state.subscribers[id] = continuation
      continuation.yield(.state(state.current))
    }
    return stream
  }

  func emit(_ item: DaemonStreamItem) {
    state.withLock { state in
      if case .state(let connection) = item { state.current = connection }
      for (id, continuation) in state.subscribers {
        if case .terminated = continuation.yield(item) { state.subscribers[id] = nil }
      }
    }
  }

  /// Emits `.state(final)` and finishes every current stream. Streams created afterwards start
  /// with `final` and stay open until the next `finishAll`.
  func finishAll(with final: ConnectionState) {
    let finished = state.withLock { state in
      state.current = final
      let all = Array(state.subscribers.values)
      state.subscribers.removeAll()
      for continuation in all { continuation.yield(.state(final)) }
      return all
    }
    // Outside the lock: `finish()` runs `onTermination`, which takes it.
    for continuation in finished { continuation.finish() }
  }

  private func remove(_ id: UInt64) {
    _ = state.withLock { $0.subscribers.removeValue(forKey: id) }
  }
}
