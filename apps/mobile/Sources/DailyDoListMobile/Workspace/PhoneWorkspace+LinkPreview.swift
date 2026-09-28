import DailyDoListEditorCore
import Foundation

struct PhoneLinkDestination: Identifiable {
  let request: PhoneNoteLinkRequest
  let sourcePath: String
  let generation: UInt64
  var id: UUID { request.id }
}

extension PhoneWorkspace {
  func isCurrentLink(_ destination: PhoneLinkDestination) -> Bool {
    generation == destination.generation && routedLink?.id == destination.id
  }

  func linkPreview(_ destination: PhoneLinkDestination) -> PhoneNoteLinkPreviewModel {
    PhoneNoteLinkPreviewModel(
      request: destination.request,
      isCurrent: { [weak self] in self?.isCurrentLink(destination) == true },
      cachedNote: { [weak self] target, _ in
        guard let self, self.isCurrentLink(destination),
          let path = target.isEmpty
            ? destination.sourcePath : self.embedPath(target)
        else { return nil }
        if let session = self.sessions[path] {
          return PhoneCachedNotePreview(path: path, text: session.editor.text)
        }
        guard let note = try await self.repository.note(path), self.isCurrentLink(destination)
        else {
          return nil
        }
        return PhoneCachedNotePreview(path: path, text: note.content)
      },
      savedSources: { [weak self] id in
        guard let self, self.isCurrentLink(destination), let agent = self.agent else { return [] }
        await agent.loadThread(id, quiet: true)
        guard self.isCurrentLink(destination) else { return [] }
        return agent.thread(id)?.sources ?? []
      })
  }
}
