import Foundation

extension DrawingEditor {
  /// A pointer gesture in progress.
  enum Gesture {
    case marquee(start: DrawingPoint, additive: Bool, initial: Set<String>)
    case move(
      start: DrawingPoint, originals: [String: ExcalidrawElement], duplicate: Bool, moved: Bool)
    case resize(
      handle: TransformHandle, frame: SelectionFrame, originals: [String: ExcalidrawElement])
    case movePoint(id: String, index: Int)
    case create(id: String, origin: DrawingPoint)
    case linear(id: String, origin: DrawingPoint, startTarget: String?)
    case freedraw(id: String)
    case erase(last: DrawingPoint)
  }

  /// The selection's box and handles at the current zoom.
  public var selectionFrame: SelectionFrame? {
    guard editingTextId == nil, multiPointElementId == nil else { return nil }
    if case .create = gesture { return nil }
    if case .freedraw = gesture { return nil }
    let elements = selectedElements.filter {
      $0.containerId == nil || element($0.containerId!) == nil
    }
    return SelectionFrame.make(for: elements, zoom: zoom)
  }

  /// Handles are grabbed within this many scene units.
  var handleRadius: Double { 8 / zoom }

  /// Where the pointer is, for hover feedback and the cursor.
  public enum HoverTarget: Equatable, Sendable {
    case none
    case element(String)
    case handle(TransformHandle, angle: Double)
    case point(Int)
  }

  public func hoverTarget(at point: DrawingPoint) -> HoverTarget {
    guard tool == .selection else { return .none }
    if let frame = selectionFrame {
      if let index = frame.pointHandle(at: point, radius: handleRadius) { return .point(index) }
      if let handle = frame.handle(at: point, radius: handleRadius) {
        return .handle(handle, angle: frame.angle)
      }
    }
    if let hit = HitTest.topElement(
      at: point, in: scene.elements, byId: elementsById, threshold: threshold)
    {
      return .element(hit.id)
    }
    return .none
  }

  // MARK: Pointer events

  public func pointerMoved(to point: DrawingPoint, modifiers: PointerModifiers = []) {
    if let id = multiPointElementId {
      movePointToPointer(id, index: nil, point, modifiers: modifiers)
      bindingHighlightId = arrowTarget(at: point, excluding: [id], for: id)
      invalidate()
      return
    }
    var newHover: String?
    if tool == .selection, case .element(let id) = hoverTarget(at: point), !selectedIds.contains(id)
    {
      newHover = id
    }
    if newHover != hoveredId {
      hoveredId = newHover
      invalidate()
    }
  }

  public func pointerExited() {
    if hoveredId != nil {
      hoveredId = nil
      invalidate()
    }
  }

  public func pointerDown(
    at point: DrawingPoint, modifiers: PointerModifiers = [], clickCount: Int = 1
  ) {
    if editingTextId != nil { endTextEditing() }
    hoveredId = nil
    if let id = multiPointElementId {
      multiPointClick(id, at: point, clickCount: clickCount)
      return
    }
    switch tool {
    case .selection: selectionDown(at: point, modifiers: modifiers, clickCount: clickCount)
    case .rectangle, .ellipse, .diamond:
      guard let type = tool.elementType else { return }
      let element = newElement(type, at: point)
      insert(element)
      gesture = .create(id: element.id, origin: point)
      invalidate()
    case .arrow, .line:
      guard let type = tool.elementType else { return }
      var element = newElement(type, at: point)
      element.points = [.zero, .zero]
      insert(element)
      let target = type == .arrow ? arrowTarget(at: point, excluding: [element.id], for: nil) : nil
      gesture = .linear(id: element.id, origin: point, startTarget: target)
      bindingHighlightId = target
      invalidate()
    case .freedraw:
      var element = newElement(.freedraw, at: point)
      element.points = [.zero]
      element.simulatePressure = true
      insert(element)
      gesture = .freedraw(id: element.id)
      invalidate()
    case .text:
      createText(at: point)
    case .eraser:
      erasingIds = []
      erase(from: point, to: point)
      gesture = .erase(last: point)
      invalidate()
    case .hand:
      break
    }
  }

