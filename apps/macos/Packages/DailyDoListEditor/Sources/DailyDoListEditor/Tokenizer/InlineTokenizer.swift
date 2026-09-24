import Foundation

/// Inline markdown of one line: CommonMark emphasis (delimiter runs with flanking rules, the rule
/// of three, intraword `_`), code spans, backslash escapes, inline links, autolinks, GFM bare URLs,
/// `~~strike~~`, plus Obsidian's `==highlight==`, `[[wikilinks]]`/`![[embeds]]` and `#tags`.
///
/// Code spans, autolinks, wikilinks and URLs are atomic: nothing inside them is parsed, so
/// `` `**` ``, `https://x.com/a_b_c` and `[[a*b*]]` stay literal. Every scan is bounded, and the
/// work per line is linear in practice (code-span closers are found through per-length queues).
struct InlineTokenizer {
  private let s: [UInt16]
  private let lower: Int
  private let upper: Int

  private(set) var spans: [StyledSpan] = []
  private(set) var markers: [SyntaxMarker] = []
  private(set) var links: [LinkToken] = []
  private(set) var tags: [TagToken] = []

  private struct Delimiter {
    var marker: UInt16
    var start: Int
    var length: Int
    let originalLength: Int
    let canOpen: Bool
    let canClose: Bool
    var removed = false
  }

  private struct Bracket {
    let start: Int
    let isImage: Bool
    let delimiterBottom: Int
    var active = true
  }

  private var delimiters: [Delimiter] = []
  private var brackets: [Bracket] = []
  /// Backtick runs by length (positions ascending) and a cursor per length; built lazily.
  private var backtickRuns: [Int: [Int]]?
  private var backtickCursor: [Int: Int] = [:]

  /// Tokenizes `units[lower..<upper]`.
  init(_ units: [UInt16], from lower: Int, to upper: Int) {
    s = units
    self.lower = max(0, min(lower, units.count))
    self.upper = max(self.lower, min(upper, units.count))
  }

  @inline(__always) private func at(_ i: Int) -> UInt16 {
    i >= lower && i < upper ? s[i] : 0
  }

  mutating func run() {
    var i = lower
    while i < upper {
      let c = s[i]
      switch c {
      case UTF16Unit.backslash:
        if i + 1 < upper, CharClass.isASCIIPunctuation(s[i + 1]) {
          markers.append(SyntaxMarker(range: NSRange(location: i, length: 1), kind: .escape))
          i += 2
        } else {
          i += 1
        }
      case UTF16Unit.backtick:
        i = scanCodeSpan(at: i)
      case UTF16Unit.lessThan:
        i = scanAutolink(at: i) ?? (i + 1)
      case UTF16Unit.bang:
        if at(i + 1) == UTF16Unit.openBracket {
          if at(i + 2) == UTF16Unit.openBracket, let end = scanWikiLink(at: i, embed: true) {
            i = end
          } else {
            brackets.append(Bracket(start: i, isImage: true, delimiterBottom: delimiters.count))
            i += 2
          }
        } else {
          i += 1
        }
      case UTF16Unit.openBracket:
        if at(i + 1) == UTF16Unit.openBracket, let end = scanWikiLink(at: i, embed: false) {
          i = end
        } else {
          brackets.append(Bracket(start: i, isImage: false, delimiterBottom: delimiters.count))
          i += 1
        }
      case UTF16Unit.closeBracket:
        i = closeBracket(at: i)
      case UTF16Unit.asterisk, UTF16Unit.underscore:
        i = pushDelimiterRun(at: i, marker: c, requiredLength: nil)
      case UTF16Unit.tilde, UTF16Unit.equals:
        i = pushDelimiterRun(at: i, marker: c, requiredLength: 2)
      case UTF16Unit.hash:
        if i == lower || CharClass.isSpaceOrTab(s[i - 1]), let end = scanTag(at: i) {
          i = end
        } else {
          i += 1
        }
      case 0x68, 0x48, 0x77, 0x57:  // h H w W
        if isURLBoundary(i), let end = scanBareURL(at: i) {
          i = end
        } else {
          i += 1
        }
      default:
        i += 1
      }
    }
    processEmphasis(from: 0)
  }

  // MARK: Code spans

  private mutating func scanCodeSpan(at start: Int) -> Int {
    var runEnd = start
    while runEnd < upper, s[runEnd] == UTF16Unit.backtick { runEnd += 1 }
    let length = runEnd - start
    guard let close = nextBacktickRun(length: length, after: runEnd) else { return runEnd }
    let closeEnd = close + length
    markers.append(SyntaxMarker(range: NSRange(start, runEnd), kind: .code))
    markers.append(SyntaxMarker(range: NSRange(close, closeEnd), kind: .code))
    spans.append(StyledSpan(range: NSRange(start, closeEnd), style: .code))
    return closeEnd
  }

