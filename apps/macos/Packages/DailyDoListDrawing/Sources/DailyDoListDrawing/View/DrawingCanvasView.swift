import AppKit
import SwiftUI

/// The drawing canvas, embeddable in the editor: it shows a scene (display mode) or edits it in
/// place (editing mode), with a floating tool bar, a properties popover, Excalidraw's shortcuts
/// and inline text editing.
///
/// - Display mode draws the scene fitted to the view's width and passes mouse and scroll events
///   on (the host selects, moves and resizes the embed).
/// - Editing mode handles the pointer, keys, panning (scroll, space-drag, the hand tool) and
///   zooming (pinch, ⌘-scroll). ``onChange`` reports every committed change; the host saves,
///   debounced. Escape with nothing selected calls ``onEndEditing``.
///
/// Static images for inline display come from ``DrawingPreviewCache`` (cached by content hash).
@MainActor
public final class DrawingCanvasView: NSView {
  public enum Mode: Hashable, Sendable {
    case display
    case editing
  }

  public let editor: DrawingEditor
  let renderer = SceneRenderer()
  let staticLayer = StaticLayerCache()
  public private(set) var viewport = DrawingViewport()

  /// After each committed change: the scene to save.
  public var onChange: ((ExcalidrawScene) -> Void)?
  /// Editing should end (Escape with nothing selected or in progress).
  public var onEndEditing: (() -> Void)?

  public var mode: Mode {
    didSet {
      guard mode != oldValue else { return }
      if mode == .display {
        editor.finishInteraction()
        editor.clearSelection()
        editor.tool = .selection
        endInlineTextEditing()
        zoomToFit()
      }
      updateToolbar()
      window?.invalidateCursorRects(for: self)
      needsDisplay = true
    }
  }

  public var theme: DrawingTheme {
    didSet {
      guard theme != oldValue else { return }
      updateToolbar()
      needsDisplay = true
    }
  }

  /// What's behind the elements (the scene's canvas color by default).
  public var background: DrawingBackground = .scene {
    didSet { needsDisplay = true }
  }

  /// In display mode, keep the drawing fitted to the view as it resizes.
  public var fitsContentInDisplayMode = true

  var toolbarHost: NSHostingView<DrawingToolbar>?
  var textEditor: DrawingTextEditor?
  var trackingArea: NSTrackingArea?
  var isSpaceHeld = false
  var panStart: (view: CGPoint, origin: DrawingPoint)?
  var lastPointer: CGPoint?

  public init(
    scene: ExcalidrawScene, mode: Mode = .display, theme: DrawingTheme = .light,
    environment: DrawingEnvironment = SystemDrawingEnvironment(), frame: NSRect = .zero
  ) {
    self.editor = DrawingEditor(scene: scene, environment: environment)
    self.mode = mode
    self.theme = theme
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
    editor.onInvalidate = { [weak self] in self?.editorDidChange() }
    editor.onChange = { [weak self] scene in self?.onChange?(scene) }
    editor.onBeginTextEditing = { [weak self] id in self?.beginInlineTextEditing(id) }
    zoomToFit()
    updateToolbar()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { mode == .editing }
  public override var isOpaque: Bool { false }

  /// The scene as it is now.
  public var scene: ExcalidrawScene { editor.scene }

  /// Replaces the scene (the file changed on disk).
  public func setScene(_ scene: ExcalidrawScene) {
    endInlineTextEditing()
    editor.replaceScene(scene)
    if mode == .display { zoomToFit() }
    needsDisplay = true
  }

  /// The drawing's size at zoom 1 with Excalidraw's export padding.
  public var preferredSize: CGSize { DrawingImage.preferredSize(of: editor.scene) }

  /// The height that shows the whole drawing at a width.
  public func preferredHeight(forWidth width: CGFloat) -> CGFloat {
    let size = preferredSize
    guard size.width > 0 else { return width }
    return (width * size.height / size.width).rounded(.up)
  }

  public override var intrinsicContentSize: NSSize { preferredSize }

  /// Fits the whole drawing into the view (at most at zoom 1 when it's smaller... unless in
  /// display mode, where it fills the width).
  public func zoomToFit() {
    let bounds = DrawingImage.contentBounds(of: editor.scene, renderer: renderer)
    let size = self.bounds.size
    guard size.width > 0, size.height > 0, bounds.width > 0, bounds.height > 0 else {
      viewport = DrawingViewport(zoom: 1, origin: DrawingPoint(bounds.minX, bounds.minY))
      editor.zoom = 1
      return
    }
    var zoom = min(size.width / bounds.width, size.height / bounds.height)
    if mode == .editing { zoom = min(zoom, 1) }
    let origin = DrawingPoint(
      bounds.center.x - size.width / 2 / zoom, bounds.center.y - size.height / 2 / zoom)
    setViewport(DrawingViewport(zoom: zoom, origin: origin))
  }

  public func setViewport(_ viewport: DrawingViewport) {
    self.viewport = viewport
    editor.zoom = viewport.zoom
    positionTextEditor()
    needsDisplay = true
  }

  public override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    if mode == .display && fitsContentInDisplayMode { zoomToFit() }
    layoutToolbar()
  }

