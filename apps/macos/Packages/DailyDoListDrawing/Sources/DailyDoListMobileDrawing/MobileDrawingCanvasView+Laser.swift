#if canImport(UIKit)
  import UIKit

  extension MobileDrawingCanvasView {
    func handleLaser(_ gesture: UIPanGestureRecognizer) -> Bool {
      guard laserEnabled, mode == .editing else { return false }
      switch gesture.state {
      case .began:
        editor.cancelPointerInteraction()
        addLaserPoint(gesture.location(in: self))
      case .changed, .ended: addLaserPoint(gesture.location(in: self))
      case .cancelled, .failed: clearLaser()
      default: break
      }
      return true
    }
    func addLaserPoint(_ point: CGPoint) {
      laserTrail.append((viewport.viewToScene(point), CACurrentMediaTime()))
      if laserTrail.count > 256 { laserTrail.removeFirst(laserTrail.count - 256) }
      if laserDisplayLink == nil {
        let link = CADisplayLink(target: self, selector: #selector(updateLaser))
        link.add(to: .main, forMode: .common)
        laserDisplayLink = link
      }
      setNeedsDisplay()
    }
    @objc private func updateLaser() {
      let cutoff = CACurrentMediaTime() - 0.8
      laserTrail.removeAll { $0.time < cutoff }
      if laserTrail.isEmpty { clearLaser() }
      setNeedsDisplay()
    }
    func clearLaser() {
      laserTrail = []
      laserDisplayLink?.invalidate()
      laserDisplayLink = nil
      setNeedsDisplay()
    }
    func drawLaser(in context: CGContext) {
      guard !laserTrail.isEmpty else { return }
      context.saveGState()
      defer { context.restoreGState() }
      context.setLineCap(.round)
      context.setLineWidth(4)
      let now = CACurrentMediaTime()
      for index in laserTrail.indices {
        let alpha = max(0, 1 - (now - laserTrail[index].time) / 0.8)
        let point = viewport.sceneToView(laserTrail[index].point)
        context.setStrokeColor(UIColor.systemRed.withAlphaComponent(alpha).cgColor)
        if index > 0 {
          context.move(to: viewport.sceneToView(laserTrail[index - 1].point))
          context.addLine(to: point)
          context.strokePath()
        } else {
          context.setFillColor(UIColor.systemRed.withAlphaComponent(alpha).cgColor)
          context.fillEllipse(in: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6))
        }
      }
    }
  }
#endif
