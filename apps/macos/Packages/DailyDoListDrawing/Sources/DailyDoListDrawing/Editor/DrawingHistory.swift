import Foundation

/// Undo and redo as element diffs: each entry holds the changed elements before and after a
/// committed change (and the z-order when it changed), so a 2,000-element drawing doesn't keep
/// 100 copies of itself.
struct DrawingHistory {
  struct Entry {
    var before: [String: ExcalidrawElement?]
    var after: [String: ExcalidrawElement?]
    var orderBefore: [String]?
    var orderAfter: [String]?
    var selectionBefore: Set<String>
    var selectionAfter: Set<String>
  }

  static let limit = 200

  private(set) var undoStack: [Entry] = []
  private(set) var redoStack: [Entry] = []

  var canUndo: Bool { !undoStack.isEmpty }
  var canRedo: Bool { !redoStack.isEmpty }

  /// The diff between two versions of the elements; nil when nothing changed.
  static func diff(
    from old: [ExcalidrawElement], to new: [ExcalidrawElement], selectionBefore: Set<String>,
    selectionAfter: Set<String>
  ) -> Entry? {
    var oldById: [String: ExcalidrawElement] = [:]
    oldById.reserveCapacity(old.count)
    for element in old { oldById[element.id] = element }
    var before: [String: ExcalidrawElement?] = [:]
    var after: [String: ExcalidrawElement?] = [:]
    var seen = Set<String>()
    for element in new {
      seen.insert(element.id)
      if let previous = oldById[element.id] {
        if previous.version != element.version || previous.versionNonce != element.versionNonce
          || previous != element
        {
          before[element.id] = previous
          after[element.id] = element
        }
      } else {
        before[element.id] = .some(nil)
        after[element.id] = element
      }
    }
    for element in old where !seen.contains(element.id) {
      before[element.id] = element
      after[element.id] = .some(nil)
    }
    let oldOrder = old.map(\.id)
    let newOrder = new.map(\.id)
    let orderChanged = oldOrder != newOrder
    guard !before.isEmpty || orderChanged else { return nil }
    return Entry(
      before: before, after: after, orderBefore: orderChanged ? oldOrder : nil,
      orderAfter: orderChanged ? newOrder : nil, selectionBefore: selectionBefore,
      selectionAfter: selectionAfter)
  }

  mutating func record(_ entry: Entry) {
    undoStack.append(entry)
    if undoStack.count > Self.limit { undoStack.removeFirst() }
    redoStack.removeAll()
  }

  mutating func popUndo() -> Entry? {
    guard let entry = undoStack.popLast() else { return nil }
    redoStack.append(entry)
    return entry
  }

  mutating func popRedo() -> Entry? {
    guard let entry = redoStack.popLast() else { return nil }
    undoStack.append(entry)
    return entry
  }

  mutating func clear() {
    undoStack.removeAll()
    redoStack.removeAll()
  }

  /// Applies one side of an entry to the current elements. Restored elements get a new version
  /// (like Excalidraw's undo), so a merge prefers them over what they replace.
  static func apply(
    _ values: [String: ExcalidrawElement?], order: [String]?, to elements: [ExcalidrawElement],
    environment: DrawingEnvironment
  ) -> [ExcalidrawElement] {
    var byId: [String: ExcalidrawElement] = [:]
    for element in elements { byId[element.id] = element }
    for (id, value) in values {
      if var restored = value {
        let current = byId[id]
        restored.version = max(restored.version, current?.version ?? 0)
        restored.bumpVersion(in: environment)
        byId[id] = restored
      } else if var existing = byId[id], !existing.isDeleted {
        // Undoing a creation leaves a tombstone, as Excalidraw does, for merges.
        existing.isDeleted = true
        existing.bumpVersion(in: environment)
        byId[id] = existing
      }
    }
    let present = Set(elements.map(\.id))
    let ids = order ?? (elements.map(\.id) + values.keys.filter { !present.contains($0) }.sorted())
    var seen = Set<String>()
    var result: [ExcalidrawElement] = []
    for id in ids where seen.insert(id).inserted {
      if let element = byId[id] { result.append(element) }
    }
    for element in elements where !seen.contains(element.id) {
      if let element = byId[element.id] { result.append(element) }
    }
    return result
  }
}
