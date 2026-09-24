import Foundation

/// One block of rendered markdown. Inline styles (bold, italic, code spans, links) live in the
/// `AttributedString`s, which SwiftUI's `Text` renders natively.
public enum MarkdownBlock: Hashable, Sendable, Identifiable {
  case paragraph(id: Int, text: AttributedString)
  case heading(id: Int, level: Int, text: AttributedString)
  /// `marker` is "•" or "3."; continuation paragraphs of the same item have no marker.
  case listItem(id: Int, marker: String?, depth: Int, text: AttributedString)
  case quote(id: Int, text: AttributedString)
  case code(id: Int, language: String?, code: String)
  case table(id: Int, header: [AttributedString], rows: [[AttributedString]])
  case rule(id: Int)

  public var id: Int {
    switch self {
    case .paragraph(let id, _), .heading(let id, _, _), .listItem(let id, _, _, _),
      .quote(let id, _), .code(let id, _, _), .table(let id, _, _), .rule(let id):
      id
    }
  }
}

/// Markdown → blocks with Foundation's parser (`AttributedString(markdown:)`, full syntax), so
/// headings, lists, quotes, code blocks and tables render as native SwiftUI views.
///
/// Agent text is untrusted: links other than http(s)/mailto are stripped (they render as plain
/// text), raw HTML tags are dropped, and images show their alt text. Single newlines are kept as
/// line breaks (like the web app's `breaks: true`). `[[Note]]` and `[[Note#Heading|label]]`
/// outside code become links to the note (`WikiLinkURL`), shown as their label or name.
public enum MarkdownRenderer {
  public static func blocks(from source: String) -> [MarkdownBlock] {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false, interpretedSyntax: .full,
      failurePolicy: .returnPartiallyParsedIfPossible)
    guard let parsed = try? AttributedString(markdown: source, options: options) else {
      return [.paragraph(id: 0, text: inline(source))]
    }
    var builder = BlockBuilder()
    for (intent, range) in parsed.runs[\.presentationIntent] {
      builder.add(content: AttributedString(parsed[range]), intent: intent)
    }
    return builder.finish()
  }

  /// Inline-only rendering that keeps every newline (streaming text, plain replies).
  public static func inline(_ source: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    guard var text = try? AttributedString(markdown: source, options: options) else {
      return AttributedString(source)
    }
    sanitize(&text)
    linkWikiLinks(&text)
    return text
  }

  /// Turns `[[target#subpath|alias]]` outside code spans and links into a link to the note, shown
  /// as the alias, else the note's name (`Note › Heading` with a subpath).
  static func linkWikiLinks(_ text: inout AttributedString) {
    let characters = Array(text.characters)
    var matches: [(range: Range<Int>, display: String, url: URL)] = []
    var index = 0
    while index + 1 < characters.count {
      guard characters[index] == "[", characters[index + 1] == "[" else {
        index += 1
        continue
      }
      var close = index + 2
      while close + 1 < characters.count, !(characters[close] == "]" && characters[close + 1] == "]"),
        characters[close] != "[", !characters[close].isNewline
      {
        close += 1
      }
      guard close + 1 < characters.count, characters[close] == "]", characters[close + 1] == "]" else {
        index += 1
        continue
      }
      let inner = String(characters[(index + 2)..<close])
      let alias = inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).dropFirst().first
        .map { $0.trimmingCharacters(in: .whitespaces) }
      let target = (inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "")
        .trimmingCharacters(in: .whitespaces)
      let parts = target.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
      let note = parts.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
      if !note.isEmpty, let url = WikiLinkURL.url(for: target) {
        let heading = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        let name = heading.isEmpty ? WikiLinkURL.noteName(note) : "\(WikiLinkURL.noteName(note)) › \(heading)"
        matches.append((index..<(close + 2), alias.flatMap { $0.isEmpty ? nil : $0 } ?? name, url))
      }
      index = close + 2
    }
    guard !matches.isEmpty else { return }
    var result = AttributedString()
    var cursor = text.startIndex
    for match in matches {
      let lower = text.characters.index(text.startIndex, offsetBy: match.range.lowerBound)
      let upper = text.characters.index(text.startIndex, offsetBy: match.range.upperBound)
      let original = text[lower..<upper]
      let isLiteral = original.runs.contains { run in
        run.link != nil || run.inlinePresentationIntent?.contains(.code) == true
      }
      guard !isLiteral, lower >= cursor else { continue }
      result.append(text[cursor..<lower])
      var link = AttributedString(match.display, attributes: original.runs.first?.attributes ?? AttributeContainer())
      link.link = match.url
      result.append(link)
      cursor = upper
    }
    result.append(text[cursor...])
    text = result
  }

  /// Removes unsafe links and raw HTML, turns soft breaks into newlines.
  static func sanitize(_ text: inout AttributedString) {
    var unsafeLinks: [Range<AttributedString.Index>] = []
    var softBreaks: [Range<AttributedString.Index>] = []
    var html: [Range<AttributedString.Index>] = []
    for run in text.runs {
      if let link = run.link, !LinkPolicy.isAllowed(link) { unsafeLinks.append(run.range) }
      if let intent = run.inlinePresentationIntent {
        if intent.contains(.inlineHTML) || intent.contains(.blockHTML) {
          html.append(run.range)
        } else if intent.contains(.softBreak) {
          softBreaks.append(run.range)
        }
      }
    }
    for range in unsafeLinks { text[range].link = nil }
    // Edit from the end so earlier ranges stay valid.
    let edits = (softBreaks.map { ($0, true) } + html.map { ($0, false) })
      .sorted { $0.0.lowerBound > $1.0.lowerBound }
    for (range, isBreak) in edits {
      text.replaceSubrange(range, with: AttributedString(isBreak ? "\n" : ""))
    }
    text.presentationIntent = nil
  }
}

