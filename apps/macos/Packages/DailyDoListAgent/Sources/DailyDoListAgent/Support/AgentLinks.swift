import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What agent text needs from the host to follow `[[wikilinks]]`: opening a note and its hover
/// preview (read through the daemon's note API, cached by the host).
public struct AgentNoteLinks: Sendable {
  public var open: @MainActor @Sendable (String) -> Void
  public var preview: @MainActor @Sendable (String) async -> NotePreview?

  public init(
    open: @escaping @MainActor @Sendable (String) -> Void,
    preview: @escaping @MainActor @Sendable (String) async -> NotePreview?
  ) {
    self.open = open
    self.preview = preview
  }

  /// No host: wikilinks render as links, open nothing and preview only their name.
  public static let none = AgentNoteLinks(open: { _ in }, preview: { _ in nil })
}

private struct CitationSourcesKey: EnvironmentKey {
  static let defaultValue: [CitedSource] = []
}

private struct AgentNoteLinksKey: EnvironmentKey {
  static let defaultValue = AgentNoteLinks.none
}

extension EnvironmentValues {
  /// The web pages the thread on screen cites (`AgentThread.sources`).
  var citationSources: [CitedSource] {
    get { self[CitationSourcesKey.self] }
    set { self[CitationSourcesKey.self] = newValue }
  }

  /// How agent text opens and previews `[[wikilinks]]`.
  var agentNoteLinks: AgentNoteLinks {
    get { self[AgentNoteLinksKey.self] }
    set { self[AgentNoteLinksKey.self] = newValue }
  }
}

/// `[[wikilinks]]` in agent text become links with this scheme; they never leave the app.
enum WikiLinkURL {
  static let scheme = "ddl-note"

  /// A link to the note `target` (it may carry a `#heading`).
  static func url(for target: String) -> URL? {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "#?/")
    return target.addingPercentEncoding(withAllowedCharacters: allowed).flatMap {
      URL(string: "\(scheme):\($0)")
    }
  }

  /// The note a wikilink URL names.
  static func target(of url: URL) -> String? {
    guard url.scheme == scheme else { return nil }
    let encoded = url.absoluteString.dropFirst(scheme.count + 1)
    return String(encoded).removingPercentEncoding.flatMap { $0.isEmpty ? nil : $0 }
  }

  /// `Note`, `Note#Heading` → the name shown for the note.
  static func noteName(_ target: String) -> String {
    let name = target.split(separator: "#", maxSplits: 1).first.map(String.init) ?? target
    let last = name.split(separator: "/").last.map(String.init) ?? name
    return last.hasSuffix(".md") ? String(last.dropLast(3)) : last
  }
}

extension LinkPolicy {
  /// Agent-text link handling: wikilinks open notes through `noteLinks`, everything else goes
  /// through the policy.
  @MainActor
  static func openURLAction(noteLinks: AgentNoteLinks) -> OpenURLAction {
    OpenURLAction { url in
      if let target = WikiLinkURL.target(of: url) {
        noteLinks.open(target)
        return .handled
      }
      return open(url) ? .handled : .discarded
    }
  }
}
