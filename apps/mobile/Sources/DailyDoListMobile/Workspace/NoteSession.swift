import DailyDoListDomain
import DailyDoListEditorCore
import DailyDoListMobileEditor
import DailyDoListMobileKit
import Foundation
import Observation

/// A stable text system per open note. SwiftUI observes save state, never the document per key.
@MainActor @Observable
final class NoteSession {
  let editor = MobileMarkdownController()
  private(set) var note: LocalNote
  private(set) var saving = false
  private(set) var hasUncheckpointedEdits = false
  var error: String?
  @ObservationIgnored private let repository: WorkspaceRepository
  @ObservationIgnored private var durableText: String
  @ObservationIgnored private var revision: UInt64 = 0
  @ObservationIgnored private var durableRevision: UInt64 = 0
  @ObservationIgnored private var incomingAfterComposition: LocalNote?
  @ObservationIgnored private var requiresReview = false
  @ObservationIgnored private var debounce: Task<Void, Never>?
  @ObservationIgnored private var saveTask: Task<Void, Never>?
  @ObservationIgnored private var editableBeforeStructure: Bool?
  var onCheckpoint: (() -> Void)?

  init(note: LocalNote, repository: WorkspaceRepository) {
    self.note = note
    durableText = note.content
    self.repository = repository
    editor.load(note.content)
    editor.onTextChange = { [weak self] _ in self?.changed() }
    editor.onCompositionEnd = { [weak self] in
      guard let self else { return }
      if let incoming = self.incomingAfterComposition {
        self.incomingAfterComposition = nil
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
    if saving || hasUncheckpointedEdits { return "Saving on iPhone…" }
    switch note.state {
    case .synced: return "Synced"
    case .waitingToSync: return "Saved on iPhone · waiting to sync"
    case .needsReview: return "Saved on iPhone · review changes"
    case .recoveryDraft: return "Recovery draft · original note was removed"
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
    guard revision != durableRevision, editor.input.markedTextRange == nil,
      incomingAfterComposition == nil
    else { return }
    let sentRevision = revision
    let content = editor.text
    let expected = note.localRevision
    saving = true
    let task = Task { [self] in
      defer {
        saving = false
        saveTask = nil
      }
      do {
        let saved: LocalNote
        if requiresReview {
          saved = try await repository.saveForReview(
            path: note.path, content: content, expectedRevision: expected)
        } else {
          saved = try await repository.save(
            path: note.path, content: content, expectedRevision: expected)
        }
        guard saved.localRevision >= note.localRevision else { return }
        note = saved
        durableText = content
        durableRevision = sentRevision
        hasUncheckpointedEdits = revision != sentRevision
        error = nil
        onCheckpoint?()
      } catch WorkspaceRepositoryError.staleRevision {
        do {
          if let current = try await repository.note(note.path) { await adopt(current) }
        } catch { self.error = error.localizedDescription }
      } catch { self.error = error.localizedDescription }
    }
    saveTask = task
    await task.value
    if revision != durableRevision, error == nil { scheduleCheckpoint() }
  }

  /// Rebase uncheckpointed typing over a newer durable snapshot. Never replace the editor with a
  /// late save response, and never turn overlapping local edits into an automatic network write.
  func adopt(_ incoming: LocalNote) async {
    guard incoming.path == note.path, incoming.localRevision >= note.localRevision else { return }
    if editor.input.markedTextRange != nil {
      if incoming.localRevision >= (incomingAfterComposition?.localRevision ?? 0) {
        incomingAfterComposition = incoming
      }
      return
    }
    let mergingRevision = revision
    let merged = TextMerge.merge(base: durableText, local: editor.text, remote: incoming.content)
    note = incoming
    durableText = incoming.content
    editor.applyExternalText(merged.text)
    if merged.conflict {
      requiresReview = true
      do {
        note = try await repository.saveForReview(
          path: incoming.path, content: merged.text,
          expectedRevision: incoming.localRevision)
        requiresReview = false
        durableText = merged.text
        durableRevision = mergingRevision
        hasUncheckpointedEdits = revision != mergingRevision
      } catch {
        self.error = "Your text is still open. Review the incoming changes before syncing."
      }
    } else if merged.text == incoming.content {
      durableRevision = revision
      hasUncheckpointedEdits = false
    } else {
      changed()
    }
  }

  /// A clean row removed during a refresh has a new local revision sequence. The caller has
  /// durably retained the live text without an intent to recreate the deleted remote path.
  func adoptRecovery(_ recovery: LocalNote) {
    guard recovery.path == note.path, recovery.state == .recoveryDraft else { return }
    note = recovery
    durableText = recovery.content
    if editor.text == recovery.content {
      durableRevision = revision
      hasUncheckpointedEdits = false
    } else {
      scheduleCheckpoint()
    }
    error = nil
  }

  func finishComposition() { editor.input.unmarkText() }

  func setStructureLocked(_ locked: Bool) {
    var configuration = editor.configuration
    if locked {
      editableBeforeStructure = configuration.isEditable
      configuration.isEditable = false
    } else {
      configuration.isEditable = editableBeforeStructure ?? configuration.isEditable
      editableBeforeStructure = nil
    }
    editor.updateConfiguration(configuration)
  }

  /// Structural mutation already checkpointed and fenced this editor. Keep its undo/caret
  /// objects; only the durable repository path changes after the host's acknowledgement.
  func retarget(_ incoming: LocalNote) {
    note = incoming
    durableText = incoming.content
    if editor.text == incoming.content {
      durableRevision = revision
      hasUncheckpointedEdits = false
    }
  }

  /// The user explicitly chose a reviewed version with this editor locked and checkpointed.
  /// Ordinary incoming snapshots use `adopt` so they cannot overwrite live typing.
  func adoptReviewed(_ incoming: LocalNote) {
    guard incoming.path == note.path else { return }
    note = incoming
    durableText = incoming.content
    editor.applyExternalText(incoming.content)
    durableRevision = revision
    hasUncheckpointedEdits = false
    requiresReview = false
    incomingAfterComposition = nil
    error = nil
  }

  func setSourceMode(_ source: Bool) {
    var configuration = editor.configuration
    configuration.livePreview = !source
    editor.updateConfiguration(configuration)
  }
}
