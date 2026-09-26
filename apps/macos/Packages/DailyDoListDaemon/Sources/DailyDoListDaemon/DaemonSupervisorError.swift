import Foundation

/// Why the supervisor could not get a daemon. `message` is what `.failed(reason:)` shows.
public enum DaemonSupervisorError: Error, Hashable, Sendable {
  /// No Node binary anywhere in the search order (`searched` lists what was tried).
  case nodeNotFound(searched: [String])
  /// An explicitly configured Node binary (configuration or `DDL_NODE`) is missing or unusable.
  case configuredNodeUnusable(path: String, source: String, detail: String)
  /// Node binaries were found but none is recent enough (or runnable); `found` has one line each.
  case nodeUnsupported(found: [String])
  /// No `dist/main.js` in the search order.
  case daemonEntryNotFound(searched: [String])
  /// An explicitly configured daemon entry (configuration or `DDL_DAEMON_ENTRY`) doesn't exist.
  case configuredEntryMissing(path: String, source: String)
  /// Something that isn't the Daily Do List daemon answers on the port.
  case portInUse(port: Int, detail: String)
  /// A Daily Do List daemon answers on the port but rejects the token in `tokenFile`.
  case tokenRejected(port: Int, tokenFile: String)
  /// Attach-only mode and nothing answers.
  case notRunning(port: Int)
  case launchFailed(String)
  /// The launched process exited before it answered a health check.
  case exitedDuringStartup(exit: String, logTail: [String])
  /// The launched process never answered a health check.
  case startupTimedOut(seconds: Int, logTail: [String])
  /// Too many failures within the restart window; `reason` is the last failure's summary.
  case gaveUp(reason: String, failures: Int, logTail: [String])

  /// One or two sentences, without daemon output.
  public var summary: String {
    switch self {
    case .nodeNotFound(let searched):
      return """
        Node.js \(NodeVersion.minimumSupported) or newer is required to run the Daily Do List \
        daemon, but no Node binary was found (looked in: \(searched.joined(separator: ", "))). \
        Install Node.js 24 (for example `brew install node`) or set DDL_NODE to its path.
        """
    case .configuredNodeUnusable(let path, let source, let detail):
      return "The Node binary set by \(source) (\(path)) can't be used: \(detail)."
    case .nodeUnsupported(let found):
      return """
        Node.js \(NodeVersion.minimumSupported) or newer is required to run the Daily Do List \
        daemon. Found: \(found.joined(separator: "; ")). Install Node.js 24 (for example \
        `brew install node`) or set DDL_NODE to a recent enough binary.
        """
    case .daemonEntryNotFound(let searched):
      return """
        The daemon (dist/main.js) was not found. Looked in: \(searched.joined(separator: ", ")). \
        Build it with `pnpm --filter @ddl/daemon build`, package the app with \
        `scripts/build-app.sh --with-daemon`, or set DDL_DAEMON_ENTRY.
        """
    case .configuredEntryMissing(let path, let source):
      return "The daemon entry set by \(source) doesn't exist: \(path)."
    case .portInUse(let port, let detail):
      return """
        Port \(port) on 127.0.0.1 is in use by another program that isn't the Daily Do List \
        daemon (\(detail)). Quit that program or choose another port (DDL_PORT).
        """
    case .tokenRejected(let port, let tokenFile):
      return """
        A Daily Do List daemon is already running on port \(port), but it rejected the token in \
        \(tokenFile). It was probably started with a different DDL_HOME, or the token was rotated \
        while it ran. Stop (or restart) that daemon and try again.
        """
    case .notRunning(let port):
      return """
        No Daily Do List daemon is running on port \(port), and this app is set to only attach \
        to one. Start it with `pnpm dev` (or `pnpm start`) and try again.
        """
    case .launchFailed(let detail):
      return "Couldn't launch the daemon: \(detail)."
    case .exitedDuringStartup(let exit, _):
      return "The daemon \(exit) while starting."
    case .startupTimedOut(let seconds, _):
      return "The daemon didn't answer health checks within \(seconds) s."
    case .gaveUp(let reason, let failures, _):
      return "Gave up restarting the daemon after \(failures) failures in quick succession. "
        + "Last failure: \(reason)"
    }
  }

  /// `summary` plus the daemon's last output lines, when there are any.
  public var message: String {
    let tail: [String]
    switch self {
    case .exitedDuringStartup(_, let lines), .startupTimedOut(_, let lines),
      .gaveUp(_, _, let lines):
      tail = lines
    default:
      tail = []
    }
    return tail.isEmpty
      ? summary : summary + "\n\nLast daemon output:\n" + tail.joined(separator: "\n")
  }
}

extension DaemonSupervisorError: LocalizedError {
  public var errorDescription: String? { message }
}
