import AppKit

extension DrawingCanvasView {
  static func modifiers(_ flags: NSEvent.ModifierFlags) -> PointerModifiers {
    var result: PointerModifiers = []
    if flags.contains(.shift) { result.insert(.shift) }
    if flags.contains(.option) { result.insert(.option) }
    if flags.contains(.command) { result.insert(.command) }
    if flags.contains(.control) { result.insert(.control) }
    return result
  }

  func scenePoint(_ event: NSEvent) -> DrawingPoint {
    viewport.viewToScene(convert(event.locationInWindow, from: nil))
  }

  var isPanning: Bool { editor.tool == .hand || isSpaceHeld }

  // MARK: Mouse

  public override func mouseDown(with event: NSEvent) {
    guard mode == .editing else {
      super.mouseDown(with: event)
      return
    }
    window?.makeFirstResponder(self)
    let location = convert(event.locationInWindow, from: nil)
    if isPanning {
      panStart = (location, viewport.origin)
      NSCursor.closedHand.set()
      return
    }
    editor.pointerDown(
      at: viewport.viewToScene(location), modifiers: Self.modifiers(event.modifierFlags),
      clickCount: event.clickCount)
  }

  public override func mouseDragged(with event: NSEvent) {
    guard mode == .editing else {
      super.mouseDragged(with: event)
      return
    }
    let location = convert(event.locationInWindow, from: nil)
    if let panStart {
      let delta = CGPoint(x: location.x - panStart.view.x, y: location.y - panStart.view.y)
      setViewport(
        DrawingViewport(
          zoom: viewport.zoom,
          origin: DrawingPoint(
            panStart.origin.x - delta.x / viewport.zoom, panStart.origin.y - delta.y / viewport.zoom
          )))
      return
    }
    autoscroll(with: event)
    editor.pointerDragged(
      to: viewport.viewToScene(location), modifiers: Self.modifiers(event.modifierFlags))
  }

  public override func mouseUp(with event: NSEvent) {
    guard mode == .editing else {
      super.mouseUp(with: event)
      return
    }
    if panStart != nil {
      panStart = nil
      updateCursor(at: convert(event.locationInWindow, from: nil))
      return
    }
    editor.pointerUp(at: scenePoint(event), modifiers: Self.modifiers(event.modifierFlags))
    updateCursor(at: convert(event.locationInWindow, from: nil))
  }

  public override func mouseMoved(with event: NSEvent) {
    guard mode == .editing else {
      super.mouseMoved(with: event)
      return
    }
    let location = convert(event.locationInWindow, from: nil)
    lastPointer = location
    editor.pointerMoved(
      to: viewport.viewToScene(location), modifiers: Self.modifiers(event.modifierFlags))
    updateCursor(at: location)
  }

  public override func mouseExited(with event: NSEvent) {
    editor.pointerExited()
    super.mouseExited(with: event)
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea { removeTrackingArea(trackingArea) }
    let area = NSTrackingArea(
      rect: .zero,
      options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    trackingArea = area
  }

  func updateCursor(at location: CGPoint) {
    guard mode == .editing else { return }
    cursor(at: location).set()
  }

  /// The cursor for what's under the pointer: crosshair to draw, I-beam for text, resize cursors
  /// on handles, a hand to pan.
  func cursor(at location: CGPoint) -> NSCursor {
    if isPanning { return panStart == nil ? .openHand : .closedHand }
    switch editor.tool {
    case .text: return .iBeam
    case .rectangle, .ellipse, .diamond, .arrow, .line, .freedraw, .eraser: return .crosshair
    case .hand: return .openHand
    case .selection: break
    }
    switch editor.hoverTarget(at: viewport.viewToScene(location)) {
    case .handle(let handle, let angle):
      return Self.resizeCursor(handle, angle: angle)
    case .point:
      return .crosshair
    default:
      return .arrow
    }
  }

  static func resizeCursor(_ handle: TransformHandle, angle: Double) -> NSCursor {
    let base: Double =
      switch handle {
      case .e, .w: 0
      case .n, .s: 90
      case .ne, .sw: 45
      case .nw, .se: 135
      }
    var degrees = (base - angle * 180 / .pi).truncatingRemainder(dividingBy: 180)
    if degrees < 0 { degrees += 180 }
    if degrees < 22.5 || degrees >= 157.5 { return .resizeLeftRight }
    if degrees >= 67.5 && degrees < 112.5 { return .resizeUpDown }
    if #available(macOS 15.0, *) {
      return degrees < 90
        ? .frameResize(position: .topRight, directions: .all)
        : .frameResize(position: .topLeft, directions: .all)
    }
    return .crosshair
  }

