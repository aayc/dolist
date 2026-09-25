import AppKit

extension DrawingCanvasView {
  /// Excalidraw's selection color (through the dark filter in dark mode).
  var selectionColor: CGColor {
    DrawingColorCache.shared.cgColor("#6965db", theme: theme)
  }

  /// Selection box and handles, hover outline, marquee and the binding highlight, in view
  /// points (hairlines stay one point wide at any zoom).
  func drawOverlays(in context: CGContext, index: SceneRenderer.Index) {
    context.saveGState()
    defer { context.restoreGState() }
    context.setLineWidth(1)
    if let id = editor.bindingHighlightId, let element = index.elements[id] {
      context.saveGState()
      context.setStrokeColor(selectionColor.copy(alpha: 0.18) ?? selectionColor)
      context.setLineWidth(10)
      context.setLineJoin(.round)
      context.addPath(outlinePath(element, grow: 4 / viewport.zoom + 5 / viewport.zoom))
      context.strokePath()
      context.restoreGState()
    }
    if let id = editor.hoveredId, let element = index.elements[id] {
      context.setStrokeColor(selectionColor.copy(alpha: 0.6) ?? selectionColor)
      context.addPath(outlinePath(element, grow: 0))
      context.strokePath()
    }
    if let frame = editor.selectionFrame {
      drawSelection(frame, in: context)
    }
    if let marquee = editor.marquee {
      let origin = viewport.sceneToView(DrawingPoint(marquee.minX, marquee.minY))
      let rect = CGRect(
        x: origin.x, y: origin.y, width: marquee.width * viewport.zoom,
        height: marquee.height * viewport.zoom
      ).insetBy(dx: 0.5, dy: 0.5)
      context.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 200 / 255, alpha: 0.04))
      context.fill(rect)
      context.setStrokeColor(selectionColor)
      context.stroke(rect)
    }
  }

  func drawSelection(_ frame: SelectionFrame, in context: CGContext) {
    context.setStrokeColor(selectionColor)
    if !frame.pointHandles.isEmpty {
      for point in frame.pointHandles {
        let center = viewport.sceneToView(point)
        let rect = CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10)
        context.setFillColor(DrawingColorCache.shared.cgColor("#ffffff", theme: theme))
        context.fillEllipse(in: rect)
        context.strokeEllipse(in: rect.insetBy(dx: 0.5, dy: 0.5))
      }
      return
    }
    let corners = frame.corners.map { viewport.sceneToView($0) }
    context.saveGState()
    if !frame.elementRects.isEmpty {
      context.setLineDash(phase: 0, lengths: [4, 4])
      for (rect, angle) in frame.elementRects {
        let center = rect.center
        let points = [
          DrawingPoint(rect.minX, rect.minY), DrawingPoint(rect.maxX, rect.minY),
          DrawingPoint(rect.maxX, rect.maxY), DrawingPoint(rect.minX, rect.maxY),
        ].map { viewport.sceneToView($0.rotated(around: center, by: angle)) }
        context.addLines(between: points)
        context.closePath()
      }
      context.strokePath()
      context.setLineDash(phase: 0, lengths: [])
    }
    context.addLines(between: corners)
    context.closePath()
    context.strokePath()
    context.restoreGState()
    let fill = DrawingColorCache.shared.cgColor("#ffffff", theme: theme)
    for (_, point) in frame.handles {
      let center = viewport.sceneToView(point)
      let square = CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)
      let path = CGMutablePath()
      path.addRoundedRect(
        in: square.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 2, cornerHeight: 2,
        transform: rotationAround(center, frame.angle))
      context.setFillColor(fill)
      context.addPath(path)
      context.fillPath()
      context.addPath(path)
      context.strokePath()
    }
  }

  func rotationAround(_ center: CGPoint, _ angle: Double) -> CGAffineTransform {
    CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle).translatedBy(
      x: -center.x, y: -center.y)
  }

  /// The element's outline in view points (its shape, not its box).
  func outlinePath(_ element: ExcalidrawElement, grow: Double) -> CGPath {
    let path = CGMutablePath()
    let local = CGMutablePath()
    let w = element.width
    let h = element.height
    switch element.type {
    case .ellipse:
      local.addEllipse(in: CGRect(x: -grow, y: -grow, width: w + 2 * grow, height: h + 2 * grow))
    case .diamond:
      let points = ElementGeometry.diamondPoints(element)
      let center = DrawingPoint(w / 2, h / 2)
      local.addLines(
        between: points.map { point -> CGPoint in
          let direction = point - center
          let length = max(hypot(direction.x, direction.y), 1e-9)
          return CGPoint(
            x: point.x + direction.x / length * grow, y: point.y + direction.y / length * grow)
        })
      local.closeSubpath()
    case .line, .arrow, .freedraw:
      let points = element.type == .freedraw ? element.points : HitTest.sampledPath(element)
      local.addLines(between: points.map { CGPoint(x: $0.x, y: $0.y) })
    default:
      let radius = element.type == .rectangle ? ElementGeometry.cornerRadius(min(w, h), element) : 0
      local.addRoundedRect(
        in: CGRect(x: -grow, y: -grow, width: w + 2 * grow, height: h + 2 * grow),
        cornerWidth: min(radius + grow, (w + 2 * grow) / 2),
        cornerHeight: min(radius + grow, (h + 2 * grow) / 2))
    }
    let center = ElementGeometry.center(element)
    let transform = CGAffineTransform(scaleX: viewport.zoom, y: viewport.zoom)
      .translatedBy(x: -viewport.origin.x, y: -viewport.origin.y)
      .translatedBy(x: center.x, y: center.y).rotated(by: element.angle)
      .translatedBy(x: element.x - center.x, y: element.y - center.y)
    path.addPath(local, transform: transform)
    return path
  }
}