/// Groups parsed runs into blocks (one block per innermost presentation intent).
private struct BlockBuilder {
  private var blocks: [MarkdownBlock] = []
  private var listItemsWithMarker: Set<Int> = []
  private var table: (id: Int, header: [AttributedString], rows: [[AttributedString]], rowId: Int?)?

  mutating func add(content: AttributedString, intent: PresentationIntent?) {
    let components = intent?.components ?? []
    if let tableIndex = components.firstIndex(where: { if case .table = $0.kind { true } else { false } }) {
      addTableCell(content, components: components, tableId: components[tableIndex].identity)
      return
    }
    flushTable()
    var text = content
    MarkdownRenderer.sanitize(&text)
    MarkdownRenderer.linkWikiLinks(&text)
    guard let innermost = components.first else {
      if !text.characters.isEmpty { blocks.append(.paragraph(id: nextAnonymousId, text: text)) }
      return
    }
    let id = innermost.identity
    switch innermost.kind {
    case .codeBlock(let language):
      var code = String(content.characters)
      if code.hasSuffix("\n") { code.removeLast() }
      blocks.append(.code(id: id, language: language?.isEmpty == false ? language : nil, code: code))
    case .header(let level):
      blocks.append(.heading(id: id, level: level, text: text))
    case .thematicBreak:
      blocks.append(.rule(id: id))
    default:
      if let item = components.first(where: { if case .listItem = $0.kind { true } else { false } }) {
        let depth = components.filter(\.isList).count
        let ordered = components.first(where: \.isList).map { if case .orderedList = $0.kind { true } else { false } } ?? false
        var marker: String?
        if listItemsWithMarker.insert(item.identity).inserted {
          if case .listItem(let ordinal) = item.kind { marker = ordered ? "\(ordinal)." : "•" }
        }
        blocks.append(.listItem(id: id, marker: marker, depth: max(depth, 1), text: text))
      } else if components.contains(where: { if case .blockQuote = $0.kind { true } else { false } }) {
        blocks.append(.quote(id: id, text: text))
      } else {
        blocks.append(.paragraph(id: id, text: text))
      }
    }
  }

  private mutating func addTableCell(
    _ content: AttributedString, components: [PresentationIntent.IntentType], tableId: Int
  ) {
    if table?.id != tableId {
      flushTable()
      table = (tableId, [], [], nil)
    }
    var text = content
    MarkdownRenderer.sanitize(&text)
    MarkdownRenderer.linkWikiLinks(&text)
    let isHeader = components.contains { if case .tableHeaderRow = $0.kind { true } else { false } }
    if isHeader {
      table?.header.append(text)
      return
    }
    let rowId = components.first { if case .tableRow = $0.kind { true } else { false } }?.identity
    if table?.rowId != rowId || table?.rows.isEmpty == true {
      table?.rows.append([])
      table?.rowId = rowId
    }
    if let last = table?.rows.indices.last { table?.rows[last].append(text) }
  }

  private mutating func flushTable() {
    guard let table else { return }
    blocks.append(.table(id: table.id, header: table.header, rows: table.rows))
    self.table = nil
  }

  private var nextAnonymousId: Int { -(blocks.count + 1) }

  mutating func finish() -> [MarkdownBlock] {
    flushTable()
    return blocks
  }
}

extension PresentationIntent.IntentType {
  fileprivate var isList: Bool {
    switch kind {
    case .orderedList, .unorderedList: true
    default: false
    }
  }
}
