import Foundation

public enum DrawingArrowShape: String, CaseIterable, Sendable { case sharp, round, elbow }

extension DrawingEditor {
  /// Grid and object snapping affect construction and movement, never freehand samples.
  func snapped(_ point: DrawingPoint) -> DrawingPoint {
    guard gridEnabled, gridSize.isFinite, gridSize >= 1 else { return point }
    return DrawingPoint(
      (point.x / gridSize).rounded() * gridSize, (point.y / gridSize).rounded() * gridSize)
  }

  /// Aligns construction handles with visible object bounds. Rotated resize frames use grid
  /// snapping only; their local axes do not coincide with scene-aligned object edges.
  func snappedPointer(_ point: DrawingPoint, excluding ids: Set<String> = []) -> DrawingPoint {
    var result = snapped(point)
    guard objectsSnapEnabled else { return result }
    var dx: Double?
    var dy: Double?
    for element in scene.visibleElements where !ids.contains(element.id) {
      let box = ElementGeometry.bounds(element)
      for x in [box.minX, box.center.x, box.maxX] where abs(x - result.x) <= 6 / zoom {
        if dx == nil || abs(x - result.x) < abs(dx!) { dx = x - result.x }
      }
      for y in [box.minY, box.center.y, box.maxY] where abs(y - result.y) <= 6 / zoom {
        if dy == nil || abs(y - result.y) < abs(dy!) { dy = y - result.y }
      }
    }
    result.x += dx ?? 0
    result.y += dy ?? 0
    return result
  }

  func snappedMovement(_ delta: DrawingPoint, originals: [String: ExcalidrawElement])
    -> DrawingPoint
  {
    guard let box = ElementGeometry.bounds(of: Array(originals.values)) else { return delta }
    var next = delta
    if gridEnabled {
      let target = snapped(DrawingPoint(box.minX + delta.x, box.minY + delta.y))
      next = target - DrawingPoint(box.minX, box.minY)
    }
    if objectsSnapEnabled {
      let x = [box.minX, box.center.x, box.maxX].map { $0 + next.x }
      let y = [box.minY, box.center.y, box.maxY].map { $0 + next.y }
      var dx: Double?
      var dy: Double?
      for other in scene.elements where !other.isDeleted && originals[other.id] == nil {
        let bounds = ElementGeometry.bounds(other)
        for target in [bounds.minX, bounds.center.x, bounds.maxX] {
          for value in x where abs(target - value) <= 6 / zoom {
            if dx == nil || abs(target - value) < abs(dx!) { dx = target - value }
          }
        }
        for target in [bounds.minY, bounds.center.y, bounds.maxY] {
          for value in y where abs(target - value) <= 6 / zoom {
            if dy == nil || abs(target - value) < abs(dy!) { dy = target - value }
          }
        }
      }
      next.x += dx ?? 0
      next.y += dy ?? 0
    }
    return next
  }

  public var rotationHandle: DrawingPoint? {
    guard rotationHandleEnabled, let frame = selectionFrame, frame.pointHandles.isEmpty,
      !selectedElements.contains(where: { $0.type.isFrameLike || $0.locked })
    else { return nil }
    return DrawingPoint(frame.center.x, frame.rect.minY - 32 / zoom)
      .rotated(around: frame.center, by: frame.angle)
  }

