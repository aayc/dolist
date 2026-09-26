import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// Where the app's data comes from.
enum ConnectionKind: Equatable, Sendable {
  case daemon(URL)
  /// The demo's daemon (`--demo` / `DDL_DEMO=1`): mock agent, throwaway demo vault.
  case demo(URL)
}

/// Live state of the daemon connection for the status bar and the offline banner.
@MainActor
@Observable
final class ConnectionStore {
  private(set) var state: ConnectionState = .idle
  private(set) var kind: ConnectionKind?
  private(set) var health: HealthResponse?
  /// Set once the event stream connected at least once (the banner only shows after that).
  private(set) var hasConnected = false

  func setKind(_ kind: ConnectionKind?) {
    self.kind = kind
  }

  func setHealth(_ health: HealthResponse?) {
    self.health = health
  }

  func update(_ state: ConnectionState) {
    self.state = state
    if case .connected = state { hasConnected = true }
  }

  func reset() {
    state = .idle
    kind = nil
    health = nil
    hasConnected = false
  }

  var isOnline: Bool {
    if case .connected = state { return true }
    return false
  }

  var isDemo: Bool {
    if case .demo = kind { return true }
    return false
  }

  /// The unobtrusive "offline" banner: we were connected and lost it.
  var showsOfflineBanner: Bool {
    guard hasConnected else { return false }
    switch state {
    case .reconnecting, .disconnected: return true
    default: return false
    }
  }

  var serverVersion: String? {
    if case .connected(let version) = state { return version }
    return health?.version
  }

  var endpointDescription: String {
    switch kind {
    case .daemon(let url), .demo(let url): url.absoluteString
    case nil: "—"
    }
  }

  /// Status bar label.
  var label: String {
    switch state {
    case .connected: isDemo ? "Demo" : "Connected"
    case .connecting, .idle: "Connecting…"
    case .reconnecting: "Reconnecting…"
    case .incompatible: "Incompatible daemon"
    case .disconnected: "Offline"
    }
  }

  var detail: String {
    switch state {
    case .connected(let version):
      isDemo
        ? "Demo daemon \(version) at \(endpointDescription): the mock agent on a throwaway vault"
        : "Daemon \(version) at \(endpointDescription)"
    case .connecting, .idle: "Connecting to \(endpointDescription)"
    case .reconnecting(let attempt, let reason):
      "Reconnecting (attempt \(attempt))\(reason.map { ": \($0)" } ?? "")"
    case .incompatible(let server):
      "The daemon speaks API v\(server); this app needs v\(DaemonProtocol.apiVersion)."
    case .disconnected: "Disconnected from \(endpointDescription)"
    }
  }
}
