import AppKit
import DailyDoListDrawingModel
import DailyDoListUITestSupport
import Foundation

@testable import DailyDoListDrawing

/// A canvas in an offscreen window, driven with real `NSEvent`s (points are in the view's
/// flipped coordinates; at zoom 1 with the origin at 0,0 they're scene coordinates too).
@MainActor
final class CanvasHarness {
  let window: NSWindow
  let canvas: DrawingCanvasView
  let environment = DeterministicDrawingEnvironment()
  var changes: [ExcalidrawScene] = []
  var endedEditing = 0

  init(
    scene: ExcalidrawScene = ExcalidrawScene(), mode: DrawingCanvasView.Mode = .editing,
    theme: DrawingTheme = .light, size: CGSize = CGSize(width: 800, height: 600)
  ) {
    canvas = DrawingCanvasView(
      scene: scene, mode: mode, theme: theme, environment: environment,
      frame: CGRect(origin: .zero, size: size))
    window = NSWindow(
      contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: theme == .dark ? .darkAqua : .aqua)
    window.contentView = canvas
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    canvas.setViewport(DrawingViewport(zoom: 1, origin: .zero))
    canvas.onChange = { [weak self] in self?.changes.append($0) }
    canvas.onEndEditing = { [weak self] in self?.endedEditing += 1 }
    window.makeFirstResponder(canvas)
  }

  func close() { window.close() }

  var editor: DrawingEditor { canvas.editor }
  var elements: [ExcalidrawElement] { canvas.scene.visibleElements }

  private var time: TimeInterval = 1000

  func mouse(
    _ type: NSEvent.EventType, at point: CGPoint, flags: NSEvent.ModifierFlags = [],
    clickCount: Int = 1
  ) -> NSEvent {
    time += 0.02
    return NSEvent.mouseEvent(
      with: type, location: canvas.convert(point, to: nil), modifierFlags: flags, timestamp: time,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clickCount,
      pressure: 1)!
  }

  func drag(
    from start: CGPoint, to end: CGPoint, steps: Int = 6, flags: NSEvent.ModifierFlags = []
  ) {
    canvas.mouseDown(with: mouse(.leftMouseDown, at: start, flags: flags))
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
      canvas.mouseDragged(with: mouse(.leftMouseDragged, at: point, flags: flags))
    }
    canvas.mouseUp(with: mouse(.leftMouseUp, at: end, flags: flags))
  }

  func click(_ point: CGPoint, flags: NSEvent.ModifierFlags = [], count: Int = 1) {
    canvas.mouseDown(with: mouse(.leftMouseDown, at: point, flags: flags, clickCount: count))
    canvas.mouseUp(with: mouse(.leftMouseUp, at: point, flags: flags, clickCount: count))
  }

  func move(to point: CGPoint) {
    canvas.mouseMoved(with: mouse(.mouseMoved, at: point))
  }

  static let keyCodes: [String: UInt16] = [
    "escape": 53, "return": 36, "delete": 51, "left": 123, "right": 124, "down": 125, "up": 126,
    "space": 49, "z": 6, "d": 2, "a": 0, "r": 15, "o": 31, "t": 17, "e": 14, "l": 37, "p": 35,
    "v": 9, "h": 4, "q": 12, "x": 7, "2": 19, "5": 23,
  ]

  func keyEvent(_ name: String, flags: NSEvent.ModifierFlags = [], up: Bool = false) -> NSEvent {
    let characters: String =
      switch name {
      case "escape": "\u{1B}"
      case "return": "\r"
      case "delete": "\u{7F}"
      case "space": " "
      case "left", "right", "up", "down": ""
      default: name
      }
    time += 0.02
    return NSEvent.keyEvent(
      with: up ? .keyUp : .keyDown, location: .zero, modifierFlags: flags, timestamp: time,
      windowNumber: window.windowNumber, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false,
      keyCode: Self.keyCodes[name] ?? 0)!
  }

  /// A key as the window would deliver it: ⌘-keys as key equivalents first.
  func press(_ name: String, flags: NSEvent.ModifierFlags = []) {
    let event = keyEvent(name, flags: flags)
    if flags.contains(.command), canvas.performKeyEquivalent(with: event) { return }
    if let responder = window.firstResponder as? NSView, responder !== canvas {
      responder.keyDown(with: event)
    } else {
      canvas.keyDown(with: event)
    }
  }

  func release(_ name: String) {
    canvas.keyUp(with: keyEvent(name, up: true))
  }

  /// The view as the screen would show it, subviews (tool bar, text editor) included.
  func snapshot() -> NSBitmapImageRep {
    window.orderFrontRegardless()
    for _ in 0..<4 {
      canvas.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    return canvas.bitmap()
  }

  func writeSnapshot(_ name: String) throws -> NSBitmapImageRep {
    let rep = snapshot()
    try rep.writePNG(name, in: Fixtures.snapshotDirectory)
    return rep
  }
}
