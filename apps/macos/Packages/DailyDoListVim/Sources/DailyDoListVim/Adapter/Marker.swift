// Ported from class `Marker` of @replit/codemirror-vim 6.4.0 (MIT, © Marijn Haverbeke and others).

/// A bookmark: a document offset that follows edits (and dies when the text around it is
/// deleted), used by vim for marks, the jump list and insert tracking.
///
/// The global jump list outlives the editors it points into. A bookmark of an editor that was
/// released (vim detached from it) finds nothing, so `<C-o>` never lands on an offset of another
/// document; vim.js's editors are never freed, so there it can't come up.
@MainActor
final class Marker {
  private weak var cm: EditorAdapter?
  let id: Int
  private(set) var offset: Int?
  /// 1 when the bookmark moves with text inserted at its position ("insertLeft").
  let assoc: Int

  init(_ cm: EditorAdapter, offset: Int, assoc: Int) {
    self.cm = cm
    self.id = cm.nextMarkID()
    self.offset = offset
    self.assoc = assoc
    cm.register(self)
  }

  /// Stops tracking edits (`find` keeps returning the last position).
  func clear() {
    cm?.unregister(self)
  }

  func find() -> Pos? {
    guard let cm, cm.vim != nil, let offset else { return nil }
    return cm.posFromIndex(offset)
  }

  func update(_ change: ChangeSet) {
    if let current = offset { offset = change.mapPos(current, assoc: assoc, mode: .trackDel) }
  }
}

/// A weak reference to a bookmark: vim never releases bookmarks it no longer uses (CodeMirror
/// keeps them in a table forever); unreachable ones are dropped here instead.
struct WeakMarker {
  weak var marker: Marker?
}
