#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListDomain
  import DailyDoListModels
  import SwiftUI

  /// Native markdown with source-backed link previews. Merely opening a preview never fetches
  /// the external page, and unsupported URL schemes never leave the app.
  struct MobileMarkdownView: View {
    let source: String
    var streaming = false
    var sources: [CitedSource] = []
    var openNote: (String, Int?) -> Void = { _, _ in }
    @State private var preview: Preview?
    @Environment(\.openURL) private var openURL

    private struct Preview: Identifiable {
      let url: URL
      let content: LinkPreview
      var id: String { url.absoluteString }
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(MarkdownDocument.blocks(for: source, typing: streaming)) { item in
          block(item.block)
        }
        if streaming {
          Label("Writing…", systemImage: "ellipsis").font(.caption).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
      .environment(
        \.openURL,
        OpenURLAction { url in
          if let target = WikiLinkURL.target(of: url) {
            openNote(target, nil)
          } else if LinkPolicy.isAllowed(url) {
            preview = Preview(
              url: url,
              content: LinkPreview.make(url: url.absoluteString, label: nil, sources: sources))
          }
          return .handled
        }
      )
      .sheet(item: $preview) { preview in
        NavigationStack {
          Form {
            Section {
              Text(preview.content.title).font(.headline)
              if let snippet = preview.content.snippet { Text(snippet) }
              Text(preview.content.url).font(.caption).textSelection(.enabled)
            } footer: {
              Text("Preview uses the source saved with this conversation.")
            }
            Button("Open link") {
              guard LinkPolicy.isAllowed(preview.url) else { return }
              openURL(preview.url)
            }
          }
          .navigationTitle("Source")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { self.preview = nil } }
          }
        }
      }
    }

    @ViewBuilder private func block(_ block: MarkdownBlock) -> some View {
      switch block {
      case .paragraph(_, let text): Text(text)
      case .heading(_, let level, let text):
        Text(text).font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
          .padding(.top, 6)
      case .listItem(_, let marker, let depth, let text):
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(marker ?? "").frame(minWidth: 14, alignment: .trailing)
          Text(text).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.leading, CGFloat(max(0, depth - 1)) * 16)
      case .quote(_, let text):
        HStack(spacing: 10) {
          Rectangle().fill(.secondary.opacity(0.4)).frame(width: 3)
          Text(text).italic().foregroundStyle(.secondary)
        }.fixedSize(horizontal: false, vertical: true)
      case .code(_, let language, let code):
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            if let language { Text(language).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Button("Copy code", systemImage: "doc.on.doc") { UIPasteboard.general.string = code }
              .labelStyle(.iconOnly).font(.caption)
          }
          MobileJSONView(text: code)
        }
      case .table(_, let header, let rows):
        ScrollView(.horizontal) {
          Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            GridRow { ForEach(header.indices, id: \.self) { Text(header[$0]).bold() } }
            Divider()
            ForEach(rows.indices, id: \.self) { row in
              GridRow { ForEach(rows[row].indices, id: \.self) { Text(rows[row][$0]) } }
            }
          }.padding(8)
        }
      case .rule: Divider().padding(.vertical, 4)
      }
    }
  }
#endif
