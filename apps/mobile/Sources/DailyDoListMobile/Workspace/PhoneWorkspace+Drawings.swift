import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import UIKit

extension PhoneWorkspace {
  func openDrawing(_ requested: String, newTab: Bool = false, recordHistory: Bool = true) async {
    let path = requested.hasSuffix(".md") ? requested : requested + ".md"
    navigation &+= 1
    let request = navigation
    do {
      await checkpointAll(finishComposition: true)
      guard request == navigation else { return }
      if let cached = try await drawingRepository.drawing(path) {
        guard request == navigation else { return }
        showDrawing(cached)
      }
      if let remote, online {
        await refreshDrawing(path, remote: remote)
        guard request == navigation else { return }
        if let cached = try await drawingRepository.drawing(path) {
          guard request == navigation else { return }
          showDrawing(cached)
        }
      }
      guard activeDrawing?.drawing.path == path else {
        error = "This drawing has not been downloaded to this iPhone yet."
        return
      }
      tabs.place(path, newTab: newTab, recordHistory: recordHistory)
      scheduleNavigationSave()
      selectedTab = 0
    } catch { if request == navigation { self.error = error.localizedDescription } }
  }

  func createDrawing(_ requested: String) async {
    guard !structuralBusy else { return }
    do {
      let requested = try VaultPath.validated(requested)
      let components = requested.split(separator: "/")
      let path = DrawingFileName.path(
        forName: components.last.map(String.init) ?? "Drawing",
        folder: components.dropLast().joined(separator: "/"))
      let drawing = try await drawingRepository.create(path: path)
      includeLocalDrawings([drawing])
      showDrawing(drawing)
      tabs.place(path)
      scheduleNavigationSave()
      selectedTab = 0
      await synchronize()
    } catch { self.error = error.localizedDescription }
  }

  func refreshDrawing(_ path: String, remote: HTTPWorkspaceRemote) async {
    let epoch = generation
    do { try await refreshDrawingChecked(path, remote: remote) } catch {
      if epoch == generation { self.error = error.localizedDescription }
    }
  }

  func refreshDrawingChecked(_ path: String, remote: HTTPWorkspaceRemote) async throws {
    let epoch = generation
    let existing = drawingSessions[path]
    await existing?.checkpoint()
    let drawing = try await drawingRepository.refresh(path: path, with: remote)
    guard epoch == generation else { return }
    if let drawing {
      await existing?.adopt(drawing)
    } else if let existing,
      existing.hasUncheckpointedEdits || existing.controller.hasActiveInteraction
    {
      existing.controller.finishEditing()
      let recovery = try await drawingRepository.createRecoveryDraft(
        path: path, scene: existing.controller.scene, previous: existing.drawing.document)
      existing.adoptRecovery(recovery)
    } else {
      drawingSessions[path] = nil
      if activeDrawing?.drawing.path == path {
        activeDrawing = nil
        error = "This drawing was removed on the host."
      }
    }
  }

  func showDrawing(_ drawing: LocalDrawing) {
    active = nil
    activeDrawing = drawingSession(drawing)
  }

  func drawingSession(_ drawing: LocalDrawing) -> DrawingSession {
    if let session = drawingSessions[drawing.path] { return session }
    let session = DrawingSession(drawing: drawing, repository: drawingRepository)
    session.controller.library = drawingLibrary
    session.onCheckpoint = { [weak self] in
      guard let self else { return }
      for note in self.sessions.values { note.editor.drawingsDidChange() }
      Task { await self.synchronize() }
    }
    session.controller.onOpenLink = { [weak self, weak session] link in
      guard let self, let session else { return }
      if link.hasPrefix("[["), link.hasSuffix("]]") {
        let parts = String(link.dropFirst(2).dropLast(2)).split(
          separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        self.openEditorLink(
          .note(
            target: String(parts[0]),
            subpath: parts.count > 1 ? String(parts[1]) : nil), from: session.drawing.path)
      } else if let url = URL(string: link), LinkPolicy.isAllowed(url) {
        UIApplication.shared.open(url)
      } else {
        self.error = "This link cannot be opened safely."
      }
    }
    session.controller.elementLink = { [weak session] elementID in
      session.map { "[[\($0.drawing.path)#^\(elementID)]]" }
    }
    drawingSessions[drawing.path] = session
    return session
  }

  func includeLocalDrawings(_ drawings: [LocalDrawing]) {
    let known = Set(entries.map(\.path))
    entries += drawings.filter { !known.contains($0.path) }.map {
      VaultEntry(path: $0.path, kind: .file, version: $0.baseVersion)
    }
    entries.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
  }
}