  /// Start of the first backtick run of exactly `length` starting at or after `position`.
  private mutating func nextBacktickRun(length: Int, after position: Int) -> Int? {
    if backtickRuns == nil {
      var runs: [Int: [Int]] = [:]
      var i = lower
      while i < upper {
        guard s[i] == UTF16Unit.backtick else {
          i += 1
          continue
        }
        var j = i
        while j < upper, s[j] == UTF16Unit.backtick { j += 1 }
        runs[j - i, default: []].append(i)
        i = j
      }
      backtickRuns = runs
    }
    guard let runs = backtickRuns?[length] else { return nil }
    var cursor = backtickCursor[length] ?? 0
    while cursor < runs.count, runs[cursor] < position { cursor += 1 }
    backtickCursor[length] = cursor
    return cursor < runs.count ? runs[cursor] : nil
  }

  // MARK: Emphasis, strikethrough, highlight

  private mutating func pushDelimiterRun(at start: Int, marker: UInt16, requiredLength: Int?) -> Int
  {
    var end = start
    while end < upper, s[end] == marker { end += 1 }
    let length = end - start
    if let requiredLength, length != requiredLength { return end }
    let before = CharClass.scalar(before: start, in: s, lowerBound: lower)
    let after = CharClass.scalar(at: end, in: s, upperBound: upper)
    let spaceBefore = CharClass.isWhitespace(before)
    let spaceAfter = CharClass.isWhitespace(after)
    let punctBefore = CharClass.isPunctuation(before)
    let punctAfter = CharClass.isPunctuation(after)
    let leftFlanking = !spaceAfter && (!punctAfter || spaceBefore || punctBefore)
    let rightFlanking = !spaceBefore && (!punctBefore || spaceAfter || punctAfter)
    let canOpen: Bool
    let canClose: Bool
    if marker == UTF16Unit.underscore {
      canOpen = leftFlanking && (!rightFlanking || punctBefore)
      canClose = rightFlanking && (!leftFlanking || punctAfter)
    } else {
      canOpen = leftFlanking
      canClose = rightFlanking
    }
    if canOpen || canClose {
      delimiters.append(
        Delimiter(
          marker: marker, start: start, length: length, originalLength: length, canOpen: canOpen,
          canClose: canClose))
    }
    return end
  }

  private static func markerIndex(_ marker: UInt16) -> Int {
    switch marker {
    case UTF16Unit.asterisk: 0
    case UTF16Unit.underscore: 1
    case UTF16Unit.tilde: 2
    default: 3
    }
  }

  /// CommonMark's "process emphasis" over the delimiters from index `bottom` on, including the
  /// `openers_bottom` optimization; removes those delimiters afterwards.
  private mutating func processEmphasis(from bottom: Int) {
    guard bottom < delimiters.count else { return }
    var openersBottom = [Int](repeating: bottom - 1, count: 4 * 2 * 3)
    var closerIndex = bottom
    while closerIndex < delimiters.count {
      var closer = delimiters[closerIndex]
      guard !closer.removed, closer.canClose, closer.length > 0 else {
        closerIndex += 1
        continue
      }
      let isEmphasis = closer.marker == UTF16Unit.asterisk || closer.marker == UTF16Unit.underscore
      let key =
        Self.markerIndex(closer.marker) * 6 + (closer.canOpen ? 3 : 0) + closer.originalLength % 3
      var found = -1
      var openerIndex = closerIndex - 1
      while openerIndex > openersBottom[key], openerIndex >= bottom {
        let opener = delimiters[openerIndex]
        if !opener.removed, opener.marker == closer.marker, opener.canOpen, opener.length > 0 {
          let oddMatch =
            isEmphasis && (opener.canClose || closer.canOpen)
            && (opener.originalLength + closer.originalLength) % 3 == 0
            && !(opener.originalLength % 3 == 0 && closer.originalLength % 3 == 0)
          if !oddMatch {
            found = openerIndex
            break
          }
        }
        openerIndex -= 1
      }
      guard found >= 0 else {
        openersBottom[key] = closerIndex - 1
        if !closer.canOpen { delimiters[closerIndex].removed = true }
        closerIndex += 1
        continue
      }
      var opener = delimiters[found]
      let use = isEmphasis ? (opener.length >= 2 && closer.length >= 2 ? 2 : 1) : 2
      let openStart = opener.start + opener.length - use
      let closeStart = closer.start
      let kind: MarkerKind
      let style: InlineStyle
      switch closer.marker {
      case UTF16Unit.tilde:
        kind = .strikethrough
        style = .strikethrough
      case UTF16Unit.equals:
        kind = .highlight
        style = .highlight
      default:
        kind = .emphasis
        style = use == 2 ? .bold : .italic
      }
      markers.append(SyntaxMarker(range: NSRange(location: openStart, length: use), kind: kind))
      markers.append(SyntaxMarker(range: NSRange(location: closeStart, length: use), kind: kind))
      spans.append(StyledSpan(range: NSRange(openStart, closeStart + use), style: style))
      opener.length -= use
      if opener.length == 0 { opener.removed = true }
      delimiters[found] = opener
      closer.length -= use
      closer.start += use
      for k in (found + 1)..<closerIndex { delimiters[k].removed = true }
      if closer.length == 0 {
        closer.removed = true
        delimiters[closerIndex] = closer
        closerIndex += 1
      } else {
        delimiters[closerIndex] = closer
      }
    }
    delimiters.removeSubrange(bottom...)
  }

