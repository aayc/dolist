import DailyDoListModels
import Foundation

/// A routine file as read: a port of `parseRoutineFile`, `renderRoutineFile` and
/// `updateRoutineFile` in `@ddl/core` (`routines.ts`), for the fields the fake needs.
struct FakeRoutineFile: Sendable {
  static let folder = "Routines"
  static let nameMaxLength = 100
  static let instructionsMaxLength = 8_000

  var schedule: String?
  var parsedSchedule: FakeRoutineSchedule?
  var notify: RoutineNotify
  var uses: [RoutineUse]
  var paused: Bool
  var instructions: String
  /// Why it can't run, most important first.
  var problems: [String]

  /// `Routines/<name>.md`, a direct child of the folder.
  static func isRoutinePath(_ path: String) -> Bool {
    let prefix = "\(folder)/"
    guard path.hasPrefix(prefix), path.lowercased().hasSuffix(".md") else { return false }
    let rest = path.dropFirst(prefix.count)
    return !rest.contains("/") && rest.count > 3 && !FakeVaultPaths.isHidden(path)
  }

  static func path(forName name: String) -> String { "\(folder)/\(name).md" }

  static func name(ofPath path: String) -> String {
    let file = path.split(separator: "/").last.map(String.init) ?? path
    return file.lowercased().hasSuffix(".md") ? String(file.dropLast(3)) : file
  }

  /// `rtn_<hash of the path>`, like `routineIdForPath`.
  static func id(forPath path: String) -> String { "rtn_" + ContentHash.version(of: path) }

  /// Why `name` can't be a routine's file name (`routineNameProblem`).
  static func nameProblem(_ name: String) -> String? {
    if name.trimmingCharacters(in: .whitespaces) != name || name.isEmpty {
      return "Give the routine a name."
    }
    if name.utf16.count > nameMaxLength {
      return "Keep the name under \(nameMaxLength) characters."
    }
    if name.hasPrefix(".") { return "A routine's name can't start with a dot." }
    let forbidden = Set(#"\/:*?"<>|#^[]"#)
    if name.contains(where: { forbidden.contains($0) })
      || name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
    {
      return #"A routine's name can't contain \ / : * ? " < > | # ^ [ or ]."#
    }
    return nil
  }

  // MARK: - Reading

  private static func lines(_ content: String) -> [String] {
    var text = content
    if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
    return text.replacingOccurrences(of: "\r\n", with: "\n").split(
      separator: "\n", omittingEmptySubsequences: false
    ).map(String.init)
  }

  private static func frontmatterEnd(_ lines: [String]) -> Int? {
    guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return nil }
    for index in 1..<min(lines.count, 200) {
      let line = lines[index].trimmingCharacters(in: .whitespaces)
      if line == "---" || line == "..." { return index }
    }
    return nil
  }

  private static func scalar(_ raw: String) -> String {
    let value = raw.trimmingCharacters(in: .whitespaces)
    if value.count >= 2, let quote = value.first, quote == "\"" || quote == "'",
      let close = value.dropFirst().firstIndex(of: quote)
    {
      return String(value[value.index(after: value.startIndex)..<close])
    }
    if let comment = value.range(of: " #") ?? (value.hasPrefix("#") ? value.range(of: "#") : nil) {
      return value[..<comment.lowerBound].trimmingCharacters(in: .whitespaces)
    }
    return value
  }

  private enum Value {
    case text(String)
    case list([String])
    case empty
  }

  private static func frontmatter(_ lines: [String], end: Int) -> ([String: Value], [String]) {
    var values: [String: Value] = [:]
    var problems: [String] = []
    var listKey: String?
    for line in lines[1..<end] {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
      if trimmed.hasPrefix("- "), let key = listKey {
        var list: [String] = []
        if case .list(let existing)? = values[key] { list = existing }
        let item = scalar(String(trimmed.dropFirst(2)))
        if !item.isEmpty { list.append(item) }
        values[key] = .list(list)
        continue
      }
      guard let colon = line.firstIndex(of: ":"), line.first?.isLetter == true || line.first == "_"
      else {
        if line.first?.isWhitespace == true { continue }
        problems.append("Couldn't read the frontmatter line “\(trimmed.prefix(60))”.")
        listKey = nil
        continue
      }
      let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      let raw = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      if raw.hasPrefix("["), let close = raw.lastIndex(of: "]") {
        let items = raw[raw.index(after: raw.startIndex)..<close].split(separator: ",")
          .map { scalar(String($0)) }.filter { !$0.isEmpty }
        values[key] = .list(items)
        listKey = nil
      } else {
        let value = scalar(raw)
        values[key] = value.isEmpty ? .empty : .text(value)
        listKey = value.isEmpty ? key : nil
      }
    }
    return (values, problems)
  }

