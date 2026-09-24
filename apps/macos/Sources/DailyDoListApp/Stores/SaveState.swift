import Foundation

/// Persistence state of one open note (status bar + tab dot).
enum SaveState: String, Sendable {
  case saved
  /// Edited locally, autosave pending.
  case dirty
  case saving
  /// The note changed elsewhere while we had local edits; resolving on the next save.
  case conflict
  /// The last save failed; retrying with backoff.
  case error

  var label: String {
    switch self {
    case .saved: "Saved"
    case .dirty: "Unsaved"
    case .saving: "Saving…"
    case .conflict: "Conflict"
    case .error: "Save failed"
    }
  }

  var hasUnsavedChanges: Bool { self != .saved }
}

/// Read-only view of one note's persistence state (tests, diagnostics).
struct NoteState: Equatable, Sendable {
  var path: String
  /// Local content if edited and not yet saved, else the server content.
  var content: String
  var version: String
  var dirty: Bool
  var saving: Bool
  var conflict: Bool
}

/// Callbacks from the notes store into the editor/workspace.
@MainActor
protocol NotesStoreDelegate: AnyObject {
  /// Current editor content of `path` (the active note or a cached editor snapshot), else nil.
  func notesStore(_ store: NotesStore, liveContentOf path: String) -> String?
  /// A newer server version arrived and there were no local edits: show it.
  func notesStore(_ store: NotesStore, applyRemote content: String, to path: String)
  /// Local edits and a newer server version merged cleanly into `content`: show it, moving only
  /// the other side's changes into the editor (the caret, selection and undo history stay).
  func notesStore(_ store: NotesStore, applyMerged content: String, to path: String)
  /// Local edits won a 409; the other version was saved as `copyPath`.
  func notesStore(_ store: NotesStore, didSaveConflictCopy copyPath: String, of path: String)
  /// The note was deleted elsewhere. `restored`: local edits were written back (note recreated).
  func notesStore(_ store: NotesStore, noteWasDeletedRemotely path: String, restored: Bool)
  func notesStore(_ store: NotesStore, didFailToSave path: String, error: Error)
  func notesStore(_ store: NotesStore, pathExists path: String) -> Bool
}

enum NotesStoreError: Error, LocalizedError {
  case conflictCopyFailed(String)

  var errorDescription: String? {
    switch self {
    case .conflictCopyFailed(let path): "Couldn't save a conflict copy of “\(path)”."
    }
  }
}
