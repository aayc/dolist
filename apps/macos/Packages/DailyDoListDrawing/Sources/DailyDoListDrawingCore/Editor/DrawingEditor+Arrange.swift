import Foundation

public enum DrawingLayer: String, CaseIterable, Sendable {
  case back, backward, forward, front
}
public enum DrawingAlignment: String, CaseIterable, Sendable {
  case left, horizontalCenter, right, top, verticalCenter, bottom
}

extension DrawingEditor {
  public func groupSelection() {
    finishInteraction()
    let ids = editableSelection
    guard ids.count > 1 else { return }
    let group = environment.randomId()
    for id in withDependents(ids) { update(id) { $0.groupIds.append(group) } }
    select(ids)
    commit()
  }

  public func ungroupSelection() {
    finishInteraction()
    let groups = Set(selectedElements.filter { !$0.locked }.compactMap { $0.groupIds.last })
    guard !groups.isEmpty else { return }
    for element in scene.elements where !element.isDeleted && !element.locked {
      if element.groupIds.contains(where: { groups.contains($0) }) {
        update(element.id) { $0.groupIds.removeAll { groups.contains($0) } }
      }
    }
    commit()
  }

  public func lockSelection() {
    finishInteraction()
    for id in withDependents(editableSelection) { update(id) { $0.locked = true } }
    selectedIds = []
    commit()
  }

  public func unlockAll() {
    finishInteraction()
    for element in scene.elements where !element.isDeleted && element.locked {
      update(element.id) { $0.locked = false }
    }
    commit()
  }

  public func moveSelection(to layer: DrawingLayer) {
    finishInteraction()
    let ids = withDependents(editableSelection)
    guard !ids.isEmpty else { return }
    var order = scene.elements.map(\.id)
    switch layer {
    case .front: order = order.filter { !ids.contains($0) } + order.filter { ids.contains($0) }
    case .back: order = order.filter { ids.contains($0) } + order.filter { !ids.contains($0) }
    case .forward:
      if order.count > 1 {
        for index in stride(from: order.count - 2, through: 0, by: -1)
        where ids.contains(order[index]) && !ids.contains(order[index + 1]) {
          order.swapAt(index, index + 1)
        }
      }
    case .backward:
      if order.count > 1 {
        for index in 1..<order.count
        where ids.contains(order[index]) && !ids.contains(order[index - 1]) {
          order.swapAt(index, index - 1)
        }
      }
    }
    guard order != scene.elements.map(\.id) else { return }
    let byId = Dictionary(uniqueKeysWithValues: scene.elements.map { ($0.id, $0) })
    scene.elements = order.compactMap { byId[$0] }
    rebuildIndex()
    var previous: String?
    for id in order {
      let key = FractionalIndex.key(between: previous, and: nil)
      update(id) { $0.index = key }
      previous = key
    }
    commit()
  }

  public func rotateSelection(by radians: Double) {
    finishInteraction()
    guard radians.isFinite else { return }
    let ids = withDependents(editableSelection)
    let elements = ids.compactMap { element($0) }
    guard !elements.contains(where: { $0.type.isFrameLike }),
      let bounds = ElementGeometry.bounds(of: elements)
    else { return }
    for original in elements {
      let center = ElementGeometry.center(original)
      let next = center.rotated(around: bounds.center, by: radians)
      update(original.id) { value in
        value.x += next.x - center.x
        value.y += next.y - center.y
        value.angle = (value.angle + radians).truncatingRemainder(dividingBy: 2 * .pi)
      }
    }
    updateArrowsBound(to: ids, movedTogether: ids)
    commit()
  }

  public func alignSelection(_ alignment: DrawingAlignment) {
    finishInteraction()
    let units = arrangementUnits
    guard units.count > 1, let bounds = ElementGeometry.bounds(of: units.flatMap { $0.elements })
    else { return }
    for unit in units {
      let box = unit.bounds
      let delta: DrawingPoint
      switch alignment {
      case .left: delta = DrawingPoint(bounds.minX - box.minX, 0)
      case .horizontalCenter: delta = DrawingPoint(bounds.center.x - box.center.x, 0)
      case .right: delta = DrawingPoint(bounds.maxX - box.maxX, 0)
      case .top: delta = DrawingPoint(0, bounds.minY - box.minY)
      case .verticalCenter: delta = DrawingPoint(0, bounds.center.y - box.center.y)
      case .bottom: delta = DrawingPoint(0, bounds.maxY - box.maxY)
      }
      translate(unit.ids, by: delta)
    }
    commit()
  }

