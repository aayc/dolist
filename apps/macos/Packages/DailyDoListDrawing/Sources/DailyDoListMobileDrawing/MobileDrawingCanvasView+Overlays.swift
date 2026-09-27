#if canImport(UIKit)
  import UIKit

  extension MobileDrawingCanvasView {
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
