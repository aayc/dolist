import Foundation

enum TextMetrics {
  private static let wordCharacters = CharacterSet.letters
    .union(.decimalDigits)
    .union(.nonBaseCharacters)
    .union(CharacterSet(charactersIn: "\u{2160}"..."\u{2188}"))

  /// Words like the web status bar (`[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*`): apostrophes inside a
  /// word don't split it ("don't" is one word).
  static func countWords(_ text: String) -> Int {
    var count = 0
    var inWord = false
    var pendingApostrophe = false
    for scalar in text.unicodeScalars {
      if wordCharacters.contains(scalar) {
        if !inWord { count += 1 }
        inWord = true
        pendingApostrophe = false
      } else if inWord, !pendingApostrophe, scalar == "'" || scalar == "\u{2019}" {
        pendingApostrophe = true
      } else {
        inWord = false
        pendingApostrophe = false
      }
    }
    return count
  }

  static func pluralize(_ count: Int, _ singular: String, _ plural: String? = nil) -> String {
    "\(count) \(count == 1 ? singular : (plural ?? "\(singular)s"))"
  }
}