  public func pointerDragged(to point: DrawingPoint, modifiers: PointerModifiers = []) {
    guard let gesture else { return }
    switch gesture {
    case .marquee(let start, let additive, let initial):
      let rect = DrawingRect(
        minX: min(start.x, point.x), minY: min(start.y, point.y), maxX: max(start.x, point.x),
        maxY: max(start.y, point.y))
      marquee = rect
      let inside = scene.elements.filter { element in
        !element.isDeleted && !element.locked && element.containerId == nil
          && rect.contains(ElementGeometry.bounds(element))
      }.map(\.id)
      let ids = Set(inside)
      select(additive ? initial.union(ids) : ids)
      invalidate()
    case .move(let start, let originals, let duplicate, let moved):
      var originals = originals
      if duplicate && !moved && !originals.isEmpty {
        originals = duplicateForDrag(originals)
      }
      moveSelection(originals: originals, by: point - start, snapAxis: modifiers.contains(.shift))
      self.gesture = .move(start: start, originals: originals, duplicate: false, moved: true)
      invalidate()
    case .resize(let handle, let frame, let originals):
      resize(handle: handle, frame: frame, originals: originals, to: point, modifiers: modifiers)
      invalidate()
    case .movePoint(let id, let index):
      movePointToPointer(id, index: index, point, modifiers: modifiers)
      if element(id)?.type == .arrow, index == 0 || index == (element(id)?.points.count ?? 0) - 1 {
        bindingHighlightId = arrowTarget(at: point, excluding: [id], for: id)
      }
      invalidate()
    case .create(let id, let origin):
      resizeNewElement(id, origin: origin, to: point, modifiers: modifiers)
      invalidate()
    case .linear(let id, _, _):
      movePointToPointer(id, index: 1, point, modifiers: modifiers)
      bindingHighlightId = arrowTarget(at: point, excluding: [id], for: id)
      invalidate()
    case .freedraw(let id):
      appendFreedrawPoint(id, point)
      invalidate()
    case .erase(let last):
      erase(from: last, to: point)
      self.gesture = .erase(last: point)
      invalidate()
    }
  }

  public func pointerUp(at point: DrawingPoint, modifiers: PointerModifiers = []) {
    guard let gesture else { return }
    self.gesture = nil
    marquee = nil
    switch gesture {
    case .marquee:
      commit()
    case .move(_, let originals, _, let moved):
      if moved {
        unbindArrowsMovedAlone(Set(originals.keys))
        commit()
      } else {
        commit()
      }
    case .resize:
      commit()
    case .movePoint(let id, let index):
      finishPointMove(id, index: index)
      commit()
    case .create(let id, _):
      finishCreation(id)
    case .linear(let id, let origin, let startTarget):
      let dragged =
        element(id).map { $0.points.count > 1 && hypot($0.points[1].x, $0.points[1].y) * zoom > 4 }
        ?? false
      _ = origin
      if dragged {
        finishLinear(id, startTarget: startTarget)
      } else {
        // A click: keep drawing point by point.
        multiPointElementId = id
        multiPointStartTarget = startTarget
        invalidate()
      }
    case .freedraw(let id):
      update(id) { $0.lastCommittedPoint = $0.points.last }
      select([id])
      commit()
    case .erase:
      let ids = erasingIds
      erasingIds = []
      if !ids.isEmpty { delete(ids) }
      commit()
    }
  }

  func cancelGesture() {
    gesture = nil
    marquee = nil
    bindingHighlightId = nil
    erasingIds = []
  }

  // MARK: Selection tool

  private func selectionDown(at point: DrawingPoint, modifiers: PointerModifiers, clickCount: Int) {
    if clickCount >= 2 {
      doubleClick(at: point)
      return
    }
    if let frame = selectionFrame {
      if let index = frame.pointHandle(at: point, radius: handleRadius), let id = selectedIds.first
      {
        gesture = .movePoint(id: id, index: index)
        return
      }
      if let handle = frame.handle(at: point, radius: handleRadius) {
        let ids = withDependents(selectedIds)
        let originals = Dictionary(
          uniqueKeysWithValues: ids.compactMap { id in element(id).map { (id, $0) } })
        gesture = .resize(handle: handle, frame: frame, originals: originals)
        return
      }
    }
    let hit = HitTest.topElement(
      at: point, in: scene.elements, byId: elementsById, threshold: threshold)
    if let hit {
      if modifiers.contains(.shift) {
        var ids = selectedIds
        let group = expandToGroups([hit.id])
        if ids.isSuperset(of: group) { ids.subtract(group) } else { ids.formUnion(group) }
        select(ids)
      } else if !selectedIds.contains(hit.id) {
        select([hit.id])
      }
      let ids = withDependents(selectedIds)
      let originals = Dictionary(
        uniqueKeysWithValues: ids.compactMap { id in element(id).map { (id, $0) } })
      gesture = .move(
        start: point, originals: originals, duplicate: modifiers.contains(.option), moved: false)
    } else if let frame = selectionFrame,
      frame.rect.contains(ElementGeometry.unrotateBox(point, frame)),
      selectedIds.count > 1, !modifiers.contains(.shift)
    {
      // Inside the box of a multiple selection: drag it all.
      let ids = withDependents(selectedIds)
      let originals = Dictionary(
        uniqueKeysWithValues: ids.compactMap { id in element(id).map { (id, $0) } })
      gesture = .move(
        start: point, originals: originals, duplicate: modifiers.contains(.option), moved: false)
    } else {
      let initial = modifiers.contains(.shift) ? selectedIds : []
      if !modifiers.contains(.shift) { select([]) }
      gesture = .marquee(start: point, additive: modifiers.contains(.shift), initial: initial)
    }
    invalidate()
  }

