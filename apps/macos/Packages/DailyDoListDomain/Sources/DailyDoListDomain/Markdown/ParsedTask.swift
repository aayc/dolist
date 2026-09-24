/// A markdown checkbox task. Offsets are UTF-16 code units (same as JavaScript and NSString).
public struct ParsedTask: Hashable, Sendable, Codable {
  /// 0-based line index in the document.
  public var line: Int
  /// Leading whitespace width (tab = 4 columns).
  public var indent: Int
  /// Nesting depth among list items (0 = top level).
  public var depth: Int
  /// List marker: `-`, `*`, `+`, `1.` or `1)`.
  public var marker: String
  /// The raw character between the brackets (one UTF-16 code unit).
  public var statusChar: String
  public var status: TaskStatus
  /// Task text after the checkbox, trimmed.
  public var text: String
  /// The full raw line, without its line break (and without the `\r` of a CRLF).
  public var raw: String
  /// Document offset of the line start.
  public var from: Int
  /// Document offset of the line end (exclusive of the line break).
  public var to: Int
  /// Document offset where the task text begins (before trimming; `to` when there is none).
  public var textFrom: Int
  /// Line of the nearest ancestor task, if this task is nested under one.
  public var parentLine: Int?
  /// Non-task lines nested under this task (sub-bullets / notes), trimmed. Agent context.
  public var notes: [String]
  /// Wikilink targets mentioned in the task text (e.g. forwarded-to daily notes).
  public var links: [String]
  /// The agent wrote this task: its line ends with an agent marker, which `text` and `notes`
  /// leave out (`raw` keeps it).
  public var agent: Bool

  public init(
    line: Int, indent: Int, depth: Int, marker: String, statusChar: String, status: TaskStatus,
    text: String, raw: String, from: Int, to: Int, textFrom: Int, parentLine: Int?,
    notes: [String], links: [String], agent: Bool = false
  ) {
    self.line = line
    self.indent = indent
    self.depth = depth
    self.marker = marker
    self.statusChar = statusChar
    self.status = status
    self.text = text
    self.raw = raw
    self.from = from
    self.to = to
    self.textFrom = textFrom
    self.parentLine = parentLine
    self.notes = notes
    self.links = links
    self.agent = agent
  }
}