  func editorDidChange() {
    positionTextEditor()
    needsDisplay = true
  }

  // MARK: Drawing

  public override func draw(_ dirtyRect: NSRect) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    let scale = Double(window?.backingScaleFactor ?? layer?.contentsScale ?? 2)
    drawBackground(in: context)
    let scene = editor.scene
    let index = SceneRenderer.Index(scene.elements)
    let active = mode == .editing ? editor.activeElementIds : []
    staticLayer.draw(
      elements: scene.elements, index: index, skipping: active, renderer: renderer,
      viewport: viewport, viewSize: bounds.size, scale: scale, theme: theme,
      canvasBackground: scene.viewBackgroundColor,
      hairlineZoom: mode == .editing ? viewport.zoom : 1,
      in: context)
    if !active.isEmpty {
      context.saveGState()
      viewport.apply(to: context)
      let editing = editor.editingTextId
      let erasing = editor.erasingIds
      let live = scene.elements.filter { active.contains($0.id) && $0.id != editing }.map {
        element in
        var element = element
        if erasing.contains(element.id) { element.opacity = 20 }
        return element
      }
      renderer.draw(
        live, index: index, in: context, theme: theme, canvasBackground: scene.viewBackgroundColor,
        visibleRect: viewport.visibleRect(size: bounds.size), zoom: viewport.zoom,
        skipping: editing.map { [$0] } ?? [])
      context.restoreGState()
    }
    if mode == .editing { drawOverlays(in: context, index: index) }
  }

  func drawBackground(in context: CGContext) {
    let color: CGColor
    switch background {
    case .transparent: return
    case .scene:
      color = DrawingColorCache.shared.cgColor(editor.scene.viewBackgroundColor, theme: theme)
    case .color(let css): color = DrawingColorCache.shared.cgColor(css, theme: .light)
    }
    context.setFillColor(color)
    context.fill(bounds)
  }

  // MARK: Tool bar

  func updateToolbar() {
    if mode == .editing {
      let toolbar = DrawingToolbar(editor: editor, theme: theme)
      if let toolbarHost {
        toolbarHost.rootView = toolbar
      } else {
        let host = NSHostingView(rootView: toolbar)
        host.translatesAutoresizingMaskIntoConstraints = true
        addSubview(host)
        toolbarHost = host
      }
      layoutToolbar()
    } else {
      toolbarHost?.removeFromSuperview()
      toolbarHost = nil
    }
  }

  func layoutToolbar() {
    guard let toolbarHost else { return }
    let size = toolbarHost.fittingSize
    toolbarHost.frame = CGRect(
      x: ((bounds.width - size.width) / 2).rounded(), y: 8, width: size.width, height: size.height)
  }
}