  public func beginLinearEditing(_ id: String) {
    guard let value = element(id), value.type.isLinear, !value.isDeleted, !value.locked else {
      return
    }
    finishInteraction()
    select([id])
    editingLinearId = id
    selectedPointIndex = 0
    invalidate()
  }
  public func endLinearEditing() {
    editingLinearId = nil
    selectedPointIndex = nil
    invalidate()
  }
  public func selectLinearPoint(_ index: Int) {
    guard let id = editingLinearId, let value = element(id), value.points.indices.contains(index)
    else { return }
    selectedPointIndex = index
    invalidate()
  }
  public var linearMidpoints: [DrawingPoint] {
    guard let id = editingLinearId, let value = element(id), value.points.count > 1 else {
      return []
    }
    return value.points.indices.dropLast().map {
      let a = ArrowBinding.absolutePoint(value, $0)
      let b = ArrowBinding.absolutePoint(value, $0 + 1)
      return (a + b) * 0.5
    }
  }
  public func insertLinearPoint(_ id: String, after index: Int, at point: DrawingPoint? = nil) {
    insertLinearPoint(id, after: index, at: point, commitChange: true)
  }
  func insertLinearPoint(
    _ id: String, after index: Int, at point: DrawingPoint?, commitChange: Bool
  ) {
    guard let value = element(id), value.type.isLinear, !value.locked, !value.isDeleted,
      index >= 0, index < value.points.count - 1
    else { return }
    let target =
      point.map { ElementGeometry.unrotate($0, in: value) - DrawingPoint(value.x, value.y) }
      ?? (value.points[index] + value.points[index + 1]) * 0.5
    update(id) {
      $0.points.insert(target, at: index + 1)
      normalizePoints(&$0)
    }
    selectedPointIndex = index + 1
    if let label = value.boundTextId { positionArrowLabel(label) }
    if commitChange { commit() } else { invalidate() }
  }
  public func moveLinearPoint(_ id: String, index: Int, to point: DrawingPoint) {
    guard let value = element(id), value.type.isLinear, !value.locked, !value.isDeleted,
      value.points.indices.contains(index), point.x.isFinite, point.y.isFinite
    else { return }
    movePointToPointer(id, index: index, point, modifiers: [])
    finishPointMove(id, index: index)
    selectedPointIndex = index
    commit()
  }
  public func deleteLinearPoint(_ id: String, index: Int) {
    guard let value = element(id), value.type.isLinear, !value.locked, !value.isDeleted,
      value.points.count > 2, value.points.indices.contains(index)
    else { return }
    if index == 0 { bindEnd(id, end: .start, to: nil) }
    if index == value.points.count - 1 { bindEnd(id, end: .end, to: nil) }
    update(id) {
      $0.points.remove(at: index)
      if $0.elbowed { orthogonalize(&$0) }
      normalizePoints(&$0)
    }
    selectedPointIndex = min(index, (element(id)?.points.count ?? 1) - 1)
    if let label = value.boundTextId { positionArrowLabel(label) }
    commit()
  }

  public func setArrowShape(_ shape: DrawingArrowShape) {
    arrowShape = shape
    style.roundEdges = shape == .round
    for id in selectedIds {
      guard let value = element(id), value.type == .arrow, !value.locked else { continue }
      update(id) { arrow in
        if shape == .elbow {
          let absolute = arrow.points.indices.map { ArrowBinding.absolutePoint(arrow, $0) }
          if let first = absolute.first {
            arrow.x = first.x
            arrow.y = first.y
            arrow.angle = 0
            arrow.points = absolute.map { $0 - first }
          }
        }
        arrow.elbowed = shape == .elbow
        arrow.roundness = shape == .round ? .proportional : nil
        if arrow.elbowed { orthogonalize(&arrow) }
        normalizePoints(&arrow)
      }
      if let label = value.boundTextId { positionArrowLabel(label) }
    }
    commit()
  }

  /// Orthogonal routes retain edited interior bends. Two endpoints receive a centered dogleg;
  /// dragging a bend updates its adjacent runs so no diagonal segment can be written.
  func orthogonalize(_ arrow: inout ExcalidrawElement, movedPoint: Int? = nil) {
    guard arrow.elbowed, arrow.points.count >= 2 else { return }
    var points = arrow.points
    if points.count == 2 {
      let a = points[0]
      let b = points[1]
      if a.x != b.x && a.y != b.y {
        let middle = (a.x + b.x) / 2
        points = [a, DrawingPoint(middle, a.y), DrawingPoint(middle, b.y), b]
      }
    } else if movedPoint == 0 {
      if points[1].x == points[2].x { points[1].y = points[0].y } else { points[1].x = points[0].x }
    } else if movedPoint == points.count - 1 {
      let last = points.count - 1
      if points[last - 1].x == points[last - 2].x {
        points[last - 1].y = points[last].y
      } else {
        points[last - 1].x = points[last].x
      }
    } else if let index = movedPoint, index > 0, index < points.count - 1 {
      let previousHorizontal =
        abs(points[index - 1].x - points[index].x) >= abs(points[index - 1].y - points[index].y)
      if previousHorizontal {
        points[index - 1].y = points[index].y
        points[index + 1].x = points[index].x
      } else {
        points[index - 1].x = points[index].x
        points[index + 1].y = points[index].y
      }
    }
    if movedPoint == nil, points.count > 2 {
      if points[1].x == points[2].x { points[1].y = points[0].y } else { points[1].x = points[0].x }
      let last = points.count - 1
      if points[last - 1].x == points[last - 2].x {
        points[last - 1].y = points[last].y
      } else {
        points[last - 1].x = points[last].x
      }
    }
    var route = [points[0]]
    for point in points.dropFirst() {
      let previous = route.last!
      if point.x != previous.x && point.y != previous.y {
        route.append(DrawingPoint(point.x, previous.y))
      }
      route.append(point)
    }
    arrow.points = route
    arrow.setExtraField("fixedSegments", .array([]))
  }
}
