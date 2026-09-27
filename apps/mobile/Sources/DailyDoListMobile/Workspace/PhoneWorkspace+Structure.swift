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
    let epoch = generation
    do {
      try await withCheckpointedStructure(action, synchronizeFirst: true) {
        guard self.online, self.generation == epoch else {
          throw WorkspaceRepositoryError.connectionChanged
        }
        return try await self.structural.perform(action, with: remote)
      }
    } catch WorkspaceMaintenanceError.dirtyAffectedNotes {
      self.error = "Sync or recover the affected notes before moving or deleting them."
    } catch { self.error = error.localizedDescription }
  }

  func resolveStructure(_ operation: WorkspaceStructuralOperation, as result: StructuralResolution)
    async
  {
    guard let remote, online, !structuralBusy else { return }
    let epoch = generation
    do {
      try await withCheckpointedStructure(operation.action, synchronizeFirst: false) {
        guard self.online, self.generation == epoch else {
          throw WorkspaceRepositoryError.connectionChanged
        }
        return try await self.structural.resolve(
          operation.id, revision: operation.revision, as: result, with: remote)
      }
    } catch { self.error = error.localizedDescription }
  }

  /// Keep affected editors fenced until the repository result has been adopted. A rejected
  /// checkpoint must block both a new host operation and resolution of an uncertain deletion.
  func withCheckpointedStructure(
    _ action: WorkspaceStructuralAction, synchronizeFirst: Bool,
    operation: @MainActor () async throws -> WorkspaceStructuralOperation
  ) async throws {
    guard !structuralBusy else { throw WorkspaceMaintenanceError.dirtyAffectedNotes }
    structuralBusy = true
    let editors = sessions.values.filter { action.affects($0.note.path) }
    for editor in editors {
      editor.finishComposition()
      editor.setStructureLocked(true)
    }
    let canvases = drawingSessions.values.filter { action.affects($0.drawing.path) }
    let editableCanvases = canvases.filter { $0.controller.isEditing }
    for canvas in canvases {
      canvas.controller.finishEditing()
      canvas.controller.isEditing = false
    }
    defer {
      for canvas in editableCanvases { canvas.controller.isEditing = canvas.drawing.canEdit }
      structuralBusy = false
      for editor in editors { editor.setStructureLocked(false) }
    }
    await checkpointAll()
    try PhoneRecoveryPreparation.validate(notes: editors, drawings: canvases)
    if synchronizeFirst {
      await synchronize()
      try PhoneRecoveryPreparation.validate(notes: editors, drawings: canvases)
    }
    let resolved = try await operation()
    await adoptStructure(resolved)
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
            configureEmbeds(session)
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
          for path in Array(savedPositions.keys) {
            if let renamed = action.remappedPath(path) {
              savedPositions[renamed] = savedPositions.removeValue(forKey: path)
            }
          }
        }
        await saveNavigation()
        await refreshTree()
      } else if operation.state == .notApplied {
        error = "The host rejected the change. Nothing was moved or deleted."
      }
      structuralOperations = try await structural.unresolved()
    } catch { self.error = error.localizedDescription }
  }
}
