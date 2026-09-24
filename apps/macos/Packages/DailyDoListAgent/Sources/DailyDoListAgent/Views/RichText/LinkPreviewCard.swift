import SwiftUI

/// The hover card of a link in agent text: a page (title, hostname, snippet, full URL) or a note
/// (its name and first lines, loaded through the host).
struct LinkPreviewCard: View {
  let content: LinkPreviewContent
  let noteLinks: AgentNoteLinks

  var body: some View {
    Group {
      switch content {
      case .page(let preview): PagePreview(preview: preview)
      case .note(let target): NotePreviewView(target: target, noteLinks: noteLinks)
      }
    }
    .padding(12)
    .frame(width: 300, alignment: .leading)
  }
}

private struct PagePreview: View {
  let preview: LinkPreview

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(verbatim: preview.title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(AgentTheme.text)
        .lineLimit(2)
      if !preview.host.isEmpty {
        Label(preview.host, systemImage: "globe")
          .font(.caption)
          .foregroundStyle(AgentTheme.mutedText)
          .lineLimit(1)
      }
      if let snippet = preview.snippet {
        Text(verbatim: snippet)
          .font(.callout)
          .foregroundStyle(AgentTheme.text)
          .lineLimit(5)
          .fixedSize(horizontal: false, vertical: true)
      }
      Text(verbatim: preview.url)
        .font(.caption2)
        .foregroundStyle(AgentTheme.faint)
        .lineLimit(2)
        .truncationMode(.middle)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A note's name and first lines; the lines load when the card appears.
struct NotePreviewView: View {
  let target: String
  let noteLinks: AgentNoteLinks
  @State private var preview: NotePreview?
  @State private var loaded = false

  init(target: String, noteLinks: AgentNoteLinks, preview: NotePreview? = nil) {
    self.target = target
    self.noteLinks = noteLinks
    self._preview = State(initialValue: preview)
    self._loaded = State(initialValue: preview != nil)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Label(preview?.title ?? WikiLinkURL.noteName(target), systemImage: "doc.text")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(AgentTheme.text)
        .lineLimit(1)
      if let lines = preview?.lines, !lines.isEmpty {
        Text(verbatim: lines.joined(separator: "\n"))
          .font(.callout)
          .foregroundStyle(AgentTheme.mutedText)
          .lineLimit(8)
          .fixedSize(horizontal: false, vertical: true)
      } else if loaded {
        Text(preview == nil ? "Not in this vault yet — clicking creates it." : "Empty note")
          .font(.callout)
          .foregroundStyle(AgentTheme.faint)
      } else {
        ProgressView().controlSize(.small)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task(id: target) {
      guard !loaded else { return }
      preview = await noteLinks.preview(target)
      loaded = true
    }
  }
}
