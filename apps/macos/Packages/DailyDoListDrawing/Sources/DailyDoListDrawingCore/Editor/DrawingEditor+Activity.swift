import Foundation

extension DrawingEditor {
  /// Elements that change while the pointer moves (being drawn, dragged, resized, typed into or
  /// erased): the canvas draws them live and everything else from its cached layer.
  public var activeElementIds: Set<String> {
    var ids = Set<String>()
    switch gesture {
    case .move(_, let originals, _, _), .resize(_, _, let originals):
      ids = Set(originals.keys)
    case .movePoint(let id, _), .create(let id, _), .linear(let id, _, _), .freedraw(let id):
      ids = [id]
    case .erase, .marquee, nil:
      break
    }
    if let id = multiPointElementId { ids.insert(id) }
    if let id = editingTextId {
      ids.insert(id)
      if let container = element(id)?.containerId { ids.insert(container) }
    }
    ids.formUnion(erasingIds)
    guard !ids.isEmpty else { return ids }
    // Arrows bound to moving shapes, and labels, move with them.
    for id in ids {
      guard let element = element(id) else { continue }
      for bound in element.boundElements ?? [] { ids.insert(bound.id) }
      if let start = element.startBinding?.elementId { ids.insert(start) }
      if let end = element.endBinding?.elementId { ids.insert(end) }
    }
    return ids
  }
}
