import DailyDoListModels

/// One problem of a request the daemon refused (400 `invalid_request`).
public struct ValidationProblem: Hashable, Sendable {
  /// Where in the request (`name`, `remoteHosts[0]`), when the daemon said.
  public var path: String?
  public var message: String

  public init(path: String?, message: String) {
    self.path = path
    self.message = message
  }

  /// `remoteHosts[0]: must be a DNS name…`
  public var description: String { path.map { "\($0): \(message)" } ?? message }
}

extension ApiErrorBody {
  /// The problems of a validation error, in order. The daemon reports each as
  /// `✖ <message>\n  → at <path>`; a message in another form is one problem without a path.
  public var problems: [ValidationProblem] {
    guard let message, !message.isEmpty else { return [] }
    var problems: [ValidationProblem] = []
    for raw in message.split(separator: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("→ at "), let last = problems.indices.last, problems[last].path == nil {
        problems[last].path = String(line.dropFirst(5))
      } else {
        let text = line.hasPrefix("✖ ") ? String(line.dropFirst(2)) : line
        problems.append(ValidationProblem(path: nil, message: text))
      }
    }
    return problems
  }
}
