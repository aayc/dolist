/// A `[[wikilink]]` or `![[embed]]` in a text.
public struct WikiLink: Hashable, Sendable, Codable {
  /// Link target without heading/block suffix, e.g. `Daily/2026-06-19` (trimmed, never empty).
  public var target: String
  /// `#heading` or `#^block` suffix without the `#`, trimmed (may be empty: `[[a# ]]`).
  public var subpath: String?
  public var alias: String?
  public var embed: Bool
  /// UTF-16 offset of the link's first character (`!` or `[`) in the text.
  public var from: Int
  /// UTF-16 offset just past the closing `]]`.
  public var to: Int

  public init(
    target: String, subpath: String? = nil, alias: String? = nil, embed: Bool, from: Int, to: Int
  ) {
    self.target = target
    self.subpath = subpath
    self.alias = alias
    self.embed = embed
    self.from = from
    self.to = to
  }
}

/// Port of @ddl/core `markdown/wikilinks.ts`.
public enum WikiLinks {
  /// `parseWikiLinks`: links to notes in `text`, in order. Same-note links (`[[#Heading]]`) and
  /// blank targets are skipped.
  public static func parse(_ text: String) -> [WikiLink] {
    let buffer = UTF16Buffer(text)
    return buffer.withPointer { p, n in
      var links: [WikiLink] = []
      scan(p, 0..<n) { match in
        links.append(
          WikiLink(
            target: String(utf16: p, match.target),
            subpath: match.subpath.map { String(utf16: p, $0) },
            alias: match.alias.map { String(utf16: p, $0) },
            embed: match.embed, from: match.from, to: match.to))
      }
      return links
    }
  }

  /// `resolveWikiLink`: the vault path a target names, like Obsidian, ignoring case and Unicode
  /// normalization: the exact path first, then the shortest path that ends with it (the first
  /// one on ties). `[[Plan]]` names `Plan.md`; `[[image.png]]` may also name that file itself.
  public static func resolve(_ target: String, in paths: [String]) -> String? {
    var cleaned = Array(target.utf8).map { $0 == 0x5C ? 0x2F : $0 }
    if cleaned.first == 0x2F { cleaned.removeFirst() }
    let wanted = fold(String(decoding: cleaned, as: UTF8.self))
    guard !wanted.isEmpty else { return nil }
    let names: [String]
    if VaultPath.isMarkdown(wanted) {
      names = [wanted]
    } else if !VaultPath.extname(wanted).isEmpty {
      names = ["\(wanted).md", wanted]
    } else {
      names = ["\(wanted).md"]
    }
    let suffixes = names.map { "/\($0)" }
    var best: String?
    var bestLength = 0
    for path in paths {
      let folded = fold(path)
      if names.contains(where: { $0.jsEquals(folded) }) { return path }
      guard suffixes.contains(where: { folded.jsHasSuffix($0) }) else { continue }
      let length = path.jsLength
      if best == nil || length < bestLength {
        best = path
        bestLength = length
      }
    }
    return best
  }

  private static func fold(_ path: String) -> String {
    JSCase.lowercased(path.nfc)
  }

  struct Match {
    var target: Range<Int>
    var subpath: Range<Int>?
    var alias: Range<Int>?
    var embed: Bool
    /// Offsets relative to the start of the scanned range.
    var from: Int
    var to: Int
  }

  /// Every match of `/(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?]]/g` in `range`,
  /// with trimmed parts; matches whose target trims to nothing are consumed but not reported.
  static func scan(_ p: UnsafePointer<UInt16>, _ range: Range<Int>, _ found: (Match) -> Void) {
    let end = range.upperBound
    var pos = range.lowerBound
    while pos < end {
      guard p[pos] == 0x21 || p[pos] == 0x5B, let match = match(p, pos, end) else {
        pos += 1
        continue
      }
      let target = jsTrim(p, match.target)
      if !target.isEmpty {
        found(
          Match(
            target: target, subpath: match.subpath.map { jsTrim(p, $0) },
            alias: match.alias.map { jsTrim(p, $0) }, embed: match.embed,
            from: match.from - range.lowerBound, to: match.to - range.lowerBound))
      }
      pos = match.to
    }
  }

  /// The match starting at `start`. The regex never needs to backtrack here: each part stops at
  /// the first character it can't contain, and giving any back can't make `]]` match.
  private static func match(_ p: UnsafePointer<UInt16>, _ start: Int, _ end: Int) -> Match? {
    var i = start
    let embed = p[i] == 0x21
    if embed { i += 1 }
    guard i + 1 < end, p[i] == 0x5B, p[i + 1] == 0x5B else { return nil }
    i += 2
    // Target `[^\]|#\n]+`, subpath `#[^\]|\n]+`, alias `\|[^\]\n]+`.
    let targetStart = i
    while i < end, p[i] != 0x5D, p[i] != 0x7C, p[i] != 0x23, p[i] != 0x0A { i += 1 }
    guard i > targetStart else { return nil }
    let target = targetStart..<i
    var subpath: Range<Int>?
    if i < end, p[i] == 0x23 {
      let from = i + 1
      var j = from
      while j < end, p[j] != 0x5D, p[j] != 0x7C, p[j] != 0x0A { j += 1 }
      guard j > from else { return nil }
      subpath = from..<j
      i = j
    }
    var alias: Range<Int>?
    if i < end, p[i] == 0x7C {
      let from = i + 1
      var j = from
      while j < end, p[j] != 0x5D, p[j] != 0x0A { j += 1 }
      guard j > from else { return nil }
      alias = from..<j
      i = j
    }
    guard i + 1 < end, p[i] == 0x5D, p[i + 1] == 0x5D else { return nil }
    return Match(
      target: target, subpath: subpath, alias: alias, embed: embed, from: start, to: i + 2)
  }
}
