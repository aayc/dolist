import DailyDoListModels

/// Minimal reference to a server-tracked task, enough to re-find it in an edited document.
public struct TaskAnchor: Hashable, Sendable, Codable {
  public var taskId: String
  public var text: String
  /// Last known 0-based line.
  public var line: Int

  public init(taskId: String, text: String, line: Int) {
    self.taskId = taskId
    self.text = text
    self.line = line
  }

  /// The anchor of a daemon task record (its latest text and line).
  public init(record: TaskAgentRecord) {
    self.init(taskId: record.taskId, text: record.text, line: record.line)
  }
}

/// Port of @ddl/core `markdown/anchors.ts`.
public enum TaskAnchors {
  /// `resolveTaskAnchors`: re-resolves server task anchors against the current (possibly locally
  /// edited) document with the daemon's identity algorithm. Returns taskId → 0-based line for
  /// every anchor still found; an anchor whose task was deleted is absent.
  public static func resolve(_ doc: String, anchors: [TaskAnchor]) -> [String: Int] {
    resolve(tasks: TaskParser.parse(doc), anchors: anchors)
  }

  /// `resolveTaskAnchors` on already parsed tasks.
  public static func resolve(tasks: [ParsedTask], anchors: [TaskAnchor]) -> [String: Int] {
    let matchOf = TaskMatcher(
      previous: anchors.map { ($0.text, $0.line) }, parsed: tasks.map { ($0.text, $0.line) },
      threshold: TaskTracker.defaultSimilarityThreshold
    ).match()
    var lines: [String: Int] = [:]
    for (pi, task) in tasks.enumerated() where matchOf[pi] >= 0 {
      let id = anchors[matchOf[pi]].taskId
      if !id.isEmpty { lines[id] = task.line }
    }
    return lines
  }
}
