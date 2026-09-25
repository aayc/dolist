import Foundation

extension DrawingEditor {
  /// A new element at a point with the current style (Excalidraw's `newElement` field order and
  /// defaults: version 1, nonce 0, a random seed).
  func newElement(_ type: ElementType, at point: DrawingPoint) -> ExcalidrawElement {
    var element = ExcalidrawElement(id: environment.randomId(), type: type)
    element.x = point.x
    element.y = point.y
    element.strokeColor = style.strokeColor
    element.backgroundColor =
      [.rectangle, .ellipse, .diamond, .line, .freedraw].contains(type)
      ? style.backgroundColor : ExcalidrawPalette.transparent
    element.fillStyle = style.fillStyle
    element.strokeWidth = style.strokeWidth
    element.strokeStyle = style.strokeStyle
    element.roughness = style.roughness
    element.opacity = style.opacity
    if style.roundEdges {
      switch type {
      case .rectangle: element.roundness = .adaptive
      case .diamond, .line, .arrow: element.roundness = .proportional
      default: break
      }
    }
    element.seed = environment.randomInteger()
    element.version = 1
    element.versionNonce = 0
    element.updated = environment.now()
    switch type {
    case .arrow:
      element.startArrowhead = style.startArrowhead
      element.endArrowhead = style.endArrowhead
    case .text:
      element.text = TextProperties(
        text: "", fontSize: style.fontSize, fontFamily: style.fontFamily, textAlign: style.textAlign
      )
    default:
      break
    }
    return element
  }

  /// Drawing a rectangle, ellipse or diamond: shift makes it a square, option grows it from the
  /// center.
  func resizeNewElement(
    _ id: String, origin: DrawingPoint, to point: DrawingPoint, modifiers: PointerModifiers
  ) {
    var dx = point.x - origin.x
    var dy = point.y - origin.y
    if modifiers.contains(.shift) {
      let side = max(abs(dx), abs(dy))
      dx = dx < 0 ? -side : side
      dy = dy < 0 ? -side : side
    }
    update(id) { element in
      if modifiers.contains(.option) {
        element.x = origin.x - abs(dx)
        element.y = origin.y - abs(dy)
        element.width = abs(dx) * 2
        element.height = abs(dy) * 2
      } else {
        element.x = min(origin.x, origin.x + dx)
        element.y = min(origin.y, origin.y + dy)
        element.width = abs(dx)
        element.height = abs(dy)
      }
    }
  }

  /// A click without a drag makes nothing (Excalidraw removes invisibly small elements).
  func finishCreation(_ id: String) {
    guard let element = element(id) else { return }
    if element.width * zoom < 2 && element.height * zoom < 2 {
      removeUncommitted(id)
      return
    }
    select([id])
    if !isToolLocked { tool = .selection }
    commit()
  }

  /// Drops an element that was never committed.
  func removeUncommitted(_ id: String) {
    guard let index = indexById[id] else { return }
    scene.elements.remove(at: index)
    rebuildIndex()
    invalidate()
  }

  func appendFreedrawPoint(_ id: String, _ point: DrawingPoint) {
    guard let current = element(id) else { return }
    let local = point - DrawingPoint(current.x, current.y)
    if let last = current.points.last, last == local { return }
    update(id) { element in
      element.points.append(local)
      let size = ElementGeometry.sizeFromPoints(element.points)
      element.width = size.width
      element.height = size.height
    }
  }

  // MARK: Lines and arrows

  /// The shape an arrow's end at `point` would bind to (arrows only).
  func arrowTarget(at point: DrawingPoint, excluding: Set<String>, for id: String?) -> String? {
    if let id, element(id)?.type != .arrow { return nil }
    if id == nil && tool != .arrow && gesture == nil { return nil }
    var excluded = excluding
    if let id, let label = element(id)?.boundTextId { excluded.insert(label) }
    return ArrowBinding.bindableElement(
      at: point, in: scene.elements, excluding: excluded, zoom: zoom)?.id
  }

  func finishLinear(_ id: String, startTarget: String?) {
    bindingHighlightId = nil
    guard let arrow = element(id) else { return }
    if arrow.type == .arrow {
      if let startTarget { bindEnd(id, end: .start, to: startTarget) }
      if let arrow = element(id), let last = arrow.points.indices.last {
        var target = arrowTarget(
          at: ArrowBinding.absolutePoint(arrow, last), excluding: [id], for: id)
        // A two-point arrow doesn't attach both ends to the same shape.
        if target == startTarget && arrow.points.count < 3 { target = nil }
        bindEnd(id, end: .end, to: target)
      }
    }
    select([id])
    if !isToolLocked { tool = .selection }
    commit()
  }

  func multiPointClick(_ id: String, at point: DrawingPoint, clickCount: Int) {
    guard let current = element(id), current.points.count >= 2 else { return }
    let lastFixed = current.points[current.points.count - 2]
    let local = point - DrawingPoint(current.x, current.y)
    let closesLoop =
      current.type == .line && current.points.count > 3 && local.distance(to: .zero) * zoom < 8
    if clickCount >= 2 || local.distance(to: lastFixed) * zoom < 6 || closesLoop {
      if closesLoop { update(id) { $0.points[$0.points.count - 1] = .zero } }
      finishMultiPoint(dropLast: !closesLoop)
      return
    }
    update(id) { element in
      element.points[element.points.count - 1] = local
      element.points.append(local)
      normalizePoints(&element)
    }
    invalidate()
  }

  /// Ends a line drawn click by click (Enter, Escape, a double click, or clicking the last point
  /// again).
  public func finishMultiPoint(dropLast: Bool = true) {
    guard let id = multiPointElementId else { return }
    multiPointElementId = nil
    let startTarget = multiPointStartTarget
    multiPointStartTarget = nil
    if dropLast, let current = element(id), current.points.count > 2 {
      update(id) { element in
        element.points.removeLast()
        normalizePoints(&element)
      }
    }
    guard let current = element(id), current.points.count >= 2,
      let first = current.points.first, let last = current.points.last, first.distance(to: last) > 0
    else {
      removeUncommitted(id)
      if !isToolLocked { tool = .selection }
      return
    }
    finishLinear(id, startTarget: startTarget)
  }

  // MARK: Text

  func createText(at point: DrawingPoint) {
    var element = newElement(.text, at: point)
    let lineHeight = element.text?.lineHeight ?? 1.25
    element.height = style.fontSize * lineHeight
    // The caret sits where the click was, vertically centered like Excalidraw's.
    element.y = point.y - element.height / 2
    insert(element)
    select([element.id])
    if !isToolLocked { tool = .selection }
    beginTextEditing(element.id)
  }
}
