import DailyDoListModels
import Foundation

/// `searchVault` of `@ddl/storage`: case-insensitive; every whitespace-separated term must appear
/// in the note's name or on one line. Name hits come first (`kind: name`, line 0, the path as
/// preview), then one hit per matching line (0-based) from the most recently modified notes, with
/// a ~160-character preview centred on the first term.
enum FakeVaultSearch {
  struct Note {
    let path: String
    let content: String
    let mtime: EpochMillis
    let size: Int
  }

  static let previewCharacters = 160
  static let maxFileBytes = 1_000_000

  static func search(_ query: String, in notes: [Note], limit: Int) -> [SearchHit] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty, limit > 0 else { return [] }
    var terms: [String] = []
    for term in needle.split(whereSeparator: \.isWhitespace).map(String.init) where !terms.contains(term) {
      terms.append(term)
    }
    let sorted = notes
      .filter { FakeVaultPaths.isMarkdown($0.path) && !FakeVaultPaths.isHidden($0.path) }
      .sorted { $0.mtime != $1.mtime ? $0.mtime > $1.mtime : $0.path < $1.path }
    var hits: [SearchHit] = []
    // Queries with a slash match the whole path; otherwise just the note's name.
    let matchPath = needle.contains("/")
    for note in sorted {
      let name = (matchPath ? String(note.path.dropLast(3)) : FakeVaultPaths.stem(note.path)).lowercased()
      if terms.allSatisfy({ name.containsLiteral($0) }) {
        hits.append(SearchHit(path: note.path, kind: .name, line: 0, preview: note.path))
        if hits.count >= limit { return hits }
      }
    }
    for note in sorted where note.size <= maxFileBytes {
      for (index, line) in note.content.textLines.enumerated() {
        let text = String(line)
        let lower = text.lowercased()
        guard let first = terms.first, let range = lower.range(of: first, options: .literal),
          terms.dropFirst().allSatisfy({ lower.containsLiteral($0) })
        else { continue }
        let start = lower.utf16.distance(from: lower.startIndex, to: range.lowerBound)
        hits.append(SearchHit(path: note.path, kind: .content, line: index, preview: preview(text, start, first.utf16.count)))
        if hits.count >= limit { return hits }
      }
    }
    return hits
  }

  /// The line, or a window of it centred on the match with ellipses where it was cut (in UTF-16
  /// units, like the JavaScript original).
  static func preview(_ line: String, _ matchStart: Int, _ matchLength: Int) -> String {
    let units = Array(line.utf16)
    if units.count <= previewCharacters { return line.trimmingCharacters(in: .whitespacesAndNewlines) }
    let center = matchStart + matchLength / 2
    let start = max(0, min(center - previewCharacters / 2, units.count - previewCharacters))
    let end = min(units.count, start + previewCharacters)
    let body = String(decoding: units[start..<end], as: UTF16.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return (start > 0 ? "…" : "") + body + (end < units.count ? "…" : "")
  }
}

extension String {
  /// Code-unit substring test, like JavaScript's `includes` (no Unicode equivalence folding).
  fileprivate func containsLiteral(_ other: String) -> Bool {
    range(of: other, options: .literal) != nil
  }
}

extension String {
  /// Lines split on `\n` without their `\r` (Swift's `"\r\n"` is one Character, so a plain
  /// `split(separator: "\n")` would not split CRLF text).
  var textLines: [Substring] {
    split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
      .map { $0.hasSuffix("\r") ? $0.dropLast() : $0 }
  }
}