  public override func resetCursorRects() {
    if mode == .editing { addCursorRect(bounds, cursor: cursor(at: lastPointer ?? .zero)) }
  }

  // MARK: Scrolling and zooming

  public override func scrollWheel(with event: NSEvent) {
    guard mode == .editing else {
      super.scrollWheel(with: event)
      return
    }
    let location = convert(event.locationInWindow, from: nil)
    if event.modifierFlags.contains(.command) {
      let factor = exp(event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 0.01 : 0.1))
      zoom(by: factor, around: location)
      return
    }
    let scale = event.hasPreciseScrollingDeltas ? 1.0 : 10.0
    setViewport(
      DrawingViewport(
        zoom: viewport.zoom,
        origin: DrawingPoint(
          viewport.origin.x - event.scrollingDeltaX * scale / viewport.zoom,
          viewport.origin.y - event.scrollingDeltaY * scale / viewport.zoom)))
  }

  public override func magnify(with event: NSEvent) {
    guard mode == .editing else {
      super.magnify(with: event)
      return
    }
    zoom(by: 1 + event.magnification, around: convert(event.locationInWindow, from: nil))
  }

  /// Zooms keeping the scene point under `location` in place (Excalidraw's 10%–3000%).
  public func zoom(by factor: Double, around location: CGPoint) {
    let anchor = viewport.viewToScene(location)
    let zoom = min(30, max(0.1, viewport.zoom * factor))
    setViewport(
      DrawingViewport(
        zoom: zoom, origin: DrawingPoint(anchor.x - location.x / zoom, anchor.y - location.y / zoom)
      ))
  }

  // MARK: Keys

  public override func keyDown(with event: NSEvent) {
    guard mode == .editing else {
      super.keyDown(with: event)
      return
    }
    let modifiers = Self.modifiers(event.modifierFlags)
    if event.charactersIgnoringModifiers == " ", modifiers.isEmpty, !event.isARepeat || isSpaceHeld
    {
      isSpaceHeld = true
      updateCursor(at: lastPointer ?? .zero)
      return
    }
    if let key = Self.drawingKey(event), editor.handleKey(key, modifiers: modifiers) {
      updateCursor(at: lastPointer ?? .zero)
      return
    }
    if event.keyCode == 53 {
      onEndEditing?()
      return
    }
    super.keyDown(with: event)
  }

  public override func keyUp(with event: NSEvent) {
    if event.charactersIgnoringModifiers == " " {
      isSpaceHeld = false
      updateCursor(at: lastPointer ?? .zero)
      return
    }
    super.keyUp(with: event)
  }

  /// ⌘-shortcuts reach the canvas before the menus while it's editing.
  public override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard mode == .editing, window?.firstResponder === self,
      event.modifierFlags.contains(.command), let key = Self.drawingKey(event)
    else { return super.performKeyEquivalent(with: event) }
    return editor.handleKey(key, modifiers: Self.modifiers(event.modifierFlags))
      || super.performKeyEquivalent(with: event)
  }

  static func drawingKey(_ event: NSEvent) -> DrawingKey? {
    switch event.keyCode {
    case 51: return .delete
    case 117: return .forwardDelete
    case 53: return .escape
    case 36, 76: return .enter
    case 123: return .left
    case 124: return .right
    case 125: return .down
    case 126: return .up
    default:
      guard let character = event.charactersIgnoringModifiers?.first else { return nil }
      return .character(character)
    }
  }

  // MARK: Editing commands (menus and ⌘-keys when first responder)

  @objc public func undo(_ sender: Any?) { editor.undo() }
  @objc public func redo(_ sender: Any?) { editor.redo() }
  @objc public func delete(_ sender: Any?) { editor.deleteSelection() }
  @objc public override func selectAll(_ sender: Any?) { editor.selectAll() }
}
