import DailyDoListModels

/// State of the WebSocket event connection.
public enum ConnectionState: Equatable, Sendable {
  /// `connect()` was never called.
  case idle
  /// First connection attempt in progress.
  case connecting
  /// The daemon's `hello` arrived with a compatible API version.
  case connected(serverVersion: String)
  /// Lost; the client reconnects automatically (with backoff) until `disconnect()`. `attempt`
  /// counts the retries since the last successful connection, starting at 1.
  case reconnecting(attempt: Int, reason: String?)
  /// The daemon's major API version differs; the client stops reconnecting.
  case incompatible(serverApiVersion: Int)
  /// `disconnect()` was called.
  case disconnected

  public var isConnected: Bool {
    if case .connected = self { return true }
    return false
  }
}

/// Items of the event stream: connection state changes and server events, in order.
public enum DaemonStreamItem: Equatable, Sendable {
  case state(ConnectionState)
  case event(ServerEvent)
  /// Emitted after a reconnect: state may have been missed, so consumers should refetch.
  case resync
}
