import AppKit
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Shows one artifact (present it as a sheet or in its own window): markdown and JSON rendered,
/// code with line numbers, HTML sandboxed, images; Copy and Save As….
public struct ArtifactViewer: View {
  let store: AgentStore
  let threadId: String
  let artifactId: String
  @State private var phase: Phase = .loading
  @Environment(\.dismiss) private var dismiss

  enum Phase {
    case loading
    case failed(String)
    case ready(ArtifactPayload)
  }

  public init(store: AgentStore, threadId: String, artifactId: String) {
    self.store = store
    self.threadId = threadId
    self.artifactId = artifactId
  }

  public var body: some View {
    ArtifactViewerContent(
      meta: store.artifactMeta(threadId: threadId, artifactId: artifactId), phase: phase,
      onRetry: { Task { await load() } }, onClose: { dismiss() }
    )
    .task(id: artifactId) { await load() }
  }

  private func load() async {
    phase = .loading
    do {
      phase = .ready(try await store.fetchArtifact(threadId: threadId, artifactId: artifactId))
    } catch {
      phase = .failed(AgentAlert.describe(error))
    }
  }
}

/// The viewer's chrome and body for a given load phase.
struct ArtifactViewerContent: View {
  let meta: ArtifactMeta?
  let phase: ArtifactViewer.Phase
  var onRetry: () -> Void = {}
  var onClose: () -> Void = {}

  private var payload: ArtifactPayload? {
    if case .ready(let payload) = phase { return payload }
    return nil
  }

  private var kind: ArtifactKind {
    meta?.kind ?? payload.map { ArtifactFiles.kind(forMimeType: $0.mimeType) } ?? .file
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      content.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(minWidth: 560, idealWidth: 720, minHeight: 420, idealHeight: 560)
    .tint(Theme.accent)
    .environment(\.openURL, LinkPolicy.openURLAction)
  }

  private var header: some View {
    HStack(spacing: 8) {
      Image(systemName: kind.systemImage).foregroundStyle(Theme.accent)
      Text(verbatim: meta?.title ?? "Artifact").font(.headline).lineLimit(1)
      Chip(text: meta?.kindLabel ?? kind.displayLabel)
      if let meta {
        Text(verbatim: AgentFormat.bytes(meta.size)).font(.caption).foregroundStyle(
          Theme.mutedText)
      }
      Spacer(minLength: 8)
      Button {
        if let payload { ArtifactFiles.copy(payload, kind: kind) }
      } label: {
        Label("Copy", systemImage: "doc.on.doc")
      }
      .pointingHandCursor()
      .disabled(payload == nil || !ArtifactFiles.canCopy(kind))
      Button {
        if let payload {
          ArtifactFiles.save(
            payload,
            suggestedName: ArtifactFiles.fileName(
              meta: meta, kind: kind, mimeType: payload.mimeType))
        }
      } label: {
        Label("Save As…", systemImage: "square.and.arrow.down")
      }
      .pointingHandCursor()
      .disabled(payload == nil)
      Button("Done", action: onClose).keyboardShortcut(.cancelAction)
        .pointingHandCursor()
        .tooltip("Close", keys: .escapeKey)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .loading:
      ProgressView("Loading…")
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn't open the artifact", systemImage: "exclamationmark.triangle")
      } description: {
        Text(verbatim: message)
      } actions: {
        Button("Try Again", action: onRetry).pointingHandCursor()
      }
    case .ready(let payload):
      ArtifactBody(kind: kind, payload: payload, language: meta?.language, title: meta?.title)
    }
  }
}

private struct ArtifactBody: View {
  let kind: ArtifactKind
  let payload: ArtifactPayload
  let language: String?
  let title: String?

  private var text: String { ArtifactFiles.text(of: payload) }