  private static func joined(_ value: Value?) -> String? {
    switch value {
    case .text(let text): text
    case .list(let items): items.joined(separator: ", ")
    case .empty, nil: nil
    }
  }

  init(content: String) {
    let lines = Self.lines(content)
    let end = Self.frontmatterEnd(lines)
    let (values, frontmatterProblems) = end.map { Self.frontmatter(lines, end: $0) } ?? ([:], [])
    var problems: [String] = []
    var settings = frontmatterProblems
    schedule = Self.joined(values["schedule"])
    if end == nil {
      problems.append(
        "Add a frontmatter block with a schedule at the top, e.g. “schedule: every weekday at 7:30”."
      )
    } else if let schedule {
      switch FakeRoutineSchedule.parse(schedule) {
      case .success(let parsed): parsedSchedule = parsed
      case .failure(let error): problems.append(error.message)
      }
    } else {
      problems.append("Add a schedule to the frontmatter, e.g. “schedule: every weekday at 7:30”.")
    }

    notify = .always
    if let text = Self.joined(values["notify"])?.lowercased() {
      let normalized = text.replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
      switch normalized {
      case "always": notify = .always
      case "never": notify = .never
      case "when changed", "changed", "on change": notify = .whenChanged
      default:
        settings.append("notify must be always, when changed or never (not “\(text.prefix(40))”).")
      }
    }

    uses = []
    let items: [String] =
      switch values["uses"] {
      case .list(let list): list
      case .text(let text):
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      case .empty, nil: []
      }
    let known: [RoutineUse] = [.web, .browser, .computer, .shell, .files, .connectors]
    for item in items {
      let use = RoutineUse(rawValue: item.lowercased())
      if known.contains(use) {
        if !uses.contains(use) { uses.append(use) }
      } else {
        settings.append(
          "uses: “\(item.prefix(40))” isn't a capability (\(known.map(\.rawValue).joined(separator: ", ")))."
        )
      }
    }

    paused = false
    if let text = Self.joined(values["paused"])?.lowercased() {
      if ["true", "yes", "on"].contains(text) {
        paused = true
      } else if !["false", "no", "off"].contains(text) {
        settings.append("paused must be true or false (not “\(text.prefix(40))”).")
      }
    }

    instructions = lines[((end ?? -1) + 1)...].joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    problems += settings
    if instructions.isEmpty {
      problems.append("Write what the routine should do below the frontmatter.")
    } else if instructions.utf16.count > Self.instructionsMaxLength {
      problems.append("Keep the instructions under 8,000 characters.")
    }
    self.problems = problems
  }

  // MARK: - Writing

  private static func yamlValue(_ value: String) -> String {
    let special = Set(" -?:,[]{}#&*!|>'\"%@`\t")
    let plain =
      !value.isEmpty && !special.contains(value.first!) && !value.contains(": ")
      && !value.contains(" #") && !value.contains("\n")
      && value.trimmingCharacters(in: .whitespaces) == value
    guard !plain else { return value }
    let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  private static func notifyPhrase(_ notify: RoutineNotify) -> String {
    notify == .whenChanged ? "when changed" : notify.rawValue
  }

  /// A new routine file (`renderRoutineFile`).
  static func render(_ request: CreateRoutineRequest) -> String {
    var lines = [
      "---", "schedule: \(yamlValue(request.schedule.trimmingCharacters(in: .whitespaces)))",
    ]
    lines.append("notify: \(notifyPhrase(request.notify ?? .always))")
    if let uses = request.uses, !uses.isEmpty {
      lines.append("uses: [\(uses.map(\.rawValue).joined(separator: ", "))]")
    }
    if request.paused == true { lines.append("paused: true") }
    lines += ["---", request.instructions.trimmingCharacters(in: .whitespacesAndNewlines), ""]
    return lines.joined(separator: "\n")
  }

  /// `content` with `paused:` set, everything else as written (`updateRoutineFile`).
  static func settingPaused(_ paused: Bool, in content: String) -> String {
    var lines = lines(content)
    var end = frontmatterEnd(lines)
    if end == nil {
      lines.insert(contentsOf: ["---", "---"], at: 0)
      end = 1
    }
    let line = "paused: \(paused ? "true" : "false")"
    if let index = lines[1..<end!].firstIndex(where: {
      $0.split(separator: ":", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces)
        .lowercased() == "paused"
    }) {
      lines[index] = line
    } else {
      lines.insert(line, at: end!)
    }
    return lines.joined(separator: "\n")
  }
}
