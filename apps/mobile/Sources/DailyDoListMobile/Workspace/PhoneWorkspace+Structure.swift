import DailyDoListDomain
import DailyDoListMobileKit
import DailyDoListModels
import DailyDoListWorkspaceCore
import Foundation

extension PhoneWorkspace {
  func createFolder(_ requested: String) async {
    guard let client, online, !structuralBusy else {
      error = "Connect to the host to create a folder."
      return
    }
    let epoch = generation
    do {
      let path = try VaultPath.validated(requested)
      guard !path.isEmpty else { throw WorkspaceRepositoryError.invalidPath }
      _ = try await client.createFolder(path)
      guard epoch == generation else { return }
      await refreshTree()
    } catch { if epoch == generation { self.error = error.localizedDescription } }
  }

  func changeStructure(_ action: WorkspaceStructuralAction) async {
    guard let remote, online, !structuralBusy else {
      error = "Connect to the host first."
      return
    }
    structuralBusy = true
    let editors = sessions.values.filter { action.affects($0.note.path) }
    for editor in editors {
      editor.finishComposition()
      editor.setStructureLocked(true)
    }
    let canvases = drawingSessions.values.filter { action.affects($0.drawing.path) }
    for canvas in canvases {
      canvas.controller.finishEditing()
      canvas.controller.isEditing = false
    }
    defer {
      for canvas in canvases { canvas.controller.isEditing = canvas.drawing.canEdit }
      structuralBusy = false
      for editor in editors { editor.setStructureLocked(false) }
    }
    do {
      await checkpointAll()
      await synchronize()
      guard online else { throw WorkspaceRepositoryError.connectionChanged }
      let operation = try await structural.perform(action, with: remote)
      await adoptStructure(operation)
    } catch WorkspaceMaintenanceError.dirtyAffectedNotes {
      self.error = "Sync or recover the affected notes before moving or deleting them."
    } catch { self.error = error.localizedDescription }
  }

  func resolveStructure(_ operation: WorkspaceStructuralOperation, as result: StructuralResolution)
    async
  {
    guard let remote, online else { return }
    do {
      let resolved = try await structural.resolve(
        operation.id, revision: operation.revision, as: result, with: remote)
      await adoptStructure(resolved)
    } catch { self.error = error.localizedDescription }
  }

  private func adoptStructure(_ operation: WorkspaceStructuralOperation) async {
    do {
      if operation.state == .applied {
        let action = operation.action
        for path in Array(sessions.keys) where action.affects(path) {
          guard let session = sessions[path] else { continue }
          if let destination = action.remappedPath(path),
            let saved = try await repository.note(destination)
          {
            sessions[path] = nil
            sessions[destination] = session
            session.retarget(saved)
          } else if let retained = try await repository.note(path) {
            session.adoptRecovery(retained)
          } else {
            sessions[path] = nil
            tabs.close(path)
            tabs.purge(path)
            if active?.note.path == path { active = nil }
          }
        }
        for path in Array(drawingSessions.keys) where action.affects(path) {
          guard let session = drawingSessions[path] else { continue }
          if let destination = action.remappedPath(path),
            let saved = try await drawingRepository.drawing(destination)
          {
            drawingSessions[path] = nil
            drawingSessions[destination] = session
            session.retarget(saved)
          } else if let retained = try await drawingRepository.drawing(path) {
            session.adoptRecovery(retained)
          } else {
            drawingSessions[path] = nil
            tabs.close(path)
            tabs.purge(path)
            if activeDrawing?.drawing.path == path { activeDrawing = nil }
          }
        }
        if let destination = action.destination {
          tabs.rename(from: action.source, to: destination)
        }
        await refreshTree()
      } else if operation.state == .notApplied {
        error = "The host rejected the change. Nothing was moved or deleted."
      }
      structuralOperations = try await structural.unresolved()
    } catch { self.error = error.localizedDescription }
  }
}
