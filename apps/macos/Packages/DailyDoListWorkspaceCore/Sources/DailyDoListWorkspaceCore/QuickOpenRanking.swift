import DailyDoListDomain
import Foundation

/// Shared Mac/phone ranking. It accepts plain identifiers and never loads note contents.
public enum QuickOpenRanking {
  public struct Item: Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let highlights: [Int]
  }
  public struct Command: Sendable {
    public let id: String
    public let title: String
    public init(id: String, title: String) {
      self.id = id
      self.title = title
    }
  }

  public static func normalize(_ query: String) -> String { query.filter { !$0.isWhitespace } }

  public static func commands(_ query: String, from commands: [Command], limit: Int = 100) -> [Item]
  {
    let query = normalize(query)
    guard !query.isEmpty else {
      return commands.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        .prefix(max(0, limit)).map {
          Item(id: $0.id, title: $0.title, subtitle: nil, highlights: [])
        }
    }
    return commands.compactMap { command in
      Fuzzy.match(query, in: command.title).map { (command, $0) }
    }
    .sorted { a, b in
      a.1.score != b.1.score ? a.1.score > b.1.score : a.0.title.count < b.0.title.count
    }
    .prefix(max(0, limit)).map {
      Item(id: $0.0.id, title: $0.0.title, subtitle: nil, highlights: $0.1.matchedOffsets)
    }
  }

  public static func notes(_ query: String, files: [String], limit: Int = 50) -> [Item] {
    let query = normalize(query)
    guard !query.isEmpty else { return [] }
    var ranked: [(item: Item, score: Double)] = []
    for path in files {
      let name = NotePaths.displayName(path, isFolder: false)
      if let match = Fuzzy.match(query, in: name) {
        ranked.append((note(path, highlights: match.matchedOffsets), match.score + 4))
      } else if let match = Fuzzy.match(
        query, in: VaultPath.isMarkdown(path) ? String(path.dropLast(3)) : path)
      {
        ranked.append((note(path), match.score))
      }
    }
    ranked.sort { a, b in
      a.score != b.score
        ? a.score > b.score
        : a.item.id.count != b.item.id.count
          ? a.item.id.count < b.item.id.count : a.item.id < b.item.id
    }
    return ranked.prefix(max(0, limit)).map(\.item)
  }

  public static func defaultNotes(
    files: [String], recent: [String], openTabs: [String], limit: Int = 50
  ) -> [Item] {
    let existing = Set(files)
    var seen: Set<String> = []
    var ordered: [String] = []
    for path in recent where existing.contains(path) && seen.insert(path).inserted {
      ordered.append(path)
    }
    let open = Set(openTabs)
    ordered.append(
      contentsOf: files.filter { !seen.contains($0) }.sorted {
        open.contains($0) != open.contains($1) ? open.contains($0) : $0 > $1
      })
    return ordered.prefix(max(0, limit)).map { note($0) }
  }

  /// Bounded cyclic selection, also used by phone hardware-keyboard navigation.
  public static func movingSelection(_ index: Int, by delta: Int, count: Int) -> Int {
    guard count > 0 else { return 0 }
    return ((index % count + delta % count) % count + count) % count
  }

  private static func note(_ path: String, highlights: [Int] = []) -> Item {
    let folder = VaultPath.dirname(path)
    return Item(
      id: path, title: NotePaths.displayName(path, isFolder: false),
      subtitle: folder.isEmpty ? nil : folder, highlights: highlights)
  }
}
