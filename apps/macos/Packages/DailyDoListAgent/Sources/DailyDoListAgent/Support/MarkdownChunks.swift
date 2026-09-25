import Foundation

/// Markdown cut at blank lines into chunks that parse the same apart as together, so a message
/// typing out re-parses only its last chunk while the others come from `MarkdownCache`.
///
/// A cut goes before a line that starts at the margin after one or more blank lines, outside
/// fenced code, unless that line starts a list item (items of one list stay together: an ordered
/// list numbers from its first item). Sources with link reference definitions or HTML blocks, which
/// reach across blank lines, stay whole.
enum MarkdownChunks {
  static func split(_ source: String) -> [Substring] {
    guard !source.isEmpty else { return [] }
    var lines: [Substring] = []
    var start = source.startIndex
    while let newline = source[start...].firstIndex(of: "\n") {
      lines.append(source[start...newline])
      start = source.index(after: newline)
    }
    if start < source.endIndex { lines.append(source[start...]) }
    if lines.contains(where: reachesAcrossBlankLines) { return [source[...]] }

    var chunks: [Substring] = []
    var chunkStart = source.startIndex
    var fence: Fence?
    var afterBlank = false
    var hasContent = false
    for line in lines {
      if let open = fence {
        if open.isClosed(by: line) { fence = nil }
        continue
      }
      if isBlank(line) {
        afterBlank = hasContent
        continue
      }
      if afterBlank, startsAtMargin(line), !startsListItem(line), line.startIndex > chunkStart {
        chunks.append(source[chunkStart..<line.startIndex])
        chunkStart = line.startIndex
      }
      afterBlank = false
      hasContent = true
      fence = Fence(opening: line)
    }
    chunks.append(source[chunkStart...])
    return chunks
  }

  /// An open code fence (```` ``` ```` or `~~~`, three or more).
  struct Fence {
    let marker: Character
    let length: Int

    /// The fence `line` opens, if it opens one.
    init?(opening line: Substring) {
      let body = line.drop { $0 == " " }
      guard line.count - body.count <= 3, let first = body.first, first == "`" || first == "~"
      else { return nil }
      let run = body.prefix { $0 == first }.count
      guard run >= 3 else { return nil }
      // A backtick fence's info string can't contain backticks.
      if first == "`", body.dropFirst(run).contains("`") { return nil }
      marker = first
      length = run
    }

    func isClosed(by line: Substring) -> Bool {
      let body = line.drop { $0 == " " }
      guard line.count - body.count <= 3 else { return false }
      let run = body.prefix { $0 == marker }.count
      return run >= length && body.dropFirst(run).allSatisfy(\.isWhitespace)
    }
  }

  static func isBlank(_ line: Substring) -> Bool {
    line.allSatisfy(\.isWhitespace)
  }

  static func startsAtMargin(_ line: Substring) -> Bool {
    guard let first = line.first else { return false }
    return !first.isWhitespace
  }

  /// `- `, `* `, `+ `, `1. `, `1) ` (or the marker alone at the end of the text).
  static func startsListItem(_ line: Substring) -> Bool {
    let body = line.drop { $0 == " " }
    guard let first = body.first else { return false }
    let afterMarker: Substring
    if "-*+".contains(first) {
      afterMarker = body.dropFirst()
    } else if first.isASCII, first.isNumber {
      let digits = body.prefix { $0.isASCII && $0.isNumber }
      guard digits.count <= 9 else { return false }
      let rest = body.dropFirst(digits.count)
      guard let delimiter = rest.first, delimiter == "." || delimiter == ")" else { return false }
      afterMarker = rest.dropFirst()
    } else {
      return false
    }
    guard let next = afterMarker.first else { return true }
    return next == " " || next == "\t" || next == "\n"
  }

  /// `[label]: url` or an HTML block (`<div>`, `<!-- … -->`).
  static func reachesAcrossBlankLines(_ line: Substring) -> Bool {
    let body = line.drop { $0 == " " }
    guard line.count - body.count <= 3, let first = body.first else { return false }
    if first == "<" {
      guard let next = body.dropFirst().first else { return false }
      return next.isLetter || next == "!" || next == "/" || next == "?"
    }
    guard first == "[", let close = body.firstIndex(of: "]") else { return false }
    return body[body.index(after: close)...].first == ":"
  }
}

