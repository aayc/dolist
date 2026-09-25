import Foundation

/// Whether a line is still the line a badge was placed on (the rule the orchestrator's chips
/// follow through edits, and that hosts use to place them). Texts are compared trimmed,
/// lowercased, with blanks collapsed and without an agent marker; a line is recognized when the
/// texts are equal, one extends the other (still typing, or trimmed back), or they're similar
/// enough (Sørensen–Dice over character bigrams, like the task tracker's fuzzy pass).
public enum EditorLineMatch {
  /// Least similarity of a recognized line.
  public static let threshold = 0.5
  /// Shortest text that counts as extending the other.
  static let minimumPrefix = 3

  public static func recognizes(_ original: String, _ current: String) -> Bool {
    let a = Array(normalize(original))
    let b = Array(normalize(current))
    if a == b { return true }
    guard !a.isEmpty, !b.isEmpty else { return false }
    if min(a.count, b.count) >= minimumPrefix, a.starts(with: b) || b.starts(with: a) {
      return true
    }
    return dice(a, b) >= threshold
  }

  /// Similarity of two lines (0…1) after normalizing them.
  public static func similarity(_ original: String, _ current: String) -> Double {
    let a = Array(normalize(original))
    let b = Array(normalize(current))
    return a == b ? 1 : dice(a, b)
  }

  /// The text compared: without an agent marker, trimmed, lowercased, blanks collapsed.
  public static func normalize(_ text: String) -> String {
    var units = Array(text.utf16)
    if let marker = AgentMarker.scan(units) {
      units.removeSubrange(marker.range.location..<units.count)
    }
    return String(utf16Units: units[...]).split(whereSeparator: \.isWhitespace)
      .joined(separator: " ").lowercased()
  }

  private static func dice(_ a: [Character], _ b: [Character]) -> Double {
    guard a.count >= 2, b.count >= 2 else { return 0 }
    var bigrams: [Bigram: Int] = [:]
    bigrams.reserveCapacity(a.count)
    for index in 0..<(a.count - 1) { bigrams[Bigram(a[index], a[index + 1]), default: 0] += 1 }
    var overlap = 0
    for index in 0..<(b.count - 1) {
      let bigram = Bigram(b[index], b[index + 1])
      if let count = bigrams[bigram], count > 0 {
        bigrams[bigram] = count - 1
        overlap += 1
      }
    }
    return 2 * Double(overlap) / Double(a.count - 1 + b.count - 1)
  }

  private struct Bigram: Hashable {
    let first: Character
    let second: Character
    init(_ first: Character, _ second: Character) {
      self.first = first
      self.second = second
    }
  }
}
