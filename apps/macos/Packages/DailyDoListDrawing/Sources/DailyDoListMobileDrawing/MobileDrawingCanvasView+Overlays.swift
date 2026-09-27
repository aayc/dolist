#if canImport(UIKit)
  import UIKit

  extension MobileDrawingCanvasView {
    func drawGrid(in context: CGContext) {
      guard editor.gridEnabled, editor.gridSize.isFinite, editor.gridSize >= 1 else { return }
      var spacing = editor.gridSize * viewport.zoom
      while spacing < 10 { spacing *= 2 }
      let x0 = (-viewport.origin.x * viewport.zoom).truncatingRemainder(dividingBy: spacing)
      let y0 = (-viewport.origin.y * viewport.zoom).truncatingRemainder(dividingBy: spacing)
      context.saveGState()
      context.setFillColor(UIColor.secondaryLabel.withAlphaComponent(0.3).cgColor)
      for x in stride(from: x0, through: bounds.width, by: spacing) {
        for y in stride(from: y0, through: bounds.height, by: spacing) {
          context.fillEllipse(in: CGRect(x: x, y: y, width: 1.5, height: 1.5))
        }
      }
      context.restoreGState()
    }

    func drawSelection(in context: CGContext) {
      context.saveGState()
      defer { context.restoreGState() }
      context.setStrokeColor(DrawingColorCache.shared.cgColor("#6965db", theme: theme))
      context.setFillColor(DrawingColorCache.shared.cgColor("#ffffff", theme: theme))
      context.setLineWidth(1.5)
      if let frame = editor.selectionFrame {
        let points = frame.corners.map { viewport.sceneToView($0) }
        context.addLines(between: points)
        context.closePath()
        context.strokePath()
        for point in Array(frame.handles.values) + frame.pointHandles {
          let center = viewport.sceneToView(point)
          let rect = CGRect(x: center.x - 6, y: center.y - 6, width: 12, height: 12)
          context.fillEllipse(in: rect)
          context.strokeEllipse(in: rect)
        }
      }
      if let point = editor.rotationHandle, let frame = editor.selectionFrame {
        let start = viewport.sceneToView(
          DrawingPoint(frame.center.x, frame.rect.minY)
            .rotated(around: frame.center, by: frame.angle))
        let end = viewport.sceneToView(point)
        context.move(to: start)
        context.addLine(to: end)
        context.strokePath()
        context.fillEllipse(in: CGRect(x: end.x - 6, y: end.y - 6, width: 12, height: 12))
        context.strokeEllipse(in: CGRect(x: end.x - 6, y: end.y - 6, width: 12, height: 12))
      }
      for point in editor.linearMidpoints {
        let center = viewport.sceneToView(point)
        context.setFillColor(UIColor.systemIndigo.withAlphaComponent(0.3).cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8))
      }
      if let index = editor.selectedPointIndex, let points = editor.selectionFrame?.pointHandles,
        points.indices.contains(index)
      {
        let center = viewport.sceneToView(points[index])
        context.setFillColor(UIColor.systemIndigo.cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10))
      }
      if let marquee = editor.marquee {
        let origin = viewport.sceneToView(DrawingPoint(marquee.minX, marquee.minY))
        let rect = CGRect(
          x: origin.x, y: origin.y, width: marquee.width * viewport.zoom,
          height: marquee.height * viewport.zoom)
        context.setFillColor(UIColor.systemIndigo.withAlphaComponent(0.08).cgColor)
        context.fill(rect)
        context.stroke(rect)
      }
      if let id = editor.bindingHighlightId, let element = editor.element(id) {
        let box = ElementGeometry.bounds(element)
        let origin = viewport.sceneToView(DrawingPoint(box.minX, box.minY))
        context.setLineWidth(4)
        context.stroke(
          CGRect(
            x: origin.x, y: origin.y, width: box.width * viewport.zoom,
            height: box.height * viewport.zoom
          ).insetBy(dx: -4, dy: -4))
      }
    }
  }
#endif