  // MARK: Links

  private mutating func closeBracket(at close: Int) -> Int {
    guard let bracket = brackets.popLast() else { return close + 1 }
    guard bracket.active, at(close + 1) == UTF16Unit.openParen,
      let tail = scanLinkTail(from: close + 1)
    else { return close + 1 }
    if bracket.isImage {
      // Images stay as source: nothing inside is styled.
      if bracket.delimiterBottom < delimiters.count {
        delimiters.removeSubrange(bracket.delimiterBottom...)
      }
      return tail.end
    }
    let textStart = bracket.start + 1
    guard close > textStart else { return close + 1 }
    let linkRange = NSRange(bracket.start, tail.end)
    // A bare URL inside the link text belongs to the link.
    if let first = links.firstIndex(where: { $0.range.location >= bracket.start }) {
      links.removeSubrange(first...)
      spans.removeAll { $0.style == .link && $0.range.location >= bracket.start }
    }
    processEmphasis(from: bracket.delimiterBottom)
    markers.append(SyntaxMarker(range: NSRange(location: bracket.start, length: 1), kind: .link))
    markers.append(SyntaxMarker(range: NSRange(close, tail.end), kind: .link))
    spans.append(StyledSpan(range: NSRange(textStart, close), style: .link))
    links.append(LinkToken(range: linkRange, target: .url(tail.destination)))
    for k in brackets.indices where !brackets[k].isImage { brackets[k].active = false }
    return tail.end
  }

  /// `(destination "title")` starting at the `(`. The destination must be non-empty.
  private func scanLinkTail(from open: Int) -> (destination: String, end: Int)? {
    var p = open + 1
    while p < upper, CharClass.isSpaceOrTab(s[p]) { p += 1 }
    let destStart: Int
    let destEnd: Int
    if at(p) == UTF16Unit.lessThan {
      var q = p + 1
      while q < upper, s[q] != UTF16Unit.greaterThan, s[q] != UTF16Unit.lessThan {
        q += s[q] == UTF16Unit.backslash && q + 1 < upper ? 2 : 1
      }
      guard q < upper, s[q] == UTF16Unit.greaterThan else { return nil }
      destStart = p + 1
      destEnd = q
      p = q + 1
    } else {
      destStart = p
      var depth = 0
      while p < upper {
        let c = s[p]
        if c == UTF16Unit.backslash, p + 1 < upper, CharClass.isASCIIPunctuation(s[p + 1]) {
          p += 2
          continue
        }
        if CharClass.isSpaceOrTab(c) || c < 0x20 { break }
        if c == UTF16Unit.openParen {
          depth += 1
          if depth > 32 { return nil }
        } else if c == UTF16Unit.closeParen {
          if depth == 0 { break }
          depth -= 1
        }
        p += 1
      }
      guard depth == 0 else { return nil }
      destEnd = p
    }
    guard destEnd > destStart else { return nil }
    let afterDestination = p
    while p < upper, CharClass.isSpaceOrTab(s[p]) { p += 1 }
    let opener = at(p)
    if p > afterDestination,
      opener == UTF16Unit.doubleQuote || opener == UTF16Unit.singleQuote
        || opener == UTF16Unit.openParen
    {
      let closer = opener == UTF16Unit.openParen ? UTF16Unit.closeParen : opener
      var r = p + 1
      while r < upper, s[r] != closer {
        r += s[r] == UTF16Unit.backslash && r + 1 < upper ? 2 : 1
      }
      guard r < upper else { return nil }
      p = r + 1
      while p < upper, CharClass.isSpaceOrTab(s[p]) { p += 1 }
    }
    guard at(p) == UTF16Unit.closeParen else { return nil }
    return (unescaped(destStart, destEnd), p + 1)
  }

