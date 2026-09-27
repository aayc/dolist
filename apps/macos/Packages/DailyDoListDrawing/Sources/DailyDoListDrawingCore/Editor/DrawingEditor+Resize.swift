import Foundation

extension DrawingEditor {
  /// Resizes the selection by a handle: one element in its own (rotated) frame, several by
  /// scaling their box. Shift keeps the proportions, option resizes around the center. Text
  /// scales its font from corners and rewraps from the sides; labels follow their containers.
  func resize(
    handle: TransformHandle, frame: SelectionFrame, originals: [String: ExcalidrawElement],
    to point: DrawingPoint, modifiers: PointerModifiers
  ) {
    let padding = 5 / zoom
    let box = frame.rect.insetBy(padding)
    let local = point.rotated(around: box.center, by: -frame.angle)
    let keepAspect =
      modifiers.contains(.shift)
      || originals.values.contains { $0.type == .text && $0.containerId == nil && handle.isCorner }
    let fromCenter = modifiers.contains(.option)
    let affectsX = handle.movesLeft || handle.movesRight
    let affectsY = handle.movesTop || handle.movesBottom
    let center = box.center
    // Signed new size: negative when the pointer crossed the anchor (a flip).
    var newWidth = box.width
    var newHeight = box.height
    if affectsX {
      let edge = handle.movesRight ? local.x - padding : local.x + padding
      newWidth =
        fromCenter
        ? 2 * (handle.movesRight ? edge - center.x : center.x - edge)
        : (handle.movesRight ? edge - box.minX : box.maxX - edge)
    }
    if affectsY {
      let edge = handle.movesBottom ? local.y - padding : local.y + padding
      newHeight =
        fromCenter
        ? 2 * (handle.movesBottom ? edge - center.y : center.y - edge)
        : (handle.movesBottom ? edge - box.minY : box.maxY - edge)
    }
    if keepAspect, box.width > 0, box.height > 0 {
      var sx = newWidth / box.width
      var sy = newHeight / box.height
      if handle.isCorner {
        let scale = max(abs(sx), abs(sy))
        sx = sx < 0 ? -scale : scale
        sy = sy < 0 ? -scale : scale
      } else if affectsX {
        sy = abs(sx)
      } else {
        sx = abs(sy)
      }
      newWidth = box.width * sx
      newHeight = box.height * sy
    }
    func range(
      _ minimum: Double, _ maximum: Double, _ size: Double, grows: Bool, shrinksStart: Bool,
      affected: Bool, middle: Double
    ) -> (Double, Double) {
      if fromCenter { return (middle - size / 2, middle + size / 2) }
      if affected { return grows ? (minimum, minimum + size) : (maximum - size, maximum) }
      if keepAspect { return (middle - size / 2, middle + size / 2) }
      _ = shrinksStart
      return (minimum, maximum)
    }
    let (x1, x2) = range(
      box.minX, box.maxX, newWidth, grows: handle.movesRight, shrinksStart: handle.movesLeft,
      affected: affectsX, middle: center.x)
    let (y1, y2) = range(
      box.minY, box.maxY, newHeight, grows: handle.movesBottom, shrinksStart: handle.movesTop,
      affected: affectsY, middle: center.y)
    let newBox = DrawingRect(
      minX: min(x1, x2), minY: min(y1, y2), maxX: max(x1, x2), maxY: max(y1, y2))
    let flipX = newWidth < 0
    let flipY = newHeight < 0
    let topLevel = originals.values.filter { original in
      guard let containerId = original.containerId else { return true }
      return originals[containerId] == nil
    }
    if topLevel.count == 1, let original = topLevel.first {
      resizeSingle(
        original, from: box, to: newBox, flipX: flipX, flipY: flipY, handle: handle,
        frameAngle: frame.angle)
    } else {
      for original in topLevel {
        scale(original, from: box, to: newBox, flipX: flipX, flipY: flipY)
      }
    }
    var changed = Set<String>()
    for original in originals.values {
      if let label = original.boundTextId, let labelElement = element(label) {
        if labelElement.containerId == original.id { layoutLabel(label) }
      }
      changed.insert(original.id)
    }
    updateArrowsBound(to: changed, movedTogether: Set(originals.keys))
  }

