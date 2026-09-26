import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// The `/ws` event stream of `HTTPDaemonClient` against an in-process WebSocket server.
struct HTTPDaemonClientEventsTests {
  static let fastOptions = HTTPDaemonClient.Options(
    reconnectBackoff: ReconnectBackoff(
      initialDelay: .milliseconds(10), maximumDelay: .milliseconds(40), jitter: 0),
    helloTimeout: .seconds(2),
    pingInterval: nil)

  static func client(_ server: TestWebSocketServer, options: HTTPDaemonClient.Options = fastOptions)
    -> HTTPDaemonClient
  {
    HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: server.baseURL, token: "test-token"),
      session: URLSession(configuration: .ephemeral), clientId: "macos_test",
      clientVersion: "macos/test",
      options: options)
  }

  static let hello = HelloEvent(serverVersion: "test-1", apiVersion: 1)

  @Test func handshakeSendsHelloAndReportsConnected() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    await client.connect()  // idempotent

    let peer = try await server.peer(1)
    try await recorder.waitFor("hello event") { $0 == .event(.hello(Self.hello)) }
    let upgrade = try #require(peer.upgrade)
    #expect(upgrade.method == "GET")
    #expect(upgrade.target == "/ws?token=test-token")
    #expect(upgrade.headers["host"] == "127.0.0.1:\(server.port)")
    #expect(
      upgrade.headers["origin"] == nil,
      "the daemon rejects unknown origins; native clients send none")
    #expect(upgrade.headers["upgrade"]?.lowercased() == "websocket")

    let firstMessage = try await waitFor("client hello") { peer.messages.first }
    let clientHello = try JSONDecoder.daemon.decode(ClientEvent.self, from: Data(firstMessage.utf8))
    #expect(
      clientHello
        == .hello(
          clientId: "macos_test", apiVersion: DaemonProtocol.apiVersion, clientVersion: "macos/test"
        ))
    #expect(
      recorder.items == [
        .state(.idle), .state(.connecting), .state(.connected(serverVersion: "test-1")),
        .event(.hello(Self.hello)),
      ])
    #expect(client.connectionState == .connected(serverVersion: "test-1"))
    #expect(server.connectionCount == 1)
    await client.disconnect()
  }

  @Test func aRemoteDaemonGetsTheTokenInTheAuthorizationHeader() async throws {
    let server = try await TestWebSocketServer()
    var endpoint = DaemonEndpoint(baseURL: server.baseURL, token: "test-token")
    endpoint.treatsAsRemote = true
    let client = HTTPDaemonClient(
      endpoint: endpoint, session: URLSession(configuration: .ephemeral), clientId: "macos_test",
      clientVersion: "macos/test", options: Self.fastOptions)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let peer = try await server.peer(1)
    try await recorder.waitFor("hello event") { $0 == .event(.hello(Self.hello)) }
    let upgrade = try #require(peer.upgrade)
    #expect(upgrade.target == "/ws", "no token in the URL")
    #expect(upgrade.headers["authorization"] == "Bearer test-token")
    #expect(upgrade.headers["origin"] == nil)
    await client.disconnect()
  }

  @Test func incompatibleHelloStopsReconnecting() async throws {
    let server = try await TestWebSocketServer {
      $0.send(#"{"type":"hello","serverVersion":"9.0.0","apiVersion":2}"#)
    }
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitForState(.incompatible(serverApiVersion: 2))
    try await Task.sleep(for: .milliseconds(150))  // ~10 backoff periods
    #expect(server.connectionCount == 1)
    #expect(recorder.states == [.idle, .connecting, .incompatible(serverApiVersion: 2)])
    #expect(recorder.events.isEmpty)
    await client.disconnect()
  }

  @Test func closeCode4426StopsReconnecting() async throws {
    let server = try await TestWebSocketServer { peer in
      peer.send(TestWebSocketServer.hello)
      peer.send(#"{"type":"error","message":"Update the app","code":"incompatible_api_version"}"#)
      peer.close(code: 4426, reason: "incompatible")
    }
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitForState(.incompatible(serverApiVersion: 1))
    try await Task.sleep(for: .milliseconds(150))
    #expect(server.connectionCount == 1)
    #expect(
      recorder.events.contains(
        .error(ServerErrorEvent(message: "Update the app", code: .incompatibleApiVersion))))
    #expect(!recorder.states.contains { if case .reconnecting = $0 { true } else { false } })
    await client.disconnect()
  }

  @Test func eventsFanOutToEverySubscriberInOrder() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let first = StreamRecorder(client.events())
    let second = StreamRecorder(client.events())
    await client.connect()
    let peer = try await server.peer(1)
    try await first.waitForState(.connected(serverVersion: "test-1"))
    let late = StreamRecorder(client.events())
    try await late.waitFor { _ in true }

    let events = [
      #"{"type":"vault.changed","changes":[{"path":"a.md","kind":"modified","version":"v2"}],"origin":"external"}"#,
      #"{"type":"thread.delta","threadId":"thr_1","messageId":"msg_1","delta":"Hi "}"#,
      #"{"type":"thread.delta","threadId":"thr_1","messageId":"msg_1","delta":"there"}"#,
    ]
    for event in events { peer.send(event) }
    let expected = try events.map { DaemonStreamItem.event(try .fromJSON($0)) }
    for recorder in [first, second, late] {
      try await recorder.waitFor("last event") { $0 == expected.last }
    }
    #expect(Array(first.items.suffix(3)) == expected)
    #expect(Array(second.items.suffix(3)) == expected)
    #expect(first.items == second.items)
    #expect(late.items == [.state(.connected(serverVersion: "test-1"))] + expected)
    await client.disconnect()
  }

  @Test func malformedAndUnknownFramesAreSkippedOrDelivered() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let peer = try await server.peer(1)
    try await recorder.waitForState(.connected(serverVersion: "test-1"))

    peer.send("this is not JSON")
    peer.send(#"{"type":"thread.delta","threadId":"thr_1"}"#)  // missing fields
    peer.send(#"{"no":"type"}"#)
    peer.sendBinary(Data([0x00, 0x01]))
    peer.send(#"{"type":"task.deleted","taskId":"tsk_1"}"#)
    peer.send(
      #"{"type":"agent.status","status":{"mode":"live","enabled":true,"model":"m","running":0,"queued":0,"pendingApprovals":0,"connectors":[],"execution":{"provider":"local","capabilities":{"shell":true,"browser":false,"computer":false}},"newField":1}}"#
    )

    try await recorder.waitFor("agent.status") {
      if case .event(.agentStatus) = $0 { true } else { false }
    }
    let events = recorder.events.filter { if case .hello = $0 { false } else { true } }
    #expect(events.count == 2)
    #expect(events.first?.type == "task.deleted")
    guard case .unknown(_, let raw) = events.first else {
      Issue.record("expected an unknown event")
      return
    }
    #expect(raw["taskId"] == "tsk_1")
    #expect(client.connectionState == .connected(serverVersion: "test-1"))
    #expect(server.connectionCount == 1)
    await client.disconnect()
  }

  @Test func serverCloseReconnectsWithBackoffAndAsksForResync() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let peer = try await server.peer(1)
    try await recorder.waitForState(.connected(serverVersion: "test-1"))
    peer.close(code: 1001, reason: "Server shutting down")

    _ = try await server.peer(2)
    try await recorder.waitFor("resync") { $0 == .resync }
    let reconnecting = recorder.states.compactMap { state -> (Int, String?)? in
      if case .reconnecting(let attempt, let reason) = state { (attempt, reason) } else { nil }
    }
    #expect(reconnecting.count == 1)
    #expect(reconnecting.first?.0 == 1)
    #expect(
      reconnecting.first?.1?.contains("1001") == true,
      "\(String(describing: reconnecting.first?.1))")
    let tail = Array(
      recorder.items.drop { $0 != .state(.reconnecting(attempt: 1, reason: reconnecting.first?.1)) }
    )
    #expect(
      tail == [
        .state(.reconnecting(attempt: 1, reason: reconnecting.first?.1)),
        .state(.connected(serverVersion: "test-1")), .event(.hello(Self.hello)), .resync,
      ])
    #expect(recorder.resyncCount == 1)

    // An abrupt drop (no close frame) reconnects too.
    try await server.peer(2).drop()
    _ = try await server.peer(3)
    try await recorder.waitUntilResyncs(2)
    await client.disconnect()
  }

  @Test func failedAttemptsBackOffUntilTheDaemonAnswers() async throws {
    // (A TCP drop before the 101 reaches the client is retried by URLSession itself, invisibly.)
    let server = try await TestWebSocketServer { peer in
      if peer.id < 2 {
        peer.close(code: 1013, reason: "Try again later")
      } else {
        peer.send(TestWebSocketServer.hello)
      }
    }
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitForState(.connected(serverVersion: "test-1"))
    let attempts = recorder.states.compactMap { state -> Int? in
      if case .reconnecting(let attempt, _) = state { attempt } else { nil }
    }
    #expect(attempts == [1, 2])
    #expect(server.connectionCount == 3)
    #expect(recorder.resyncCount == 0, "the first successful connection is not a reconnect")
    await client.disconnect()
  }

  @Test func rejectedUpgradesAndSilentDaemonsAreRetried() async throws {
    let server = try await TestWebSocketServer { _ in }
    server.setRejectStatus(401)
    let client = Self.client(
      server,
      options: {
        var options = Self.fastOptions
        options.helloTimeout = .milliseconds(100)
        return options
      }())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitFor("401 reason") {
      if case .state(.reconnecting(_, let reason?)) = $0 {
        reason.contains("HTTP 401")
      } else {
        false
      }
    }
    server.setRejectStatus(nil)  // now it accepts but never says hello
    try await recorder.waitFor("hello timeout") {
      if case .state(.reconnecting(_, let reason?)) = $0 { reason.contains("hello") } else { false }
    }
    server.setOnUpgrade { $0.send(TestWebSocketServer.hello) }
    try await recorder.waitForState(.connected(serverVersion: "test-1"))
    await client.disconnect()
  }

  @Test func surfaceSubscriptionsAreReplayedAfterReconnect() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let recorder = StreamRecorder(client.events())
    // Sent before connecting: the client remembers it.
    await client.send(.surfaceSubscribe(threadId: "thr_0", surface: .computer))
    await client.connect()
    let first = try await server.peer(1)
    try await recorder.waitForState(.connected(serverVersion: "test-1"))
    await client.send(.surfaceSubscribe(threadId: "thr_1", surface: .browser))
    await client.send(.surfaceSubscribe(threadId: "thr_2", surface: .computer))
    await client.send(.surfaceSubscribe(threadId: "thr_1", surface: .browser))  // duplicate
    await client.send(.surfaceUnsubscribe(threadId: "thr_2", surface: .computer))
    await client.send(.surfaceUnsubscribe(threadId: "thr_0", surface: .computer))
    try await eventually("signals on connection 1") { first.messages.count == 7 }
    #expect(
      try first.messages.map(Self.decode) == [
        .hello(clientId: "macos_test", apiVersion: 1, clientVersion: "macos/test"),
        .surfaceSubscribe(threadId: "thr_0", surface: .computer),
        .surfaceSubscribe(threadId: "thr_1", surface: .browser),
        .surfaceSubscribe(threadId: "thr_2", surface: .computer),
        .surfaceSubscribe(threadId: "thr_1", surface: .browser),
        .surfaceUnsubscribe(threadId: "thr_2", surface: .computer),
        .surfaceUnsubscribe(threadId: "thr_0", surface: .computer),
      ])

    first.drop()
    let second = try await server.peer(2)
    try await recorder.waitFor("resync") { $0 == .resync }
    try await eventually("replayed subscriptions") { second.messages.count == 2 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(
      try second.messages.map(Self.decode) == [
        .hello(clientId: "macos_test", apiVersion: 1, clientVersion: "macos/test"),
        .surfaceSubscribe(threadId: "thr_1", surface: .browser),
      ])
    await client.disconnect()
  }

  @Test func signalsAreDroppedWhileDisconnected() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    await client.send(.threadRead(threadId: "thr_early"))
    await client.send(.editorActivity(notePath: "a.md", line: 1))
    await client.connect()
    let peer = try await server.peer(1)
    let recorder = StreamRecorder(client.events())
    try await recorder.waitForState(.connected(serverVersion: "test-1"))
    await client.send(.threadRead(threadId: "thr_live"))
    try await eventually("live signal") { peer.messages.count == 2 }
    await client.disconnect()
    await client.send(.threadRead(threadId: "thr_late"))
    try await Task.sleep(for: .milliseconds(50))
    #expect(
      try peer.messages.map(Self.decode) == [
        .hello(clientId: "macos_test", apiVersion: 1, clientVersion: "macos/test"),
        .threadRead(threadId: "thr_live"),
      ])
  }

  @Test func disconnectFinishesStreamsAndClosesTheSocket() async throws {
    let server = try await TestWebSocketServer()
    let client = Self.client(server)
    let first = StreamRecorder(client.events())
    let second = StreamRecorder(client.events())
    await client.connect()
    let peer = try await server.peer(1)
    try await first.waitForState(.connected(serverVersion: "test-1"))
    #expect(client.connection.broadcaster.subscriberCount == 2)

    await client.disconnect()
    try await first.waitForFinish()
    try await second.waitForFinish()
    #expect(first.items.last == .state(.disconnected))
    #expect(second.items.last == .state(.disconnected))
    #expect(client.connection.broadcaster.subscriberCount == 0)
    try await eventually("server to see the close") { peer.isClosed }
    #expect(peer.receivedCloseCode == 1000)

    // New streams start disconnected and stay open; no reconnect happens.
    let after = StreamRecorder(client.events())
    try await after.waitFor { _ in true }
    #expect(after.items == [.state(.disconnected)])
    try await Task.sleep(for: .milliseconds(100))
    #expect(server.connectionCount == 1)
    #expect(!after.finished)

    // A consumer that stops listening is unregistered.
    after.cancel()
    try await eventually("cancelled stream to unregister") {
      client.connection.broadcaster.subscriberCount == 0
    }

    // connect() works again afterwards (and is a reconnect: resync).
    let again = StreamRecorder(client.events())
    await client.connect()
    try await again.waitFor("resync") { $0 == .resync }
    await client.disconnect()
    try await again.waitForFinish()
  }

  @Test func disconnectDuringBackoffStopsRetrying() async throws {
    let port = try closedLocalPort()
    let client = HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "t"),
      session: URLSession(configuration: .ephemeral),
      options: HTTPDaemonClient.Options(
        reconnectBackoff: ReconnectBackoff(
          initialDelay: .milliseconds(5), maximumDelay: .milliseconds(20), jitter: 0),
        pingInterval: nil))
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitFor("third attempt") {
      if case .state(.reconnecting(let attempt, _)) = $0 { attempt >= 3 } else { false }
    }
    await client.disconnect()
    try await recorder.waitForFinish()
    let count = recorder.items.count
    try await Task.sleep(for: .milliseconds(100))
    #expect(recorder.items.count == count)
    #expect(recorder.items.last == .state(.disconnected))
  }

  @Test func keepAlivePingsWhileConnected() async throws {
    let server = try await TestWebSocketServer()
    var options = Self.fastOptions
    options.pingInterval = .milliseconds(30)
    let client = Self.client(server, options: options)
    await client.connect()
    let peer = try await server.peer(1)
    try await eventually("two pings") {
      peer.messages.filter { $0.contains(#""ping""#) }.count >= 2
    }
    await client.disconnect()
  }

  @Test func backoffDelaysGrowAndAreCapped() {
    let backoff = ReconnectBackoff(
      initialDelay: .milliseconds(250), maximumDelay: .seconds(30), multiplier: 2, jitter: 0.2,
      random: { 0.5 })
    #expect(backoff.delay(forAttempt: 1) == .milliseconds(250))
    #expect(backoff.delay(forAttempt: 2) == .milliseconds(500))
    #expect(backoff.delay(forAttempt: 8) == .seconds(30))
    #expect(backoff.delay(forAttempt: 500) == .seconds(30))
    let high = ReconnectBackoff(jitter: 0.2, random: { 0.999_999 })
    let low = ReconnectBackoff(jitter: 0.2, random: { 0 })
    #expect(abs(high.delay(forAttempt: 1).seconds - 0.3) < 0.001)
    #expect(abs(low.delay(forAttempt: 1).seconds - 0.2) < 0.001)
    #expect(ReconnectBackoff.default.delay(forAttempt: 100) <= .seconds(36))
  }

  static func decode(_ text: String) throws -> ClientEvent {
    try JSONDecoder.daemon.decode(ClientEvent.self, from: Data(text.utf8))
  }
}

extension StreamRecorder {
  func waitUntilResyncs(_ count: Int, timeout: Duration = .seconds(10)) async throws {
    try await eventually("\(count) resyncs", timeout: timeout) { resyncCount >= count }
  }
}
