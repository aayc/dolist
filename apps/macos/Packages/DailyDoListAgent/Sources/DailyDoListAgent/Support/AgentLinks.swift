import DailyDoListAgentCore
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
