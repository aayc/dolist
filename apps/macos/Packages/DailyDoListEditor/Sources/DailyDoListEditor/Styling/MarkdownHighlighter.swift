import AppKit
import DailyDoListEditorCore

/// AppKit styling adapter for the shared incremental markdown parser.
@MainActor
final class MarkdownHighlighter {
  private let storage: NSTextStorage
  private let parser = MarkdownParseCache()
  private(set) var theme: EditorTheme
  private(set) var livePreview = true
  var lineIndex: LineIndex { parser.lineIndex }
  var lines: [LineState] { parser.lines }
  var frontmatterEnd: Int? { parser.frontmatterEnd }
  var lastRestyledLineCount: Int { parser.lastRestyledLineCount }
  var lastRestyledRange: NSRange { parser.lastRestyledRange }
  var embedLines: [Int] { parser.embedLines }
  var embedLinesChanged: Bool { parser.embedLinesChanged }

  init(storage: NSTextStorage, theme: EditorTheme) {
    self.storage = storage
    self.theme = theme
  }

  func restyleAll(theme newTheme: EditorTheme? = nil, livePreview newLivePreview: Bool? = nil) {
    if let newTheme { theme = newTheme }
    if let newLivePreview { livePreview = newLivePreview }
    storage.beginEditing()
    parser.rebuild(storage.mutableString, consume: apply)
    storage.endEditing()
  }

  @discardableResult
  func textDidChange(in editedRange: NSRange, changeInLength delta: Int) -> LineIndex.Change {
    parser.textDidChange(
      in: editedRange, changeInLength: delta, text: storage.mutableString, consume: apply)
  }

  func kind(ofLine line: Int) -> LineKind { parser.kind(ofLine: line) }
  func isLiteralLine(_ line: Int) -> Bool { parser.isLiteralLine(line) }
  func isEmbedLine(_ line: Int) -> Bool { parser.isEmbedLine(line) }

  private func apply(_ tokens: LineTokens, units: [UInt16], content: NSRange, hasNewline: Bool) {
    let block = BlockStyle(tokens.kind)
    let depth = tokens.quoteDepth
    let hanging =
      tokens.listPrefix == nil
      ? 0 : theme.hangingIndent(for: tokens, units: units, livePreview: livePreview)
    var position = content.location
    for segment in StyleSegments.build(tokens, length: content.length) {
      let key = StyleKey(
        block: block, quoteDepth: depth, inline: segment.style, marker: segment.marker,
        hangingIndent: hanging)
      storage.setAttributes(
        theme.attributes(for: key), range: NSRange(location: position, length: segment.length))
      position += segment.length
    }
    if hasNewline {
      storage.setAttributes(
        theme.attributes(for: StyleKey(block: block, quoteDepth: depth, hangingIndent: hanging)),
        range: NSRange(location: position, length: 1))
    }
    for link in tokens.links {
      storage.addAttribute(
        .ddlLink, value: LinkAttribute(link.target), range: link.range.shifted(by: content.location)
      )
    }
  }

}
