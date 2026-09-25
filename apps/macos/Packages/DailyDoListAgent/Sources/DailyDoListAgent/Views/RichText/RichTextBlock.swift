import AppKit
import SwiftUI

/// One block of agent text (a paragraph, heading, list item or quote) in a `CitationTextView`:
/// links have hover previews from the thread's sources and citations are chips. `caret` puts the
/// typing caret after its last character.
struct RichTextBlock: NSViewRepresentable {
  let text: AttributedString
  var style: RichTextStyle = .body
  var caret: CaretMode?
  @Environment(\.citationSources) private var sources
  @Environment(\.agentNoteLinks) private var noteLinks

  func makeNSView(context: Context) -> CitationTextView {
    CitationTextView()
  }

  func updateNSView(_ view: CitationTextView, context: Context) {
    view.sources = sources
    view.noteLinks = noteLinks
    view.setContent(text, style: style)
    view.caret = caret
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: CitationTextView, context: Context)
    -> CGSize?
  {
    let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? nsView.naturalWidth
    return CGSize(width: width, height: nsView.height(forWidth: width))
  }

  static func dismantleNSView(_ view: CitationTextView, coordinator: ()) {
    view.closePreview()
  }
}