  /// One element: its new unrotated box, placed so that it rotates around its new center.
  private func resizeSingle(
    _ original: ExcalidrawElement, from box: DrawingRect, to newBox: DrawingRect, flipX: Bool,
    flipY: Bool, handle: TransformHandle, frameAngle: Double
  ) {
    let width = max(newBox.width, 1)
    let height = max(newBox.height, 1)
    // The new center, from the old frame to the scene.
    let center = newBox.center.rotated(around: box.center, by: frameAngle)
    let origin = DrawingPoint(center.x - width / 2, center.y - height / 2)
    update(original.id) { element in
      switch original.type {
      case .line, .arrow, .freedraw:
        let old = ElementGeometry.unrotatedBounds(original)
        let sx = (old.width == 0 ? 1 : width / old.width) * (flipX ? -1 : 1)
        let sy = (old.height == 0 ? 1 : height / old.height) * (flipY ? -1 : 1)
        let localMin = DrawingPoint(old.minX - original.x, old.minY - original.y)
        var points = original.points.map { point -> DrawingPoint in
          let relative = point - localMin
          return DrawingPoint(
            (flipX ? width : 0) + relative.x * sx, (flipY ? height : 0) + relative.y * sy)
        }
        let first = points.first ?? .zero
        points = points.map { $0 - first }
        element.points = points
        element.x = origin.x + first.x
        element.y = origin.y + first.y
        element.width = ElementGeometry.sizeFromPoints(points).width
        element.height = ElementGeometry.sizeFromPoints(points).height
      case .text where original.containerId == nil:
        guard var properties = original.text else { return }
        if handle.isCorner || handle == .n || handle == .s {
          let scale = height / max(original.height, 1)
          properties.fontSize = max(1, original.text!.fontSize * scale)
          let size = TextLayout.measure(
            properties.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
            lineHeight: properties.lineHeight)
          element.width = properties.autoResize ? size.width : width
          element.height = size.height
        } else {
          properties.autoResize = false
          properties.text = TextLayout.wrap(
            properties.originalText, fontSize: properties.fontSize,
            fontFamily: properties.fontFamily,
            maxWidth: width)
          let size = TextLayout.measure(
            properties.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
            lineHeight: properties.lineHeight)
          element.width = width
          element.height = size.height
        }
        element.text = properties
        element.x = origin.x
        element.y = origin.y
      default:
        element.x = origin.x
        element.y = origin.y
        element.width = width
        element.height = height
      }
    }
  }

  /// Several elements: positions and sizes scale with the selection's box.
  private func scale(
    _ original: ExcalidrawElement, from box: DrawingRect, to newBox: DrawingRect, flipX: Bool,
    flipY: Bool
  ) {
    let sx = box.width == 0 ? 1 : newBox.width / box.width
    let sy = box.height == 0 ? 1 : newBox.height / box.height
    func mapX(_ x: Double) -> Double {
      flipX ? newBox.maxX - (x - box.minX) * sx : newBox.minX + (x - box.minX) * sx
    }
    func mapY(_ y: Double) -> Double {
      flipY ? newBox.maxY - (y - box.minY) * sy : newBox.minY + (y - box.minY) * sy
    }
    update(original.id) { element in
      switch original.type {
      case .line, .arrow, .freedraw:
        let points = original.points.map { point in
          DrawingPoint(mapX(original.x + point.x), mapY(original.y + point.y))
        }
        let first = points.first ?? DrawingPoint(mapX(original.x), mapY(original.y))
        element.x = first.x
        element.y = first.y
        element.points = points.map { $0 - first }
        let size = ElementGeometry.sizeFromPoints(element.points)
        element.width = size.width
        element.height = size.height
      default:
        let corner1 = DrawingPoint(mapX(original.x), mapY(original.y))
        let corner2 = DrawingPoint(
          mapX(original.x + original.width), mapY(original.y + original.height))
        element.x = min(corner1.x, corner2.x)
        element.y = min(corner1.y, corner2.y)
        element.width = max(1, abs(corner2.x - corner1.x))
        element.height = max(1, abs(corner2.y - corner1.y))
        if var properties = original.text, original.containerId == nil {
          properties.fontSize = max(1, properties.fontSize * min(sx, sy))
          let size = TextLayout.measure(
            properties.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
            lineHeight: properties.lineHeight)
          element.text = properties
          element.width = size.width
          element.height = size.height
        }
      }
    }
  }
}
