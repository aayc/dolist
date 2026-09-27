import Foundation

/// A block of a message and its id across the message's chunks (`MarkdownChunks`).
package struct DocumentBlock: Identifiable, Hashable {
  package struct ID: Hashable {
    package var chunk: Int
    package var block: Int
  }

  package let id: ID
  package let block: MarkdownBlock
}

/// Messages as blocks, parsed chunk by chunk: finished chunks come from `MarkdownCache`, so text
/// typing out only re-parses the chunk being typed.
@MainActor
package enum MarkdownDocument {
  /// - Parameter typing: the text is still arriving: its last chunk is made tolerant and not
  ///   cached (it changes every frame).
  package static func blocks(for source: String, typing: Bool = false) -> [DocumentBlock] {
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
  package var hostsCaret: Bool {
    switch self {
    case .paragraph, .heading, .listItem, .quote: true
    case .code, .table, .rule: false
    }
  }
}

/// Parsed blocks by source text: message chunks (bodies re-render often; parsing is not free).
@MainActor
package final class MarkdownCache {
  package static let shared = MarkdownCache()
  private let capacity = 600
  private var entries: [String: [MarkdownBlock]] = [:]
  private var order: [String] = []

  package func blocks(for source: String) -> [MarkdownBlock] {
    if let hit = entries[source] { return hit }
    let blocks = MarkdownRenderer.blocks(from: source)
    entries[source] = blocks
    order.append(source)
    if order.count > capacity { entries[order.removeFirst()] = nil }
    return blocks
  }
}
