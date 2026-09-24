import SwiftUI

/// Renders agent markdown natively (see `MarkdownRenderer`); links go through `LinkPolicy`.
struct MarkdownView: View {
  let source: String

  var body: some View {
    let blocks = MarkdownCache.shared.blocks(for: source)
    VStack(alignment: .leading, spacing: 7) {
      ForEach(blocks) { block in
        MarkdownBlockView(block: block)
      }
    }
    .textSelection(.enabled)
    .environment(\.openURL, LinkPolicy.openURLAction)
  }
}

private struct MarkdownBlockView: View {
  let block: MarkdownBlock

  var body: some View {
    switch block {
    case .paragraph(_, let text):
      Text(text).fixedSize(horizontal: false, vertical: true)
    case .heading(_, let level, let text):
      Text(text)
        .font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.semibold) : .headline)
        .padding(.top, level <= 2 ? 4 : 2)
        .fixedSize(horizontal: false, vertical: true)
    case .listItem(_, let marker, let depth, let text):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(verbatim: marker ?? "")
          .foregroundStyle(.secondary)
          .monospacedDigit()
          .frame(minWidth: 14, alignment: .trailing)
        Text(text).fixedSize(horizontal: false, vertical: true)
      }
      .padding(.leading, CGFloat(depth - 1) * 16)
    case .quote(_, let text):
      HStack(spacing: 8) {
        RoundedRectangle(cornerRadius: 1.5).fill(AgentTheme.accent.opacity(0.55)).frame(width: 3)
        Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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

/// A fenced code block: monospaced, horizontally scrollable, with its language.
struct CodeBlockView: View {
  let language: String?
  let code: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language {
        Text(verbatim: language)
          .font(.caption2.weight(.medium))
          .foregroundStyle(.secondary)
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
              Text(header[column]).font(.callout.weight(.semibold))
            }
          }
          Divider()
        }
        ForEach(rows.indices, id: \.self) { row in
          GridRow {
            ForEach(rows[row].indices, id: \.self) { column in
              Text(rows[row][column]).font(.callout)
            }
          }
        }
      }
      .padding(8)
    }
    .background(RoundedRectangle(cornerRadius: 6).strokeBorder(AgentTheme.border))
  }
}

/// Parsed blocks by source text (message bodies re-render often; parsing is not free).
@MainActor
final class MarkdownCache {
  static let shared = MarkdownCache()
  private let capacity = 300
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
