import DailyDoListDomain
import Foundation

/// A row of the command palette or quick switcher.
struct PaletteItem: Identifiable, Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    case command(CommandID)
    case note(String)
  }

  let kind: Kind
  let title: String
  /// Folder (notes) — shown dimmed after the title.
  let subtitle: String?
  /// A command's shortcut (drawn as keycaps).
  let shortcut: Shortcut?
  /// Matched characters of `title` as UTF-16 offsets (highlighted).
  let highlights: [Int]

  var id: String {
    switch kind {
    case .command(let id): "command:\(id.rawValue)"
    case .note(let path): "note:\(path)"
    }
  }
}

/// Fuzzy ranking for the palette (commands) and the quick switcher (notes), mirroring the web app.
enum PaletteRanking {
  static let noteLimit = 50
  static let commandLimit = 100

  /// Whitespace is ignored in queries ("new note" matches "Create new note").
  static func normalize(_ query: String) -> String {
    query.filter { !$0.isWhitespace }
  }

  static func commands(_ query: String, from commands: [AppCommand]) -> [PaletteItem] {
    let q = normalize(query)
    func item(_ command: AppCommand, _ highlights: [Int]) -> PaletteItem {
      PaletteItem(
        kind: .command(command.id), title: command.paletteTitle, subtitle: nil,
        shortcut: command.shortcut, highlights: highlights)
    }
    guard !q.isEmpty else {
      return
        commands
        .sorted { $0.paletteTitle.localizedStandardCompare($1.paletteTitle) == .orderedAscending }
        .map { item($0, []) }
    }
    return
      commands
      .compactMap { command in Fuzzy.match(q, in: command.paletteTitle).map { (command, $0) } }
      .sorted { a, b in
        a.1.score != b.1.score
          ? a.1.score > b.1.score : a.0.paletteTitle.count < b.0.paletteTitle.count
      }
      .prefix(commandLimit)
      .map { item($0.0, $0.1.matchedOffsets) }
  }

  /// Notes matching `query` by name (bonus) or by path; best first, shorter paths on ties.
  static func notes(_ query: String, files: [String], limit: Int = noteLimit) -> [PaletteItem] {
    let q = normalize(query)
    guard !q.isEmpty else { return [] }
    var ranked: [(item: PaletteItem, score: Double)] = []
    for path in files {
      let name = NotePaths.displayName(path, isFolder: false)
      let folder = VaultPath.dirname(path)
      if let byName = Fuzzy.match(q, in: name) {
        ranked.append(
          (
            note(path, name: name, folder: folder, highlights: byName.matchedOffsets),
            byName.score + 4
          ))
      } else if let byPath = Fuzzy.match(q, in: strippedMarkdown(path)) {
        ranked.append((note(path, name: name, folder: folder, highlights: []), byPath.score))
      }
    }
    ranked.sort { a, b in
      a.score != b.score ? a.score > b.score : noteKey(a.item).count < noteKey(b.item).count
    }
    return ranked.prefix(limit).map(\.item)
  }

  /// Empty query: recently used notes first, then open tabs, then the rest newest-path-first
  /// (daily notes sort newest first).
  static func defaultNotes(
    files: [String], recent: [String], openTabs: [String], limit: Int = noteLimit
  ) -> [PaletteItem] {
    let existing = Set(files)
    var seen = Set<String>()
    var ordered: [String] = []
    for path in recent where existing.contains(path) && seen.insert(path).inserted {
      ordered.append(path)
    }
    let open = Set(openTabs)
    let rest =
      files
      .filter { !seen.contains($0) }
      .sorted { a, b in open.contains(a) != open.contains(b) ? open.contains(a) : a > b }
    ordered.append(contentsOf: rest)
    return ordered.prefix(limit).map {
      note(
        $0, name: NotePaths.displayName($0, isFolder: false), folder: VaultPath.dirname($0),
        highlights: [])
    }
  }

  private static func note(_ path: String, name: String, folder: String, highlights: [Int])
    -> PaletteItem
  {
    PaletteItem(
      kind: .note(path), title: name, subtitle: folder.isEmpty ? nil : folder, shortcut: nil,
      highlights: highlights)
  }

  private static func noteKey(_ item: PaletteItem) -> String {
    if case .note(let path) = item.kind { return path }
    return item.title
  }

  private static func strippedMarkdown(_ path: String) -> String {
    VaultPath.isMarkdown(path) ? String(path.dropLast(3)) : path
  }
}
