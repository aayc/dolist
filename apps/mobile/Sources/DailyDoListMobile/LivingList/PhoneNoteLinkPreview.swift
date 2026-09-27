import DailyDoListAgentCore
import DailyDoListDomain
import DailyDoListEditorCore
import DailyDoListModels
import Foundation
import Observation
import SwiftUI

struct PhoneNoteLinkRequest: Identifiable {
  let id = UUID()
  let link: EditorLinkPreview
}

/// A bounded plain-text snapshot supplied by the current workspace's local repository.
struct PhoneCachedNotePreview: Sendable {
  let path: String
  let text: String
}

@MainActor @Observable
final class PhoneNoteLinkPreviewModel {
  enum Content: Equatable {
    case external(LinkPreview)
    case note(path: String, lines: [String])
    case unavailable
  }
  let request: PhoneNoteLinkRequest
  private(set) var content: Content = .unavailable
  private(set) var loading = false
  @ObservationIgnored let isCurrent: () -> Bool
  @ObservationIgnored private let cachedNote:
    (String, String?) async throws -> PhoneCachedNotePreview?
  @ObservationIgnored private let savedSources: (String) async throws -> [CitedSource]
  @ObservationIgnored private var generation: UInt64 = 0

  init(
    request: PhoneNoteLinkRequest, isCurrent: @escaping () -> Bool,
    cachedNote: @escaping (String, String?) async throws -> PhoneCachedNotePreview?,
    savedSources: @escaping (String) async throws -> [CitedSource]
  ) {
    self.request = request
    self.isCurrent = isCurrent
    self.cachedNote = cachedNote
    self.savedSources = savedSources
    if case .external(let url) = request.link.target, LinkPolicy.isAllowed(url) {
      content = .external(
        LinkPreview.make(url: url.absoluteString, label: request.link.label, sources: []))
    }
  }

  func load() async {
    generation &+= 1
    let current = generation
    guard isCurrent() else {
      content = .unavailable
      return
    }
    loading = true
    defer { if generation == current { loading = false } }
    do {
      switch request.link.target {
      case .external(let url):
        guard LinkPolicy.isAllowed(url), let thread = request.link.agentThreadId else { return }
        let sources = try await savedSources(thread)
        guard current == generation, isCurrent(), !Task.isCancelled else { return }
        content = .external(
          LinkPreview.make(url: url.absoluteString, label: request.link.label, sources: sources))
      case .note(let target, let subpath):
        let note = try await cachedNote(target, subpath)
        guard current == generation, isCurrent(), !Task.isCancelled else { return }
        if let note {
          // Limit both the amount scanned and each displayed line. Rendering never parses HTML
          // or follows links from a cached note, including instructions embedded in its text.
          let prefix = String(note.text.prefix(4096))
          let lines = prefix.split(whereSeparator: \.isNewline).lazy
            .map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .prefix(6).map { String($0.prefix(240)) }
          content = .note(path: note.path, lines: Array(lines))
        } else {
          content = .unavailable
        }
      }
    } catch {
      // An external link retains its safe local fallback; absent cached notes stay unavailable.
    }
  }

  func invalidate() {
    generation &+= 1
    loading = false
    content = .unavailable
  }
}

/// No web view or LinkPresentation fetch: external previews use stored citation sources, and
/// note previews use the injected local snapshot. Only the explicit Open action follows a link.
struct PhoneNoteLinkPreview: View {
  @State private var model: PhoneNoteLinkPreviewModel
  let open: (EditorLinkPreview.Target) -> Void
  @Environment(\.dismiss) private var dismiss

  init(model: PhoneNoteLinkPreviewModel, open: @escaping (EditorLinkPreview.Target) -> Void) {
    _model = State(initialValue: model)
    self.open = open
  }

  var body: some View {
    NavigationStack {
      Form {
        if !model.isCurrent() {
          Text("The connection changed. Close this preview and open the link again.")
        } else {
          Section {
            switch model.content {
            case .external(let preview):
              Text(preview.title).font(.headline)
              if let snippet = preview.snippet { Text(snippet) }
              Text(preview.url).font(.caption).textSelection(.enabled)
            case .note(let path, let lines):
              Text(VaultPath.stem(path)).font(.headline)
              Text(path).font(.caption).foregroundStyle(.secondary)
              ForEach(Array(lines.enumerated()), id: \.offset) { Text(verbatim: $0.element) }
            case .unavailable:
              Text(model.request.link.fallbackText).textSelection(.enabled)
              Text("No downloaded preview is available.").foregroundStyle(.secondary)
            }
            if model.loading { ProgressView("Loading saved preview…") }
          } footer: {
            Text(
              "Uses downloaded notes and saved conversation sources. External pages are not fetched."
            )
          }
          Button("Open link") {
            guard model.isCurrent() else { return }
            if case .external(let url) = model.request.link.target,
              !LinkPolicy.isAllowed(url)
            {
              return
            }
            open(model.request.link.target)
            dismiss()
          }.accessibilityIdentifier("note.link.open")
        }
      }
      .navigationTitle("Link preview").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .task { await model.load() }
    .onDisappear { model.invalidate() }
  }
}
