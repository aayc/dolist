#if canImport(UIKit)
  import UIKit

  /// A native touch canvas. Drawing and history live in the shared editor; UIKit only maps
  /// gestures and hosts the inline text input. Two fingers always navigate the viewport.
  @MainActor
  public final class MobileDrawingCanvasView: UIView, UIGestureRecognizerDelegate {
    public enum Mode { case display, editing }
    public let editor: DrawingEditor
    public private(set) var viewport = DrawingViewport()
    public var mode: Mode = .editing {
      didSet {
        if mode != oldValue {
          editor.finishInteraction()
          editor.clearSelection()
          endInlineTextEditing()
          setNeedsDisplay()
        }
      }
    }
    public var theme: DrawingTheme = .light { didSet { setNeedsDisplay() } }
    public var background: DrawingBackground = .scene { didSet { setNeedsDisplay() } }
    public var pointerModifiers: PointerModifiers = []
    public var onChange: ((ExcalidrawScene) -> Void)?
    public var onEndEditing: (() -> Void)?
    let renderer = SceneRenderer()
    let staticLayer = StaticLayerCache()
    var textEditor: UITextView?
    var textElementId: String?
    private var hasLaidOut = false
    private var dragOrigin = DrawingPoint.zero
    private var navigatesWithOneFinger = false
    private var panOrigin = DrawingPoint.zero
    private var pinchZoom: Double = 1
    private var pinchAnchor = DrawingPoint.zero
    private lazy var drawingPan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    private lazy var navigationPan = UIPanGestureRecognizer(
      target: self, action: #selector(pan(_:)))
    private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(zoom(_:)))

    public init(editor: DrawingEditor) {
      self.editor = editor
      super.init(frame: .zero)
      isMultipleTouchEnabled = true
      isOpaque = false
      accessibilityLabel = "Drawing canvas"
      accessibilityHint =
        "Use the selected tool with one finger. Use two fingers to pan or pinch to zoom."
      editor.hitTolerance = 18
      editor.selectionHandleRadius = 22
      editor.onInvalidate = { [weak self] in
        self?.positionTextEditor()
        self?.setNeedsDisplay()
      }
      editor.onChange = { [weak self] scene in self?.onChange?(scene) }
      editor.onBeginTextEditing = { [weak self] id in self?.beginInlineTextEditing(id) }
      editor.onEndTextEditing = { [weak self] in self?.endInlineTextEditing(notify: false) }
      drawingPan.maximumNumberOfTouches = 1
      navigationPan.minimumNumberOfTouches = 2
      navigationPan.maximumNumberOfTouches = 2
      let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
      let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
      doubleTap.numberOfTapsRequired = 2
      tap.require(toFail: doubleTap)
      for recognizer in [drawingPan, navigationPan, pinch, tap, doubleTap] {
        recognizer.delegate = self
        addGestureRecognizer(recognizer)
      }
    }

    public convenience init(scene: ExcalidrawScene) {
      self.init(editor: DrawingEditor(scene: scene))
    }
    @available(*, unavailable) required init?(coder: NSCoder) {
      fatalError("init(coder:) unavailable")
    }

    public override func layoutSubviews() {
      super.layoutSubviews()
      if !hasLaidOut && bounds.width > 0 && bounds.height > 0 {
        hasLaidOut = true
        zoomToFit()
      }
      positionTextEditor()
    }

    public func setScene(_ scene: ExcalidrawScene, keepHistory: Bool = false) {
      endInlineTextEditing()
      editor.replaceScene(scene, keepHistory: keepHistory)
      staticLayer.invalidate()
      if mode == .display { zoomToFit() }
    }

    public func setViewport(_ viewport: DrawingViewport) {
      guard viewport.zoom.isFinite, viewport.zoom > 0,
        viewport.origin.x.isFinite, viewport.origin.y.isFinite
      else { return }
      self.viewport = DrawingViewport(
        zoom: min(30, max(0.1, viewport.zoom)), origin: viewport.origin)
      editor.zoom = self.viewport.zoom
      positionTextEditor()
      setNeedsDisplay()
    }

    public func zoomToFit() {
      guard bounds.width > 0, bounds.height > 0 else { return }
      let content = DrawingImage.contentBounds(of: editor.scene, renderer: renderer)
      let zoom = min(
        1, max(0.1, min((bounds.width - 48) / content.width, (bounds.height - 48) / content.height))
      )
      setViewport(
        DrawingViewport(
          zoom: zoom,
          origin: DrawingPoint(
            content.center.x - bounds.width / (2 * zoom),
            content.center.y - bounds.height / (2 * zoom))))
    }

    public func zoom(by factor: Double) {
      let center = CGPoint(x: bounds.midX, y: bounds.midY)
      let anchor = viewport.viewToScene(center)
      let zoom = min(30, max(0.1, viewport.zoom * factor))
      setViewport(
        DrawingViewport(
          zoom: zoom, origin: DrawingPoint(anchor.x - center.x / zoom, anchor.y - center.y / zoom)))
    }

    public override func draw(_ rect: CGRect) {
      guard let context = UIGraphicsGetCurrentContext() else { return }
      let scene = editor.scene
      DrawingImage.fill(
        background, scene: scene, theme: theme,
        rect: DrawingRect(x: 0, y: 0, width: bounds.width, height: bounds.height), in: context)
      drawGrid(in: context)
      let index = SceneRenderer.Index(
        scene.elements, files: scene.files, framesVisible: editor.framesVisible)
      let active = mode == .editing ? editor.activeElementIds : []
      staticLayer.draw(
        elements: scene.elements, index: index, skipping: active,
        renderer: renderer, viewport: viewport, viewSize: bounds.size,
        scale: Double(window?.screen.scale ?? traitCollection.displayScale), theme: theme,
        canvasBackground: scene.viewBackgroundColor, hairlineZoom: viewport.zoom, in: context)
      if !active.isEmpty {
        context.saveGState()
        viewport.apply(to: context)
        let elements = scene.elements.filter { active.contains($0.id) }.map { element in
          var element = element
          if editor.erasingIds.contains(element.id) { element.opacity *= 0.2 }
          return element
        }
        renderer.draw(
          elements, index: index, in: context, theme: theme,
          canvasBackground: scene.viewBackgroundColor,
          visibleRect: viewport.visibleRect(size: bounds.size),
          zoom: viewport.zoom, skipping: editor.editingTextId.map { [$0] } ?? [])
        context.restoreGState()
      }
      if mode == .editing { drawSelection(in: context) }
    }

    public func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
    ) -> Bool {
      touch.view === self
    }

    public func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      (gestureRecognizer === pinch && otherGestureRecognizer === navigationPan)
        || (gestureRecognizer === navigationPan && otherGestureRecognizer === pinch)
    }

    @objc private func drag(_ recognizer: UIPanGestureRecognizer) {
      let location = recognizer.location(in: self)
      switch recognizer.state {
      case .began:
        navigatesWithOneFinger = mode == .display || editor.tool == .hand
        dragOrigin = viewport.origin
        if !navigatesWithOneFinger {
          let translation = recognizer.translation(in: self)
          let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
          editor.pointerDown(at: viewport.viewToScene(start), modifiers: pointerModifiers)
          editor.pointerDragged(to: viewport.viewToScene(location), modifiers: pointerModifiers)
        }
      case .changed:
        if navigatesWithOneFinger {
          let translation = recognizer.translation(in: self)
          setViewport(
            DrawingViewport(
              zoom: viewport.zoom,
              origin: dragOrigin
                - DrawingPoint(translation.x / viewport.zoom, translation.y / viewport.zoom)))
        } else {
          editor.pointerDragged(to: viewport.viewToScene(location), modifiers: pointerModifiers)
        }
      case .ended:
        if !navigatesWithOneFinger {
          editor.pointerDragged(to: viewport.viewToScene(location), modifiers: pointerModifiers)
          editor.pointerUp(at: viewport.viewToScene(location), modifiers: pointerModifiers)
        }
      case .cancelled, .failed: editor.cancelPointerInteraction()
      default: break
      }
    }

    @objc private func pan(_ recognizer: UIPanGestureRecognizer) {
      switch recognizer.state {
      case .began:
        editor.cancelPointerInteraction()
        endInlineTextEditing()
        panOrigin = viewport.origin
      case .changed:
        // Pinch anchors already incorporate centroid translation when both are active.
        if pinch.state != .began && pinch.state != .changed {
          let delta = recognizer.translation(in: self)
          setViewport(
            DrawingViewport(
              zoom: viewport.zoom,
              origin: panOrigin - DrawingPoint(delta.x / viewport.zoom, delta.y / viewport.zoom)))
        }
      default: break
      }
    }

    @objc private func zoom(_ recognizer: UIPinchGestureRecognizer) {
      let location = recognizer.location(in: self)
      switch recognizer.state {
      case .began:
        editor.cancelPointerInteraction()
        endInlineTextEditing()
        pinchZoom = viewport.zoom
        pinchAnchor = viewport.viewToScene(location)
      case .changed:
        let zoom = min(30, max(0.1, pinchZoom * recognizer.scale))
        setViewport(
          DrawingViewport(
            zoom: zoom,
            origin: DrawingPoint(
              pinchAnchor.x - location.x / zoom, pinchAnchor.y - location.y / zoom)))
      case .ended, .cancelled:
        panOrigin = viewport.origin
        navigationPan.setTranslation(.zero, in: self)
      default: break
      }
    }

    @objc private func tap(_ recognizer: UITapGestureRecognizer) { tap(recognizer, count: 1) }
    @objc private func doubleTap(_ recognizer: UITapGestureRecognizer) { tap(recognizer, count: 2) }
    private func tap(_ recognizer: UITapGestureRecognizer, count: Int) {
      guard mode == .editing, editor.tool != .hand else { return }
      let point = viewport.viewToScene(recognizer.location(in: self))
      editor.pointerDown(at: point, modifiers: pointerModifiers, clickCount: count)
      editor.pointerUp(at: point, modifiers: pointerModifiers)
    }
  }
#endif