  /// Text in `[start, end)` with backslash escapes resolved.
  private func unescaped(_ start: Int, _ end: Int) -> String {
    var units: [UInt16] = []
    units.reserveCapacity(end - start)
    var i = start
    while i < end {
      if s[i] == UTF16Unit.backslash, i + 1 < end, CharClass.isASCIIPunctuation(s[i + 1]) {
        units.append(s[i + 1])
        i += 2
      } else {
        units.append(s[i])
        i += 1
      }
    }
    return String(utf16Units: units[...])
  }

  /// `<scheme:…>` and `<user@host>`.
  private mutating func scanAutolink(at start: Int) -> Int? {
    let contentStart = start + 1
    var end = -1
    if CharClass.isASCIILetter(at(contentStart)) {
      var q = contentStart + 1
      while q < upper,
        CharClass.isASCIIAlphanumeric(s[q]) || s[q] == UTF16Unit.plus || s[q] == UTF16Unit.dot
          || s[q] == UTF16Unit.dash
      {
        q += 1
      }
      let schemeLength = q - contentStart
      if schemeLength >= 2, schemeLength <= 32, at(q) == UTF16Unit.colon {
        var r = q + 1
        while r < upper, s[r] != UTF16Unit.greaterThan, s[r] != UTF16Unit.lessThan, s[r] > 0x20 {
          r += 1
        }
        if r < upper, s[r] == UTF16Unit.greaterThan { end = r }
      }
    }
    if end < 0 {
      var q = contentStart
      var ats = 0
      while q < upper, s[q] != UTF16Unit.greaterThan, s[q] > 0x20, s[q] != UTF16Unit.lessThan {
        if s[q] == UTF16Unit.at { ats += 1 }
        q += 1
      }
      if q < upper, s[q] == UTF16Unit.greaterThan, ats == 1, at(contentStart) != UTF16Unit.at,
        at(q - 1) != UTF16Unit.at
      {
        end = q
      }
    }
    guard end > contentStart else { return nil }
    markers.append(SyntaxMarker(range: NSRange(location: start, length: 1), kind: .autolink))
    markers.append(SyntaxMarker(range: NSRange(location: end, length: 1), kind: .autolink))
    spans.append(StyledSpan(range: NSRange(contentStart, end), style: .link))
    links.append(
      LinkToken(
        range: NSRange(start, end + 1), target: .url(String(utf16Units: s[contentStart..<end]))))
    return end + 1
  }

  /// `[[target#subpath|alias]]` / `![[embed]]`: no `[` or line break inside, non-empty target.
  private mutating func scanWikiLink(at start: Int, embed: Bool) -> Int? {
    let open = embed ? start + 1 : start
    guard at(open) == UTF16Unit.openBracket, at(open + 1) == UTF16Unit.openBracket else {
      return nil
    }
    let contentStart = open + 2
    var pipe = -1
    var close = contentStart
    while close < upper {
      let c = s[close]
      if c == UTF16Unit.openBracket { return nil }
      if c == UTF16Unit.closeBracket { break }
      if c == UTF16Unit.pipe, pipe < 0 { pipe = close }
      close += 1
    }
    guard close + 1 < upper, s[close] == UTF16Unit.closeBracket,
      s[close + 1] == UTF16Unit.closeBracket
    else { return nil }
    let targetEnd = pipe < 0 ? close : pipe
    guard targetEnd > contentStart else { return nil }
    let end = close + 2
    let display: NSRange
    if pipe >= 0, close > pipe + 1 {
      display = NSRange(pipe + 1, close)
      markers.append(SyntaxMarker(range: NSRange(start, pipe + 1), kind: .wikilink))
      markers.append(SyntaxMarker(range: NSRange(close, end), kind: .wikilink))
    } else {
      display = NSRange(contentStart, targetEnd)
      markers.append(SyntaxMarker(range: NSRange(start, contentStart), kind: .wikilink))
      markers.append(SyntaxMarker(range: NSRange(targetEnd, end), kind: .wikilink))
    }
    spans.append(StyledSpan(range: display, style: .wikilink))
    let parts = WikiLinkParts(String(utf16Units: s[contentStart..<close]))
    links.append(
      LinkToken(
        range: NSRange(start, end),
        target: .wiki(
          target: parts.target, subpath: parts.subpath, alias: parts.alias, isEmbed: embed)))
    return end
  }