/// Half-typed markdown at the end of text that's still typing out, made harmless: nothing flashes
/// as raw markup for longer than it takes to finish typing it, and nothing is guessed that could
/// render wrong once the rest arrives.
///
/// - A last line that is only markup so far (`-`, `##`, `>`, `1.`, `|---`) is left out: it would
///   otherwise turn the paragraph above into a heading or show as a stray symbol.
/// - A trailing run of `*`, `_`, `~` or `` ` `` is left out until what follows it arrives.
/// - A half-typed link shows as its label (a citation, `[1](…`, shows nothing yet).
/// - Unclosed `**`, `~~` and code spans on the last line are closed, so bold and code render as
///   they type.
/// - Inside an unclosed code fence the text is code: only a half-typed closing fence is left out.
enum MarkdownTail {
  static func tolerant(_ text: String) -> String {
    var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard var last = lines.popLast() else { return text }
    var fence: MarkdownChunks.Fence?
    for line in lines {
      if let open = fence {
        if open.isClosed(by: line[...]) { fence = nil }
      } else {
        fence = MarkdownChunks.Fence(opening: line[...])
      }
    }
    if fence != nil {
      if !last.isEmpty, last.trimmingCharacters(in: .whitespaces).allSatisfy({ "`~".contains($0) })
      {
        last = ""
      }
    } else if isMarkupOnly(last) {
      last = ""
    } else {
      last = closingInline(dropHalfLink(dropTrailingDelimiters(last)))
    }
    return (lines + [last]).joined(separator: "\n")
  }

  /// A line with nothing but markup so far: list and quote markers, heading hashes, rules, setext
  /// underlines, table delimiters, fences, a number that may become `1.`.
  static func isMarkupOnly(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return false }
    if trimmed.allSatisfy({ "-=*_+#>|:~`".contains($0) || $0 == " " }) { return true }
    let digits = trimmed.prefix { $0.isASCII && $0.isNumber }
    let rest = trimmed.dropFirst(digits.count)
    return !digits.isEmpty && (rest.isEmpty || rest == "." || rest == ")")
  }

  static func dropTrailingDelimiters(_ text: String) -> String {
    var result = Substring(text)
    while let last = result.last, "*_~`".contains(last) {
      result = result.dropLast()
    }
    return String(result)
  }

  /// `[label](partial` or `[label` at the end → `label` (nothing for a citation or an image).
  static func dropHalfLink(_ text: String) -> String {
    guard let open = text.lastIndex(of: "[") else { return text }
    let tail = text[text.index(after: open)...]
    if tail.contains("\n") { return text }
    let label: Substring
    if let close = tail.firstIndex(of: "]") {
      let after = tail[tail.index(after: close)...]
      // A complete link, or brackets that aren't a link.
      guard after.first == "(", !after.contains(")") else { return text }
      label = tail[..<close]
    } else {
      label = tail
    }
    var prefix = text[..<open]
    let isImage = prefix.last == "!"
    if isImage { prefix = prefix.dropLast() }
    let hidden = isImage || LinkPreview.isCitationLabel(String(label))
    return String(prefix) + (hidden ? "" : String(label))
  }

  /// Closes `**`, `~~` and code spans left open in `line` (innermost first), before any trailing
  /// whitespace so the closers still count as closing.
  static func closingInline(_ line: String) -> String {
    let chars = Array(line)
    var code: (position: Int, run: Int)?
    var strong: Int?
    var strike: Int?
    var index = 0
    while index < chars.count {
      let char = chars[index]
      if char == "\\", code == nil {
        index += 2
        continue
      }
      if char == "`" {
        var run = 1
        while index + run < chars.count, chars[index + run] == "`" { run += 1 }
        if let open = code {
          if open.run == run { code = nil }
        } else {
          code = (index, run)
        }
        index += run
        continue
      }
      if code == nil, index + 1 < chars.count, chars[index] == chars[index + 1],
        char == "*" || char == "~"
      {
        if char == "*" {
          strong = strong == nil ? opener(at: index, in: chars) : nil
        } else {
          strike = strike == nil ? opener(at: index, in: chars) : nil
        }
        index += 2
        continue
      }
      index += 1
    }
    var closers: [(position: Int, text: String)] = []
    if let code { closers.append((code.position, String(repeating: "`", count: code.run))) }
    if let strong, strong >= 0 { closers.append((strong, "**")) }
    if let strike, strike >= 0 { closers.append((strike, "~~")) }
    guard !closers.isEmpty else { return line }
    var bodyEnd = chars.count
    while bodyEnd > 0, chars[bodyEnd - 1].isWhitespace { bodyEnd -= 1 }
    let closing = closers.sorted { $0.position > $1.position }.map(\.text).joined()
    return String(chars[..<bodyEnd]) + closing + String(chars[bodyEnd...])
  }

  /// An opening `**`/`~~` at `index` is one followed by a non-blank; -1 marks a literal pair that
  /// still pairs with the next one.
  private static func opener(at index: Int, in chars: [Character]) -> Int {
    let next = index + 2
    guard next < chars.count, !chars[next].isWhitespace else { return -1 }
    return index
  }
}
