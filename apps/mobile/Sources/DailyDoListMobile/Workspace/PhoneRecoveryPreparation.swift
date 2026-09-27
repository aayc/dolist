import DailyDoListDrawingModel
import Foundation

extension PhoneWorkspace {
  /// The connection owner invokes this again after stopping actions and before local retirement.
  /// Snapshot files cannot protect text that never made it out of a live editor.
  func prepareRecoveryExport() async throws {
    await checkpointAll(finishComposition: true)
    try await composerDrafts.flushChecked()
    try PhoneRecoveryPreparation.validate(
      notes: Array(sessions.values), drawings: Array(drawingSessions.values))
  }
}

@MainActor enum PhoneRecoveryPreparation {
  static func validate(notes: [NoteSession], drawings: [DrawingSession]) throws {
    for session in notes {
      guard !session.hasUncheckpointedEdits, !session.saving,
        session.editor.input.markedTextRange == nil,
        session.editor.text.utf8.elementsEqual(session.note.content.utf8)
      else { throw PhoneRecoveryPreparationError.unsavedNote(session.note.path) }
    }
    for session in drawings {
      guard !session.hasUncheckpointedEdits, !session.saving,
        !session.controller.hasActiveInteraction,
        SceneCodec.encode(session.controller.scene)
          == SceneCodec.encode(session.drawing.document.scene)
      else { throw PhoneRecoveryPreparationError.unsavedDrawing(session.drawing.path) }
    }
  }
}

enum PhoneRecoveryPreparationError: Error, Equatable, LocalizedError {
  case unsavedNote(String)
  case unsavedDrawing(String)
  case unsavedReplies

  var errorDescription: String? {
    switch self {
    case .unsavedNote(let path):
      "Keep this connection. Changes in \(path) are still only in the editor; resolve its save error before exporting or forgetting."
    case .unsavedDrawing(let path):
      "Keep this connection. Changes in \(path) are still only in the drawing editor; resolve its save error before exporting or forgetting."
    case .unsavedReplies:
      "Keep this connection. A reply could not be saved on this iPhone, or changed while preparing the export. Preserve its text and retry."
    }
  }
}