  var body: some View {
    switch kind {
    case .markdown:
      ScrollView {
        MarkdownView(source: text)
          .frame(maxWidth: 760, alignment: .leading)
          .padding(24)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    case .code:
      CodeArtifactView(code: text, language: language)
    case .html:
      HTMLArtifactView(html: text)
    case .image:
      if let image = NSImage(data: payload.data) {
        TopLeadingScrollView {
          Image(nsImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: image.size.width, maxHeight: image.size.height)
            .padding(16)
            .accessibilityLabel(title ?? "Image")
        }
      } else {
        unpreviewable
      }
    case .json:
      TopLeadingScrollView {
        Text(verbatim: ArtifactFiles.prettyJSON(payload.data) ?? text)
          .font(.system(size: 12, design: .monospaced))
          .textSelection(.enabled)
          .fixedSize()
          .padding(16)
      }
      .background(Theme.codeBackground)
    case .text:
      ScrollView {
        Text(verbatim: text)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(20)
      }
    default:
      unpreviewable
    }
  }

  private var unpreviewable: some View {
    ContentUnavailableView(
      "No Preview", systemImage: "doc",
      description: Text("This file can't be previewed. Use Save As… to keep a copy."))
  }
}

/// Code with line numbers (numbers and code share one monospaced font, so lines align). The
/// language is shown by the viewer's header.
struct CodeArtifactView: View {
  let code: String
  let language: String?

  var body: some View {
    let lineCount = max(code.split(separator: "\n", omittingEmptySubsequences: false).count, 1)
    let numbers = (1...lineCount).map(String.init).joined(separator: "\n")
    TopLeadingScrollView {
      HStack(alignment: .top, spacing: 14) {
        Text(verbatim: numbers)
          .foregroundStyle(Theme.faintText)
          .multilineTextAlignment(.trailing)
          .accessibilityHidden(true)
        Text(verbatim: code).textSelection(.enabled)
      }
      .font(.system(size: 12, design: .monospaced))
      .fixedSize()
      .padding(16)
    }
    .background(Theme.codeBackground)
    .accessibilityLabel(language.map { "\($0) code" } ?? "Code")
  }
}

/// Artifact bytes: kinds, names, text decoding, copy and save.
enum ArtifactFiles {
  static func kind(forMimeType mimeType: String) -> ArtifactKind {
    let type =
      mimeType.split(separator: ";").first.map {
        $0.trimmingCharacters(in: .whitespaces).lowercased()
      } ?? ""
    if type.hasPrefix("image/") { return .image }
    switch type {
    case "text/markdown": return .markdown
    case "text/html": return .html
    case "application/json": return .json
    default: return type.hasPrefix("text/") ? .text : .file
    }
  }

  static func text(of payload: ArtifactPayload) -> String {
    String(data: payload.data, encoding: .utf8) ?? String(decoding: payload.data, as: UTF8.self)
  }

  /// Pretty-printed JSON (keys sorted), or nil when it isn't JSON.
  static func prettyJSON(_ data: Data) -> String? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
    return value.prettyJSONString
  }

  static func canCopy(_ kind: ArtifactKind) -> Bool { kind != .file }

  @MainActor
  static func copy(_ payload: ArtifactPayload, kind: ArtifactKind) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    if kind == .image, let image = NSImage(data: payload.data) {
      pasteboard.writeObjects([image])
    } else {
      pasteboard.setString(text(of: payload), forType: .string)
    }
  }

  @MainActor
  static func save(_ payload: ArtifactPayload, suggestedName: String) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedName
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.begin { response in
      guard response == .OK, let url = panel.url else { return }
      do {
        try payload.data.write(to: url, options: .atomic)
      } catch {
        NSAlert(error: error).runModal()
      }
    }
  }

  /// "Standing desks under $500.md": the title (made safe for a file name) and an extension.
  static func fileName(meta: ArtifactMeta?, kind: ArtifactKind, mimeType: String) -> String {
    let unsafe = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
    let base = (meta?.title ?? "artifact").components(separatedBy: unsafe).joined(separator: "-")
      .trimmingCharacters(in: .whitespaces)
    return
      "\(base.isEmpty ? "artifact" : base).\(fileExtension(kind: kind, language: meta?.language, mimeType: mimeType))"
  }

  static func fileExtension(kind: ArtifactKind, language: String?, mimeType: String) -> String {
    switch kind {
    case .markdown: return "md"
    case .html: return "html"
    case .json: return "json"
    case .text: return "txt"
    case .image:
      let subtype = mimeType.split(separator: "/").last.map(String.init) ?? "png"
      return subtype == "jpeg" ? "jpg" : subtype.isEmpty ? "png" : subtype
    case .code:
      let known = [
        "python": "py", "javascript": "js", "typescript": "ts", "swift": "swift", "shell": "sh",
        "bash": "sh", "ruby": "rb", "go": "go", "rust": "rs", "java": "java", "css": "css",
        "sql": "sql", "yaml": "yml", "json": "json", "html": "html", "markdown": "md",
      ]
      return language.flatMap { known[$0.lowercased()] } ?? "txt"
    default: return "bin"
    }
  }
}