  public func distributeSelection(horizontally: Bool) {
    finishInteraction()
    let units = arrangementUnits.sorted {
      horizontally
        ? $0.bounds.center.x < $1.bounds.center.x : $0.bounds.center.y < $1.bounds.center.y
    }
    guard units.count > 2, let first = units.first, let last = units.last else { return }
    let start = horizontally ? first.bounds.minX : first.bounds.minY
    let end = horizontally ? last.bounds.maxX : last.bounds.maxY
    let total = units.reduce(0) { $0 + (horizontally ? $1.bounds.width : $1.bounds.height) }
    let gap = (end - start - total) / Double(units.count - 1)
    var position = start
    for unit in units {
      let delta = position - (horizontally ? unit.bounds.minX : unit.bounds.minY)
      translate(unit.ids, by: horizontally ? DrawingPoint(delta, 0) : DrawingPoint(0, delta))
      position += (horizontally ? unit.bounds.width : unit.bounds.height) + gap
    }
    commit()
  }

  public func flipSelection(horizontally: Bool) {
    finishInteraction()
    let ids = withDependents(editableSelection)
    let elements = ids.compactMap { element($0) }
    guard let bounds = ElementGeometry.bounds(of: elements) else { return }
    for original in elements where !original.type.isFrameLike {
      let center = ElementGeometry.center(original)
      let target = DrawingPoint(
        horizontally ? 2 * bounds.center.x - center.x : center.x,
        horizontally ? center.y : 2 * bounds.center.y - center.y)
      update(original.id) { value in
        value.x += target.x - center.x
        value.y += target.y - center.y
        value.angle = -value.angle
        if value.type == .image {
          let old = value.extraField("scale")?.arrayValue ?? [.number(1), .number(1)]
          let x = old.first?.numberValue ?? 1
          let y = old.last?.numberValue ?? 1
          value.setExtraField(
            "scale", .array([.number(horizontally ? -x : x), .number(horizontally ? y : -y)]))
        } else if value.type.hasPoints {
          let box = ElementGeometry.unrotatedBounds(value)
          let localCenter = box.center - DrawingPoint(value.x, value.y)
          value.points = value.points.map { point in
            DrawingPoint(
              horizontally ? 2 * localCenter.x - point.x : point.x,
              horizontally ? point.y : 2 * localCenter.y - point.y)
          }
          normalizePoints(&value)
        }
      }
    }
    updateArrowsBound(to: ids, movedTogether: ids)
    commit()
  }

  var editableSelection: Set<String> {
    Set(selectedElements.filter { !$0.locked }.map(\.id))
  }

  private struct ArrangementUnit {
    var ids: Set<String>
    var elements: [ExcalidrawElement]
    var bounds: DrawingRect
  }

  private var arrangementUnits: [ArrangementUnit] {
    var seen = Set<String>()
    var result: [ArrangementUnit] = []
    for element in selectedElements
    where !element.locked && element.containerId == nil && !seen.contains(element.id) {
      let ids = withDependents(expandToGroups([element.id])).intersection(
        withDependents(editableSelection))
      let elements = ids.compactMap { self.element($0) }
      guard let bounds = ElementGeometry.bounds(of: elements) else { continue }
      seen.formUnion(ids)
      result.append(ArrangementUnit(ids: ids, elements: elements, bounds: bounds))
    }
    return result
  }

  func translate(_ ids: Set<String>, by delta: DrawingPoint) {
    for id in ids {
      update(id) {
        $0.x += delta.x
        $0.y += delta.y
      }
    }
    updateArrowsBound(to: ids, movedTogether: ids)
  }
}
