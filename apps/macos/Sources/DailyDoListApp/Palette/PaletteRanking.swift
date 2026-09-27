import DailyDoListWorkspaceCore
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

  static func normalize(_ query: String) -> String { QuickOpenRanking.normalize(query) }

  static func commands(_ query: String, from commands: [AppCommand]) -> [PaletteItem] {
    let definitions = commands.map {
      QuickOpenRanking.Command(id: $0.id.rawValue, title: $0.paletteTitle)
    }
    return QuickOpenRanking.commands(query, from: definitions, limit: commandLimit).compactMap {
      ranked in
      guard let command = commands.first(where: { $0.id.rawValue == ranked.id }) else { return nil }
      return PaletteItem(
        kind: .command(command.id), title: ranked.title, subtitle: nil,
        shortcut: command.shortcut, highlights: ranked.highlights)
    }
  }

  static func notes(_ query: String, files: [String], limit: Int = noteLimit) -> [PaletteItem] {
    QuickOpenRanking.notes(query, files: files, limit: limit).map(note)
  }

  static func defaultNotes(
    files: [String], recent: [String], openTabs: [String], limit: Int = noteLimit
  ) -> [PaletteItem] {
    QuickOpenRanking.defaultNotes(files: files, recent: recent, openTabs: openTabs, limit: limit)
      .map(note)
  }

  private static func note(_ ranked: QuickOpenRanking.Item) -> PaletteItem {
    PaletteItem(
      kind: .note(ranked.id), title: ranked.title, subtitle: ranked.subtitle,
      shortcut: nil, highlights: ranked.highlights)
  }
}
