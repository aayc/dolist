import DailyDoListDrawingModel
import DailyDoListMobileDrawing
import DailyDoListMobileKit
import Foundation
import Observation

/// Keeps a live canvas separate from acknowledged file snapshots. Scene reconciliation runs off
/// the main actor and cannot interrupt a touch gesture or turn a stale save into an overwrite.
@MainActor @Observable
final class DrawingSession {
  let controller: MobileDrawingController
  private(set) var drawing: LocalDrawing
  private(set) var saving = false
  private(set) var hasUncheckpointedEdits = false
  var error: String?
  var onCheckpoint: (() -> Void)?
  @ObservationIgnored private let repository: DrawingRepository
  @ObservationIgnored private var durableScene: ExcalidrawScene
  @ObservationIgnored private var revision: UInt64 = 0
  @ObservationIgnored private var durableRevision: UInt64 = 0
  @ObservationIgnored private var incomingAfterInteraction: LocalDrawing?
  @ObservationIgnored private var debounce: Task<Void, Never>?
  @ObservationIgnored private var saveTask: Task<Void, Never>?

  init(drawing: LocalDrawing, repository: DrawingRepository) {
    self.drawing = drawing
    self.repository = repository
    durableScene = drawing.document.scene
    controller = MobileDrawingController(scene: drawing.document.scene)
    controller.isEditing = drawing.canEdit
    controller.onChange = { [weak self] _ in self?.changed() }
    // Imports are measured as the write request the next sync sends: this file's preserved
    // Markdown and its conditional version, not just the scene.
    controller.importContext = { [weak self] in
      DrawingImportContext(previous: self?.drawing.document, baseVersion: self?.drawing.baseVersion)
    }
    controller.onInteractionEnd = { [weak self] in
      guard let self else { return }
      if let incoming = self.incomingAfterInteraction {
        self.incomingAfterInteraction = nil
        Task {
          await self.adopt(incoming)
          await self.checkpoint()
        }
      } else if self.hasUncheckpointedEdits {
        self.scheduleCheckpoint()
      }
    }
  }

  var saveLabel: String {
    if let error { return error }
    if !drawing.canEdit { return "Read only · original drawing needs repair" }
    if saving || hasUncheckpointedEdits { return "Saving on iPhone…" }
    return switch drawing.state {
    case .synced: "Synced"
    case .waitingToSync: "Saved on iPhone · waiting to sync"
    case .needsReview: "Saved on iPhone · review changes"
    case .recoveryDraft: "Recovery drawing · original was removed"
    }
  }

  private func changed() {
    revision &+= 1
    hasUncheckpointedEdits = true
    scheduleCheckpoint()
  }

  private func scheduleCheckpoint() {
    debounce?.cancel()
    debounce = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      await self.checkpoint()
    }
  }

  func checkpoint() async {
    while let running = saveTask { await running.value }
    while let incoming = incomingAfterInteraction, !controller.hasActiveInteraction {
      incomingAfterInteraction = nil
      await adopt(incoming)
    }
    guard drawing.canEdit, revision != durableRevision, !controller.hasActiveInteraction,
      incomingAfterInteraction == nil
    else { return }
    let sentRevision = revision
    let scene = controller.scene
    let expected = drawing.localRevision
    saving = true
    let task = Task { [self] in
      defer {
        saving = false
        saveTask = nil
      }
      do {
        let saved = try await repository.save(
          path: drawing.path, scene: scene, expectedRevision: expected)
        guard saved.localRevision >= drawing.localRevision else { return }
        drawing = saved
        durableScene = scene
        durableRevision = sentRevision
        hasUncheckpointedEdits = revision != sentRevision
        error = nil
        onCheckpoint?()
      } catch WorkspaceRepositoryError.staleRevision {
        do {
          if let saved = try await repository.drawing(drawing.path) { await adopt(saved) }
        } catch { self.error = error.localizedDescription }
      } catch { self.error = error.localizedDescription }
    }
    saveTask = task
    await task.value
    if hasUncheckpointedEdits, error == nil { scheduleCheckpoint() }
  }

  func adopt(_ incoming: LocalDrawing) async {
    guard incoming.path == drawing.path, incoming.localRevision >= drawing.localRevision else {
      return
    }
    if controller.hasActiveInteraction {
      if incoming.localRevision >= (incomingAfterInteraction?.localRevision ?? 0) {
        incomingAfterInteraction = incoming
      }
      return
    }
    if let queued = incomingAfterInteraction, queued.localRevision > incoming.localRevision {
      await adopt(queued)
      return
    }
    incomingAfterInteraction = nil
    if !incoming.canEdit && hasUncheckpointedEdits {
      do {
        let retained = try await repository.preserveLiveDraft(
          path: incoming.path, scene: controller.scene, previous: drawing.document,
          expectedRevision: incoming.localRevision)
        await adopt(retained)
      } catch WorkspaceRepositoryError.staleRevision {
        do {
          if let latest = try await repository.drawing(incoming.path) { await adopt(latest) }
        } catch { self.error = error.localizedDescription }
      } catch {
        self.error =
          "Keep this drawing open. Its live changes could not be checkpointed: \(error.localizedDescription)"
      }
      return
    }
    let local = controller.scene
    let base = durableScene
    let epoch = revision
    let baseRevision = drawing.localRevision
    let (merged, matchesIncoming) = await Task.detached {
      let merged =
        incoming.canEdit
        ? SceneMerge.merge(base: base, local: local, remote: incoming.document.scene)
        : incoming.document.scene
      // Hashable includes decoder bookkeeping. Comparing it would repeatedly dirty a locally
      // created element after the host echoed its identical serialized representation.
      return (merged, SceneCodec.encode(merged) == SceneCodec.encode(incoming.document.scene))
    }.value
    guard incoming.path == drawing.path, incoming.localRevision >= drawing.localRevision else {
      return
    }
    if baseRevision != drawing.localRevision {
      await adopt(incoming)
      return
    }
    guard epoch == revision, !controller.hasActiveInteraction else {
      if incoming.localRevision >= (incomingAfterInteraction?.localRevision ?? 0) {
        incomingAfterInteraction = incoming
      }
      if !controller.hasActiveInteraction, let latest = incomingAfterInteraction {
        Task { await self.adopt(latest) }
      }
      return
    }
    drawing = incoming
    error = nil
    durableScene = incoming.document.scene
    controller.isEditing = incoming.canEdit
    controller.replaceScene(merged, keepHistory: true)
    if matchesIncoming {
      durableRevision = revision
      hasUncheckpointedEdits = false
    } else {
      changed()
    }
  }

  func retarget(_ incoming: LocalDrawing) {
    drawing = incoming
    durableScene = incoming.document.scene
  }

  func adoptRecovery(_ recovery: LocalDrawing) {
    drawing = recovery
    durableScene = recovery.document.scene
    if controller.scene == durableScene {
      durableRevision = revision
      hasUncheckpointedEdits = false
    }
  }

  /// An explicit recovery decision replaces the reviewed canvas without merging rejected edits.
  func adoptReviewed(_ incoming: LocalDrawing) {
    guard incoming.path == drawing.path else { return }
    drawing = incoming
    durableScene = incoming.document.scene
    controller.replaceScene(durableScene)
    controller.isEditing = incoming.canEdit
    durableRevision = revision
    hasUncheckpointedEdits = false
    incomingAfterInteraction = nil
    error = nil
  }
}