  private func doubleClick(at point: DrawingPoint) {
    let byId = elementsById
    if let hit = HitTest.topElement(at: point, in: scene.elements, byId: byId, threshold: threshold)
    {
      if hit.type == .text {
        select([hit.id])
        beginTextEditing(hit.id)
        return
      }
      if hit.type.isTextContainer {
        editLabel(of: hit.id)
        return
      }
    }
    createText(at: point)
  }

  // MARK: Moving

  func moveSelection(originals: [String: ExcalidrawElement], by delta: DrawingPoint, snapAxis: Bool)
  {
    var delta = delta
    if snapAxis { if abs(delta.x) > abs(delta.y) { delta.y = 0 } else { delta.x = 0 } }
    for (id, original) in originals {
      update(id) { element in
        element.x = original.x + delta.x
        element.y = original.y + delta.y
      }
    }
    updateArrowsBound(to: Set(originals.keys), movedTogether: Set(originals.keys))
  }

  /// Option-drag: duplicates stay where the originals were picked up, and move.
  func duplicateForDrag(_ originals: [String: ExcalidrawElement]) -> [String: ExcalidrawElement] {
    let copies = duplicate(Set(originals.keys), offset: .zero)
    var result: [String: ExcalidrawElement] = [:]
    for id in withDependents(copies) { if let element = element(id) { result[id] = element } }
    return result
  }

  // MARK: Points of lines and arrows

  /// Moves point `index` (nil: the last) of a line to the pointer, 15° steps with shift.
  func movePointToPointer(
    _ id: String, index: Int?, _ point: DrawingPoint, modifiers: PointerModifiers
  ) {
    guard let current = element(id), !current.points.isEmpty else { return }
    let index = index ?? current.points.count - 1
    var target = ElementGeometry.unrotate(point, in: current) - DrawingPoint(current.x, current.y)
    if modifiers.contains(.shift), current.points.count > 1 {
      let anchor = current.points[index == 0 ? 1 : index - 1]
      let delta = target - anchor
      let length = hypot(delta.x, delta.y)
      let step = Double.pi / 12
      let angle = (atan2(delta.y, delta.x) / step).rounded() * step
      target = anchor + DrawingPoint(cos(angle) * length, sin(angle) * length)
    }
    update(id) { element in
      element.points[index] = target
      normalizePoints(&element)
    }
    if let label = element(id)?.boundTextId { positionArrowLabel(label) }
  }

  func finishPointMove(_ id: String, index: Int) {
    bindingHighlightId = nil
    guard let arrow = element(id), arrow.type == .arrow else { return }
    let isStart = index == 0
    let isEnd = index == arrow.points.count - 1
    guard isStart || isEnd else { return }
    let point = ArrowBinding.absolutePoint(arrow, index)
    let target = arrowTarget(at: point, excluding: [id], for: id)
    bindEnd(id, end: isStart ? .start : .end, to: target)
  }

  /// Keeps the first point at 0,0 (as Excalidraw's linear editor does) and the size in sync.
  func normalizePoints(_ element: inout ExcalidrawElement) {
    guard let first = element.points.first, first != .zero else {
      let size = ElementGeometry.sizeFromPoints(element.points)
      element.width = size.width
      element.height = size.height
      return
    }
    element.points = element.points.map { $0 - first }
    element.x += first.x
    element.y += first.y
    let size = ElementGeometry.sizeFromPoints(element.points)
    element.width = size.width
    element.height = size.height
  }
}

extension ElementGeometry {
  /// A scene point in the frame's unrotated coordinates.
  static func unrotateBox(_ point: DrawingPoint, _ frame: SelectionFrame) -> DrawingPoint {
    point.rotated(around: frame.center, by: -frame.angle)
  }
}
