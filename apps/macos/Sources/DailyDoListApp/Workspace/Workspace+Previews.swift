import DailyDoListAgent
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation

extension Workspace {
  /// How the agent panel opens and previews `[[wikilinks]]` in agent text.
  var agentNoteLinks: AgentNoteLinks {
    AgentNoteLinks(
      open: { [weak self] target in
        guard let self else { return }
        Task { await self.openWikiLink(target, newTab: false) }
      },
      preview: { [weak self] target in await self?.notePreviews.preview(for: target) })
  }

  /// The vault path a wikilink target names, like Obsidian.
  func resolveWikiLink(_ rawTarget: String) -> String? {
    WikiLinks.resolve(NotePaths.wikiLinkTarget(rawTarget), in: vault.files)
  }

  /// The tooltip of a link in the editor. A page linked from a line the agent wrote is described by
  /// the sources of the thread named by the line's marker (loaded once, in the background, when it
  /// isn't yet); other pages by their link. Notes show their first lines once read.
  func linkPreviewText(for link: EditorLinkPreview) -> String? {
    switch link.target {
    case .external(let url):
      var sources: [CitedSource] = []
      if let threadId = link.agentThreadId, let agent {
        if let thread = agent.thread(threadId) {
          sources = thread.sources ?? []
        } else if previewThreadLoads.insert(threadId).inserted {
          Task { await agent.loadThread(threadId) }
        }
      }
      return LinkPreview.make(url: url.absoluteString, label: link.label, sources: sources).text
    case .note(let target, _):
      if let preview = notePreviews.cachedPreview(for: target) { return preview.text }
      notePreviews.prefetch(target)
      return nil
    }
  }
}
