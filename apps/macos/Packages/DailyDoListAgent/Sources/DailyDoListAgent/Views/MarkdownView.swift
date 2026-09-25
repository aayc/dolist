import DailyDoListUI
import SwiftUI

/// Renders agent markdown natively (see `MarkdownRenderer`). Text blocks are `RichTextBlock`s:
/// links preview on hover (pages from the thread's sources, notes through the host) and go
/// through `LinkPolicy`; numbered citations are chips.
///
/// With a `caret`, the text is still typing out: its half-typed end is made tolerant
/// (`MarkdownTail`) and the caret follows the last character.
struct MarkdownView: View {
  let source: String
  var caret: CaretMode?
  @Environment(\.agentNoteLinks) private var noteLinks

  var body: some View {
    let blocks = MarkdownDocument.blocks(for: source, typing: caret != nil)
    let caretBlock = caret == nil ? nil : blocks.last.flatMap { $0.block.hostsCaret ? $0.id : nil }
    VStack(alignment: .leading, spacing: 7) {
      ForEach(blocks) { item in
        MarkdownBlockView(block: item.block, caret: item.id == caretBlock ? caret : nil)
      }
      if let caret, caretBlock == nil {
        SoftCaret(mode: caret)
      }
    }
    .textSelection(.enabled)
    .environment(\.openURL, LinkPolicy.openURLAction(noteLinks: noteLinks))
  }
}

/// A block of a message and its id across the message's chunks (`MarkdownChunks`).
struct DocumentBlock: Identifiable, Hashable {
  struct ID: Hashable {
    var chunk: Int
    var block: Int
  }

  let id: ID
  let block: MarkdownBlock
}

/// Messages as blocks, parsed chunk by chunk: finished chunks come from `MarkdownCache`, so text
/// typing out only re-parses the chunk being typed.
@MainActor
enum MarkdownDocument {
  /// - Parameter typing: the text is still arriving: its last chunk is made tolerant and not
  ///   cached (it changes every frame).
  static func blocks(for source: String, typing: Bool = false) -> [DocumentBlock] {
    let chunks = MarkdownChunks.split(source)
    var result: [DocumentBlock] = []
    for (index, chunk) in chunks.enumerated() {
      let blocks =
        typing && index == chunks.count - 1
        ? MarkdownRenderer.blocks(from: MarkdownTail.tolerant(String(chunk)))
        : MarkdownCache.shared.blocks(for: String(chunk))
      for block in blocks {
        result.append(DocumentBlock(id: .init(chunk: index, block: block.id), block: block))
      }
    }
    return result
  }
}

extension MarkdownBlock {
  /// Text blocks draw the typing caret after their last character.
  var hostsCaret: Bool {
    switch self {
    case .paragraph, .heading, .listItem, .quote: true
    case .code, .table, .rule: false
    }
  }
}

private struct MarkdownBlockView: View {
  let block: MarkdownBlock
  let caret: CaretMode?

  var body: some View {
    switch block {
    case .paragraph(_, let text):
      RichTextBlock(text: text, caret: caret)
    case .heading(_, let level, let text):
      RichTextBlock(text: text, style: .heading(level: level), caret: caret)
        .padding(.top, level <= 2 ? 4 : 2)
    case .listItem(_, let marker, let depth, let text):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(verbatim: marker ?? "")
          .foregroundStyle(AgentTheme.mutedText)
          .monospacedDigit()
          .frame(minWidth: 14, alignment: .trailing)
        RichTextBlock(text: text, caret: caret)
          .alignmentGuide(.firstTextBaseline) { _ in RichTextStyle.body.baseFont.ascender + 1 }
      }
      .padding(.leading, CGFloat(depth - 1) * 16)
    case .quote(_, let text):
      HStack(spacing: 8) {
        RoundedRectangle(cornerRadius: 1.5).fill(AgentTheme.accent.opacity(0.55)).frame(width: 3)
        RichTextBlock(text: text, style: .quote, caret: caret)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .code(_, let language, let code):
      CodeBlockView(language: language, code: code)
    case .table(_, let header, let rows):
      MarkdownTableView(header: header, rows: rows)
    case .rule:
      Divider().padding(.vertical, 4)
    }
  }
}

/// A fenced code block: monospaced, horizontally scrollable, with its language and a copy button
/// that shows under the pointer.
struct CodeBlockView: View {
  let language: String?
  let code: String
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language {
        Text(verbatim: language)
          .font(.caption2.weight(.medium))
          .foregroundStyle(AgentTheme.mutedText)
          .padding(.horizontal, 10)
          .padding(.top, 6)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(verbatim: code)
          .font(.system(size: 12, design: .monospaced))
          .textSelection(.enabled)
          .fixedSize()
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 6).fill(AgentTheme.codeBackground))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AgentTheme.border))
    .overlay(alignment: .topTrailing) {
      CopyButton(text: code, label: "Copy code")
        .background(RoundedRectangle(cornerRadius: 6).fill(AgentTheme.codeBackground))
        .padding(3)
        .opacity(hovering ? 1 : 0)
    }
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.11), value: hovering)
  }
}

private struct MarkdownTableView: View {
  let header: [AttributedString]
  let rows: [[AttributedString]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
        if !header.isEmpty {
          GridRow {
            ForEach(header.indices, id: \.self) { column in
              Text(Self.superscriptingCitations(header[column])).font(.callout.weight(.semibold))
            }
          }
          Divider()
        }
        ForEach(rows.indices, id: \.self) { row in
          GridRow {
            ForEach(rows[row].indices, id: \.self) { column in
              Text(Self.superscriptingCitations(rows[row][column])).font(.callout)
            }
          }
        }
      }
      .padding(8)
    }
    .background(RoundedRectangle(cornerRadius: 6).strokeBorder(AgentTheme.border))
  }

  /// Table cells are SwiftUI `Text`: numbered citations become small raised numbers.
  static func superscriptingCitations(_ text: AttributedString) -> AttributedString {
    var styled = text
    for run in text.runs where run.link != nil {
      guard LinkPreview.isCitationLabel(String(text[run.range].characters)) else { continue }
      styled[run.range].swiftUI.font = .system(size: 9.5, weight: .semibold)
      styled[run.range].swiftUI.baselineOffset = AgentRichText.citationBaselineOffset
    }
    return styled
  }
}

/// Parsed blocks by source text: message chunks (bodies re-render often; parsing is not free).
@MainActor
final class MarkdownCache {
  static let shared = MarkdownCache()
  private let capacity = 600
  private var entries: [String: [MarkdownBlock]] = [:]
  private var order: [String] = []

  func blocks(for source: String) -> [MarkdownBlock] {
    if let hit = entries[source] { return hit }
    let blocks = MarkdownRenderer.blocks(from: source)
    entries[source] = blocks
    order.append(source)
    if order.count > capacity { entries[order.removeFirst()] = nil }
    return blocks
  }
}
