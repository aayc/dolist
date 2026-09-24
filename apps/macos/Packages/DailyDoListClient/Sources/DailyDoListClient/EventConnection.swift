import DailyDoListModels
import Foundation
import os

/// The `/ws` event connection of an `HTTPDaemonClient`: handshake, fan-out, keep-alive, surface
/// subscription replay and reconnection with backoff until `disconnect()`.
///
/// Every state change and event is emitted from this actor, so all streams see one order.
actor EventConnection {
  struct Configuration: Sendable {
    var backoff: ReconnectBackoff
    var helloTimeout: Duration
    var pingInterval: Duration?
    var maximumMessageSize: Int
  }

  private struct SurfaceSubscription: Hashable {
    let threadId: String
    let surface: SurfaceKind
  }

  private enum Outcome {
    case closed(reason: String, wasConnected: Bool)
    case incompatible(serverApiVersion: Int)
    case stopped
  }

  nonisolated let broadcaster = EventBroadcaster()
  private let endpoint: DaemonEndpoint
  private let session: URLSession
  private let clientId: String
  private let clientVersion: String
  private let configuration: Configuration
  private let logger = Logger(subsystem: "DailyDoList", category: "DaemonEvents")

  /// Bumped by `connect()`/`disconnect()`: work started under an older generation stops silently.
  private var generation = 0
  private var loop: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  /// The daemon's hello arrived on `socket`, so signals may be sent.
  private var isOpen = false
  private var everConnected = false
  private var lastServerApiVersion: Int?
  /// Why this client closed the current socket itself (shown instead of the close code).
  private var localCloseReason: String?
  /// Active surface subscriptions, in subscription order (replayed after every connect).
  private var subscriptions: [SurfaceSubscription] = []
  private var timers: [Task<Void, Never>] = []

  init(
    endpoint: DaemonEndpoint, session: URLSession, clientId: String, clientVersion: String,
    configuration: Configuration
  ) {
    self.endpoint = endpoint
    self.session = session
    self.clientId = clientId
    self.clientVersion = clientVersion
    self.configuration = configuration
  }

  func connect() {
    guard loop == nil else { return }
    generation += 1
    let generation = generation
    broadcaster.emit(.state(.connecting))
    loop = Task { await self.run(generation: generation) }
  }

  func disconnect() {
    generation += 1
    loop?.cancel()
    loop = nil
    closeSocket()
    broadcaster.finishAll(with: .disconnected)
  }

  func send(_ event: ClientEvent) async {
    switch event {
    case .surfaceSubscribe(let threadId, let surface):
      let subscription = SurfaceSubscription(threadId: threadId, surface: surface)
      if !subscriptions.contains(subscription) { subscriptions.append(subscription) }
    case .surfaceUnsubscribe(let threadId, let surface):
      subscriptions.removeAll { $0 == SurfaceSubscription(threadId: threadId, surface: surface) }
    default:
      break
    }
    guard isOpen, let socket else { return }
    await transmit(event, on: socket)
  }

  // MARK: - Connection loop

  private func isCurrent(_ generation: Int) -> Bool {
    generation == self.generation && !Task.isCancelled
  }

  private func run(generation: Int) async {
    var attempt = 0
    while isCurrent(generation) {
      let outcome = await connectOnce(generation: generation)
      guard isCurrent(generation) else { return }
      switch outcome {
      case .stopped:
        return
      case .incompatible(let version):
        loop = nil
        broadcaster.emit(.state(.incompatible(serverApiVersion: version)))
        return
      case .closed(let reason, let wasConnected):
        attempt = wasConnected ? 1 : attempt + 1
        broadcaster.emit(.state(.reconnecting(attempt: attempt, reason: reason)))
        do {
          try await Task.sleep(for: configuration.backoff.delay(forAttempt: attempt))
        } catch {
          return
        }
      }
    }
  }

  /// One connection, from the upgrade until the socket closes.
  private func connectOnce(generation: Int) async -> Outcome {
    let task = session.webSocketTask(with: URLRequest(url: endpoint.webSocketURL))
    task.maximumMessageSize = configuration.maximumMessageSize
    socket = task
    isOpen = false
    lastServerApiVersion = nil
    localCloseReason = nil
    task.resume()
    startHelloTimer(for: task, generation: generation)
    defer { if socket === task { closeSocket() } }

    await transmit(.hello(clientId: clientId, apiVersion: DaemonProtocol.apiVersion, clientVersion: clientVersion), on: task)
    while true {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await task.receive()
      } catch {
        guard isCurrent(generation) else { return .stopped }
        if task.closeCode.rawValue == DaemonProtocol.incompatibleApiVersionCloseCode {
          return .incompatible(serverApiVersion: lastServerApiVersion ?? 0)
        }
        let reason = localCloseReason ?? Self.closeReason(task, error)
        return .closed(reason: reason, wasConnected: isOpen)
      }
      guard isCurrent(generation) else { return .stopped }
      guard case .string(let text) = message else {
        logger.error("Skipping a binary WebSocket frame")
        continue
      }
      let event: ServerEvent
      do {
        event = try JSONDecoder.daemon.decode(ServerEvent.self, from: Data(text.utf8))
      } catch {
        let detail = DaemonClientError.decoding(error, type: ServerEvent.self)
        logger.error("Skipping a malformed server event: \(String(describing: detail), privacy: .public)")
        continue
      }
      if case .hello(let hello) = event, !isOpen {
        lastServerApiVersion = hello.apiVersion
        guard DaemonProtocol.isCompatible(apiVersion: hello.apiVersion) else {
          task.cancel(with: .normalClosure, reason: nil)
          return .incompatible(serverApiVersion: hello.apiVersion)
        }
        await opened(task, hello: hello, generation: generation)
        guard isCurrent(generation) else { return .stopped }
        continue
      }
      broadcaster.emit(.event(event))
    }
  }

  private func opened(_ task: URLSessionWebSocketTask, hello: HelloEvent, generation: Int) async {
    isOpen = true
    let reconnected = everConnected
    everConnected = true
    cancelTimers()
    broadcaster.emit(.state(.connected(serverVersion: hello.serverVersion)))
    broadcaster.emit(.event(.hello(hello)))
    if reconnected { broadcaster.emit(.resync) }
    startPingTimer(for: task, generation: generation)
    for subscription in subscriptions {
      await transmit(.surfaceSubscribe(threadId: subscription.threadId, surface: subscription.surface), on: task)
    }
  }

  private func transmit(_ event: ClientEvent, on task: URLSessionWebSocketTask) async {
    guard let data = try? JSONEncoder.daemon.encode(event) else { return }
    do {
      try await task.send(.string(String(decoding: data, as: UTF8.self)))
    } catch {
      // Best effort: a failed send means the socket is closing, and the receive loop handles it.
    }
  }

  private func closeSocket() {
    cancelTimers()
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    isOpen = false
  }

  // MARK: - Timers

  private func cancelTimers() {
    for timer in timers { timer.cancel() }
    timers.removeAll()
  }

  /// A daemon that accepts the upgrade but never says hello is treated as a failed attempt.
  private func startHelloTimer(for task: URLSessionWebSocketTask, generation: Int) {
    let timeout = configuration.helloTimeout
    timers.append(
      Task { [weak self] in
        try? await Task.sleep(for: timeout)
        guard !Task.isCancelled else { return }
        await self?.helloTimedOut(task, generation: generation)
      })
  }

  private func helloTimedOut(_ task: URLSessionWebSocketTask, generation: Int) {
    guard isCurrent(generation), socket === task, !isOpen else { return }
    logger.error("The daemon did not say hello in time; reconnecting")
    localCloseReason = "the daemon did not say hello in time"
    task.cancel(with: .goingAway, reason: nil)
  }

  private func startPingTimer(for task: URLSessionWebSocketTask, generation: Int) {
    guard let interval = configuration.pingInterval else { return }
    timers.append(
      Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: interval)
          guard !Task.isCancelled, let self else { return }
          await self.ping(task, generation: generation)
        }
      })
  }

  private func ping(_ task: URLSessionWebSocketTask, generation: Int) async {
    guard isCurrent(generation), socket === task, isOpen else { return }
    await transmit(.ping, on: task)
  }

  // MARK: - Diagnostics

  static func closeReason(_ task: URLSessionWebSocketTask, _ error: any Error) -> String {
    if let response = task.response as? HTTPURLResponse, response.statusCode != 101 {
      return "the daemon refused the connection (HTTP \(response.statusCode))"
    }
    if task.closeCode != .invalid {
      let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      let code = task.closeCode.rawValue
      return reason.isEmpty ? "closed by the daemon (\(code))" : "closed by the daemon (\(code) \(reason))"
    }
    if let error = error as? URLError { return error.localizedDescription }
    return (error as NSError).localizedDescription
  }
}
