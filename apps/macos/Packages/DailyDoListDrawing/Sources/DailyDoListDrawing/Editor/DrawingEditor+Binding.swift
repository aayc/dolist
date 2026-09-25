import Foundation

extension DrawingEditor {
  /// Binds (or, with nil, unbinds) one end of an arrow, keeping both sides' records in sync, and
  /// places the end on the shape's outline.
  func bindEnd(_ arrowId: String, end: ArrowBinding.ArrowEnd, to targetId: String?) {
    guard let arrow = element(arrowId), arrow.type == .arrow else { return }
    let old = end == .start ? arrow.startBinding : arrow.endBinding
    if let old, old.elementId != targetId {
      let other = end == .start ? arrow.endBinding : arrow.startBinding
      if other?.elementId != old.elementId {
        update(old.elementId) { target in
          target.boundElements = target.boundElements?.filter { $0.id != arrowId }
          if target.boundElements?.isEmpty == true { target.boundElements = nil }
        }
      }
      update(arrowId) { element in
        if end == .start { element.startBinding = nil } else { element.endBinding = nil }
      }
    }
    guard let targetId, let target = element(targetId), let arrow = element(arrowId) else { return }
    let binding = ArrowBinding.binding(for: arrow, end: end, to: target, zoom: zoom)
    update(arrowId) { element in
      if end == .start { element.startBinding = binding } else { element.endBinding = binding }
    }
    update(targetId) { target in
      var bound = target.boundElements ?? []
      if !bound.contains(where: { $0.id == arrowId }) {
        bound.append(BoundElement(id: arrowId, type: "arrow"))
      }
      target.boundElements = bound
    }
    placeBoundEnds(arrowId)
  }

  /// `updateBoundElements`: arrows bound to moved or resized shapes follow them.
  func updateArrowsBound(to changed: Set<String>, movedTogether: Set<String> = []) {
    var arrows = Set<String>()
    for id in changed {
      guard let element = element(id) else { continue }
      for bound in element.boundElements ?? [] where bound.type == "arrow" {
        arrows.insert(bound.id)
      }
    }
    for arrowId in arrows where !movedTogether.contains(arrowId) {
      placeBoundEnds(arrowId)
    }
  }

  /// Puts each bound end of an arrow back on its shape's outline (`updateBoundPoint`).
  func placeBoundEnds(_ arrowId: String) {
    for end in [ArrowBinding.ArrowEnd.start, .end] {
      guard let arrow = element(arrowId), !arrow.isDeleted, arrow.points.count >= 2 else { return }
      guard let binding = end == .start ? arrow.startBinding : arrow.endBinding,
        let target = element(binding.elementId), !target.isDeleted,
        let point = ArrowBinding.updatedEndPoint(arrow, end: end, binding: binding, target: target)
      else { continue }
      let index = end == .start ? 0 : arrow.points.count - 1
      let local = ElementGeometry.unrotate(point, in: arrow) - DrawingPoint(arrow.x, arrow.y)
      update(arrowId) { element in
        element.points[index] = local
        normalizePoints(&element)
      }
    }
    if let label = element(arrowId)?.boundTextId { positionArrowLabel(label) }
  }

  /// Dragging an arrow away from the shapes it's attached to (without them) detaches it.
  func unbindArrowsMovedAlone(_ moved: Set<String>) {
    for id in moved {
      guard let arrow = element(id), arrow.type == .arrow else { continue }
      if let start = arrow.startBinding, !moved.contains(start.elementId) {
        bindEnd(id, end: .start, to: nil)
      }
      if let end = arrow.endBinding, !moved.contains(end.elementId) {
        bindEnd(id, end: .end, to: nil)
      }
    }
  }

  /// Removes references to deleted elements: arrows bound to them, labels, `boundElements`.
  func detachReferences(to deleted: Set<String>) {
    for element in scene.elements where !element.isDeleted && !deleted.contains(element.id) {
      if element.type == .arrow {
        if let start = element.startBinding, deleted.contains(start.elementId) {
          update(element.id) { $0.startBinding = nil }
        }
        if let end = element.endBinding, deleted.contains(end.elementId) {
          update(element.id) { $0.endBinding = nil }
        }
      }
      if let bound = element.boundElements, bound.contains(where: { deleted.contains($0.id) }) {
        update(element.id) { target in
          let kept = bound.filter { !deleted.contains($0.id) }
          target.boundElements = kept.isEmpty ? nil : kept
        }
      }
    }
  }
}
