import DailyDoListClient
import DailyDoListModels

/// Sends client signals (`thread.read`, surface subscriptions) one at a time, in order: a
/// subscribe immediately followed by an unsubscribe must reach the daemon in that order.
final class ClientOutbox: Sendable {
  private enum Item: Sendable {
    case event(ClientEvent)
    case flush(CheckedContinuation<Void, Never>)
  }

  private let continuation: AsyncStream<Item>.Continuation

  init(client: DaemonClient) {
    let (stream, continuation) = AsyncStream.makeStream(of: Item.self)
    self.continuation = continuation
    Task {
      for await item in stream {
        switch item {
        case .event(let event): await client.send(event)
        case .flush(let waiter): waiter.resume()
        }
      }
    }
  }

  deinit {
    continuation.finish()
  }

  func send(_ event: ClientEvent) {
    continuation.yield(.event(event))
  }

  /// Returns once everything queued before the call has been handed to the client.
  func flush() async {
    await withCheckedContinuation { waiter in
      if case .terminated = continuation.yield(.flush(waiter)) { waiter.resume() }
    }
  }
}
