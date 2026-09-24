import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation

/// Why the app could not get to a usable daemon, with what the boot screen offers for each case.
enum BootFailure: Error, Equatable, Sendable {
  /// Nothing answers (external mode, or an attach-only supervisor).
  case daemonNotRunning(detail: String)
  /// Node.js 24 is missing or too old (managed mode).
  case nodeMissing(detail: String)
  /// The daemon bundle (`dist/main.js`) wasn't found (managed mode).
  case daemonNotFound(detail: String)
  case portInUse(detail: String)
  /// The daemon rejected our token (401).
  case unauthorized(detail: String)
  case incompatibleApiVersion(server: Int)
  /// The managed daemon crashed during startup or kept crashing.
  case daemonFailed(detail: String)
  case invalidConfiguration(detail: String)
  case other(detail: String)

  var title: String {
    switch self {
    case .daemonNotRunning: "The Daily Do List daemon isn't running"
    case .nodeMissing: "Node.js 24 is required"
    case .daemonNotFound: "The daemon wasn't found"
    case .portInUse: "The daemon's port is taken"
    case .unauthorized: "The daemon rejected this app"
    case .incompatibleApiVersion: "This app and the daemon don't match"
    case .daemonFailed: "The daemon couldn't start"
    case .invalidConfiguration: "The connection settings are invalid"
    case .other: "Couldn't connect to the daemon"
    }
  }

  var message: String {
    switch self {
    case .daemonNotRunning(let detail), .nodeMissing(let detail), .daemonNotFound(let detail),
      .portInUse(let detail), .unauthorized(let detail), .daemonFailed(let detail),
      .invalidConfiguration(let detail), .other(let detail):
      detail
    case .incompatibleApiVersion(let server):
      server > DaemonProtocol.apiVersion
        ? "The daemon speaks API v\(server) but this app needs v\(DaemonProtocol.apiVersion). Update the app."
        : "The daemon speaks API v\(server) but this app needs v\(DaemonProtocol.apiVersion). Update the daemon."
    }
  }

  /// Offer to start a managed daemon (only meaningful when the app isn't already managing one).
  var offersStartDaemon: Bool {
    if case .daemonNotRunning = self { return true }
    return false
  }

  /// Node.js download page for `nodeMissing`.
  var helpURL: URL? {
    if case .nodeMissing = self { return URL(string: "https://nodejs.org/en/download") }
    return nil
  }

  /// Classifies a client error from the first health check.
  init(_ error: Error) {
    switch error as? DaemonClientError {
    case .unreachable(let reason):
      self = .daemonNotRunning(
        detail:
          "Nothing answered (\(reason)). Start the daemon with `pnpm dev`, or let the app manage it."
      )
    case .unauthorized:
      self = .unauthorized(
        detail:
          "The token in the daemon-token file doesn't match the running daemon. It was probably started with a different DDL_HOME; restart it or fix DDL_HOME in Settings."
      )
    case .incompatibleApiVersion(let server):
      self = .incompatibleApiVersion(server: server)
    case .some(let clientError):
      self = .other(detail: clientError.errorDescription ?? "\(clientError)")
    case nil:
      self = .other(
        detail: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
    }
  }

  /// Classifies a supervisor failure (managed mode).
  init(supervisorError: DaemonSupervisorError?, state: DaemonSupervisorState) {
    guard let error = supervisorError else {
      if case .failed(let reason) = state {
        self = .daemonFailed(detail: reason)
      } else {
        self = .daemonFailed(detail: "The daemon didn't start (\(state.summary)).")
      }
      return
    }
    switch error {
    case .nodeNotFound, .nodeUnsupported, .configuredNodeUnusable:
      self = .nodeMissing(detail: error.summary)
    case .daemonEntryNotFound, .configuredEntryMissing:
      self = .daemonNotFound(detail: error.summary)
    case .portInUse:
      self = .portInUse(detail: error.summary)
    case .tokenRejected:
      self = .unauthorized(detail: error.summary)
    case .notRunning:
      self = .daemonNotRunning(detail: error.summary)
    default:
      // Launch failures, crashes during startup, timeouts, giving up (and future cases).
      self = .daemonFailed(detail: error.message)
    }
  }
}