  // MARK: Tags

  /// Obsidian tags: letters, digits, `_`, `-`, `/` (and non-ASCII letters, marks and numbers),
  /// with at least one character that isn't an ASCII digit (`#123` is not a tag).
  private mutating func scanTag(at start: Int) -> Int? {
    var end = start + 1
    var hasNonDigit = false
    while end < upper {
      let c = s[end]
      if c < 0x80 {
        guard
          CharClass.isASCIIAlphanumeric(c) || c == UTF16Unit.underscore || c == UTF16Unit.dash
            || c == UTF16Unit.slash
        else { break }
        if !CharClass.isASCIIDigit(c) { hasNonDigit = true }
        end += 1
        continue
      }
      guard let scalar = CharClass.scalar(at: end, in: s, upperBound: upper),
        CharClass.isLetterMarkOrNumber(scalar)
      else { break }
      hasNonDigit = true
      end += scalar.utf16.count
    }
    guard hasNonDigit else { return nil }
    spans.append(StyledSpan(range: NSRange(start, end), style: .tag))
    tags.append(
      TagToken(range: NSRange(start, end), name: String(utf16Units: s[(start + 1)..<end])))
    return end
  }

  // MARK: Bare URLs

  private func isURLBoundary(_ i: Int) -> Bool {
    guard i > lower else { return true }
    let c = s[i - 1]
    return CharClass.isSpaceOrTab(c) || c == UTF16Unit.asterisk || c == UTF16Unit.underscore
      || c == UTF16Unit.tilde || c == UTF16Unit.openParen
  }

  private func matchesCaseInsensitive(_ i: Int, _ ascii: StaticString) -> Bool {
    ascii.withUTF8Buffer { bytes in
      guard i + bytes.count <= upper else { return false }
      for k in 0..<bytes.count {
        var c = s[i + k]
        if c >= UTF16Unit.upperA, c <= UTF16Unit.upperZ { c += 0x20 }
        if c != UInt16(bytes[k]) { return false }
      }
      return true
    }
  }

  /// GFM extended autolinks (`http://`, `https://`, `www.`) with its trailing-punctuation rules.
  private mutating func scanBareURL(at start: Int) -> Int? {
    let bodyStart: Int
    if matchesCaseInsensitive(start, "https://") {
      bodyStart = start + 8
    } else if matchesCaseInsensitive(start, "http://") {
      bodyStart = start + 7
    } else if matchesCaseInsensitive(start, "www.") {
      bodyStart = start + 4
    } else {
      return nil
    }
    var end = bodyStart
    var opens = 0
    var closes = 0
    // Inside potential link text a `]` ends the URL, so the link can still close (links win).
    let insideBrackets = brackets.contains { $0.active && !$0.isImage }
    while end < upper, !CharClass.isSpaceOrTab(s[end]), s[end] != UTF16Unit.lessThan,
      s[end] >= 0x20,
      !(insideBrackets && s[end] == UTF16Unit.closeBracket)
    {
      if s[end] == UTF16Unit.openParen { opens += 1 }
      if s[end] == UTF16Unit.closeParen { closes += 1 }
      end += 1
    }
    while end > bodyStart {
      let c = s[end - 1]
      switch c {
      case UTF16Unit.question, UTF16Unit.bang, UTF16Unit.dot, UTF16Unit.comma, UTF16Unit.colon,
        UTF16Unit.asterisk, UTF16Unit.underscore, UTF16Unit.tilde, UTF16Unit.singleQuote,
        UTF16Unit.doubleQuote:
        end -= 1
        continue
      case UTF16Unit.closeParen where closes > opens:
        closes -= 1
        end -= 1
        continue
      case UTF16Unit.semicolon:
        var k = end - 2
        while k >= bodyStart, CharClass.isASCIIAlphanumeric(s[k]) { k -= 1 }
        if k >= bodyStart, k < end - 2, s[k] == UTF16Unit.ampersand {
          end = k
          continue
        }
      default:
        break
      }
      break
    }
    guard end > bodyStart else { return nil }
    spans.append(StyledSpan(range: NSRange(start, end), style: .link))
    links.append(
      LinkToken(range: NSRange(start, end), target: .url(String(utf16Units: s[start..<end]))))
    return end
  }
}
