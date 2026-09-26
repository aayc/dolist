import DailyDoListModels
import Foundation
import Testing
import os

@testable import DailyDoListClient

struct DaemonEndpointTests {
  /// A temporary DDL_HOME, removed by `cleanup()`.
  struct TempHome {
    let url: URL

    init() throws {
      url = FileManager.default.temporaryDirectory
        .appendingPathComponent("ddl-client-tests-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func write(_ name: String, _ content: String) throws {
      try Data(content.utf8).write(to: url.appendingPathComponent(name))
    }

    func cleanup() { try? FileManager.default.removeItem(at: url) }
  }

  @Test func webSocketURLCarriesTheToken() {
    let endpoint = DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:7331")!, token: "abc123")
    #expect(endpoint.webSocketURL.absoluteString == "ws://127.0.0.1:7331/ws?token=abc123")
    let secure = DaemonEndpoint(baseURL: URL(string: "https://localhost:8443/")!, token: "t")
    #expect(secure.webSocketURL.absoluteString == "wss://localhost:8443/ws?token=t")
    #expect(
      endpoint.url(forPath: "/api/health")?.absoluteString == "http://127.0.0.1:7331/api/health")
    let trailing = DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:7331/")!, token: "t")
    #expect(
      trailing.url(forPath: "/api/notes/a%20b.md")?.absoluteString
        == "http://127.0.0.1:7331/api/notes/a%20b.md")
  }

  @Test func onlyLoopbackDaemonsGetTheTokenInTheWebSocketURL() throws {
    for base in ["http://127.0.0.1:7331", "http://localhost:7331", "http://[::1]:7331"] {
      let endpoint = DaemonEndpoint(baseURL: try #require(URL(string: base)), token: "abc123")
      #expect(endpoint.isLoopback, "\(base)")
      #expect(endpoint.webSocketURL.query == "token=abc123")
      #expect(endpoint.webSocketRequest.value(forHTTPHeaderField: "Authorization") == nil)
    }
    let remote = DaemonEndpoint(
      baseURL: try #require(URL(string: "https://vm-name.tailnet-name.ts.net")), token: "abc123")
    #expect(!remote.isLoopback)
    #expect(remote.webSocketURL.absoluteString == "wss://vm-name.tailnet-name.ts.net/ws")
    #expect(remote.webSocketRequest.url == remote.webSocketURL)
    #expect(remote.webSocketRequest.value(forHTTPHeaderField: "Authorization") == "Bearer abc123")
    // An address that only looks local is remote too.
    for base in ["http://0.0.0.0:7331", "http://192.168.1.20:7331", "http://localhost.example"] {
      let endpoint = DaemonEndpoint(baseURL: try #require(URL(string: base)), token: "t")
      #expect(!endpoint.isLoopback, "\(base)")
      #expect(endpoint.webSocketURL.query == nil)
    }
  }

  @Test func discoverReadsAndTrimsTheToken() throws {
    let home = try TempHome()
    defer { home.cleanup() }
    try home.write("daemon-token", "  0123abcd\n")
    let endpoint = try DaemonEndpoint.discover(home: home.url, port: 7331)
    #expect(
      endpoint == DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:7331")!, token: "0123abcd"))
    #expect(
      try DaemonEndpoint.discover(home: home.url, port: 9000).baseURL.absoluteString
        == "http://127.0.0.1:9000")
  }

  @Test func discoverFailsWithTypedErrors() throws {
    let home = try TempHome()
    defer { home.cleanup() }
    let tokenPath = home.url.appendingPathComponent("daemon-token").path
    #expect(throws: DaemonDiscoveryError.tokenFileMissing(path: tokenPath)) {
      try DaemonEndpoint.discover(home: home.url, port: 7331)
    }
    try home.write("daemon-token", " \n\t")
    #expect(throws: DaemonDiscoveryError.tokenFileEmpty(path: tokenPath)) {
      try DaemonEndpoint.discover(home: home.url, port: 7331)
    }
    try home.write("daemon-token", "abc")
    #expect(throws: DaemonDiscoveryError.invalidPort(70000)) {
      try DaemonEndpoint.discover(home: home.url, port: 70000)
    }
    let message =
      DaemonDiscoveryError.tokenFileMissing(
        path: NSHomeDirectory() + "/.daily-do-list/daemon-token"
      )
      .errorDescription ?? ""
    #expect(
      message.contains("~/.daily-do-list/daemon-token") && !message.contains(NSHomeDirectory()))
  }

  // MARK: - waitUntilHealthy

  @Test func waitUntilHealthyRetriesUntilTheDaemonAnswers() async throws {
    let calls = Counter()
    let stub = Stub { _ in
      calls.increment() <= 2
        ? .fail(URLError(.cannotConnectToHost)) : .json(value: SampleWire.health)
    }
    let healthy = await stub.client().waitUntilHealthy(
      timeout: .seconds(5), pollInterval: .milliseconds(5))
    #expect(healthy)
    #expect(calls.value == 3)
  }

  @Test func waitUntilHealthyGivesUpOnATokenMismatch() async throws {
    let stub = Stub { _ in .json(401, #"{"error":"unauthorized"}"#) }
    let clock = ContinuousClock()
    let start = clock.now
    let healthy = await stub.client().waitUntilHealthy(timeout: .seconds(5))
    #expect(!healthy)
    #expect(start.duration(to: clock.now) < .seconds(1))
  }

  @Test func waitUntilHealthyTimesOut() async throws {
    let clock = ContinuousClock()
    let refused = Stub { _ in .fail(URLError(.cannotConnectToHost)) }
    var start = clock.now
    #expect(
      await !refused.client().waitUntilHealthy(
        timeout: .milliseconds(150), pollInterval: .milliseconds(10)))
    #expect(start.duration(to: clock.now) < .seconds(2))

    // A daemon that accepts but never answers doesn't hold the caller past the deadline.
    let hanging = Stub { _ in .hang }
    start = clock.now
    #expect(await !hanging.client().waitUntilHealthy(timeout: .milliseconds(150)))
    #expect(start.duration(to: clock.now) < .seconds(2))
  }
}

final class Counter: Sendable {
  private let count = OSAllocatedUnfairLock(initialState: 0)

  /// Increments and returns the new value.
  func increment() -> Int {
    count.withLock { count in
      count += 1
      return count
    }
  }

  var value: Int { count.withLock { $0 } }
}
