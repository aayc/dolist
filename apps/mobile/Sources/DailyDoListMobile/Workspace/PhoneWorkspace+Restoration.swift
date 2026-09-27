import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListMobileKit
import Foundation

extension PhoneWorkspace {
  func restoreNavigation() async throws {
    guard let saved = try await cache.navigation()?.value else { return }
    tabs.restore(saved.tabs) { (try? VaultPath.validated($0)) == $0 }
    savedPositions = saved.positions
    if let path = tabs.active {
      if DrawingFileName.isDrawingPath(path) {
        if let drawing = try await drawingRepository.drawing(path) { showDrawing(drawing) }
      } else if let note = try await repository.note(path) {
        show(note)
      }
    }
    selectedTab = min(4, max(0, saved.section))
  }

  func scheduleNavigationSave() {
    navigationDebounce?.cancel()
    navigationDebounce = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      await self.saveNavigation()
    }
  }

  func saveNavigation() async {
    while let savingNavigation { await savingNavigation.value }
    for session in sessions.values {
      savedPositions[session.note.path] = WorkspaceNavigation.Position(
        selection: session.editor.selection, scrollY: session.editor.input.contentOffset.y)
    }
    let retained = Set(tabs.tabs + tabs.backStack + tabs.forwardStack + tabs.closedTabs.map(\.path))
    savedPositions = savedPositions.filter { retained.contains($0.key) }
    let state = WorkspaceNavigation(
      tabs: tabs.snapshot, positions: savedPositions, section: selectedTab)
    let saving = Task { [self] in
      defer { savingNavigation = nil }
      do {
        let previous = try await cache.navigation()?.revision
        _ = try await cache.storeNavigation(state, replacing: previous)
      } catch WorkspaceRepositoryError.concurrentWrite {
        scheduleNavigationSave()
      } catch { self.error = error.localizedDescription }
    }
    savingNavigation = saving
    await saving.value
  }

  func restorePosition(_ session: NoteSession) {
    if let position = savedPositions[session.note.path] {
      let count = session.editor.input.textStorage.length
      let start = min(count, max(0, position.selection.location))
      session.editor.selection = NSRange(
        location: start, length: min(count - start, max(0, position.selection.length)))
      session.editor.restoreScrollPosition(position.scrollY)
    }
    session.editor.onSelectionChange = { [weak self, weak session] _ in
      self?.scheduleNavigationSave()
      if let session { self?.reportPresence(session) }
    }
    session.editor.onScrollChange = { [weak self] _ in self?.scheduleNavigationSave() }
  }
}
