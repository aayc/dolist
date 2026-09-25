import AppKit
import DailyDoListDrawing

/// Editing a drawing in place: the embed's box becomes a `DrawingCanvasView` in editing mode, with
/// its tool bar floating next to it. The canvas takes the keyboard (vim and the note's shortcuts
/// don't see its keys), the box grows while the drawing does, and every committed change goes to
/// the host (`didEditDrawing`), which saves it. Escape with nothing selected in the drawing, a
/// click outside it or the focus leaving it ends editing.
extension MarkdownEditorController {
  /// Whether a drawing is being edited in place.
  public var isEditingDrawing: Bool { embeds.session != nil }

  /// The path of the drawing being edited in place.
  public var editingDrawingPath: String? { embeds.session?.path }

  /// The canvas of the drawing being edited in place.
  public var drawingCanvas: DrawingCanvasView? { embeds.session?.canvas }

  /// Starts editing the drawing embedded on a 0-based line in place. False when the line isn't a
  /// drawing the host has, or the editor is read-only or in source mode.
  @discardableResult
  public func beginEditingDrawing(atLine line: Int) -> Bool {
    guard configuration.isEditable, livePreview.isEnabled, let embed = embedLine(line),
      let drawing = drawingState(for: embed.spec.target)?.drawing
    else { return false }
    if let session = embeds.session {
      if session.lineStart == embed.lineStart { return true }
      endEditingDrawing(select: false)
    }
    setSelectedEmbed(nil)
    let natural = embeds.naturalSize(of: drawing)
    let shown = EmbedGeometry.size(for: embed.spec, natural: natural, columnWidth: columnWidth)
    let canvas = DrawingCanvasView(scene: drawing.scene, mode: .display, theme: drawingTheme)
    canvas.background = .transparent
    canvas.showsToolbar = false
    // Framed like its preview, so the drawing doesn't jump when editing starts.
    canvas.frame = CGRect(origin: .zero, size: shown)
    let viewport =
      natural == nil ? DrawingViewport(zoom: 1, origin: DrawingPoint(0, 0)) : canvas.viewport
    let session = DrawingEditSession(
      lineStart: embed.lineStart, path: drawing.path, canvas: canvas,
      height: max(EmbedGeometry.minEditingHeight, shown.height), hash: drawing.contentHash)
    embeds.session = session
    canvas.mode = .editing
    canvas.setViewport(viewport)
    canvas.onChange = { [weak self, weak session] scene in
      guard let self, let session else { return }
      self.drawingSession(session, didChange: scene)
    }
    canvas.onEndEditing = { [weak self] in self?.endEditingDrawing(select: true) }
    markdownTextView.addSubview(canvas)
    let toolbar = canvas.makeToolbarView()
    markdownTextView.addSubview(toolbar)
    session.toolbar = toolbar
    invalidateSessionLayout(session)
    if let window = markdownTextView.window {
      window.makeFirstResponder(canvas)
      session.responderObservation = window.observe(\.firstResponder, options: [.new]) {
        [weak self] _, _ in
        Task { @MainActor in self?.endEditingIfFocusLeft() }
      }
    }
    markdownTextView.updateInsertionPointStateAndRestartTimer(true)
    // In place right away (the next draw would be a frame late).
    layoutEmbedsForDrawing()
    return true
  }

  /// Ends editing in place (nothing when no drawing is being edited). `select` leaves the drawing
  /// selected, as after Escape.
  public func endEditingDrawing(select: Bool = false) {
    guard let session = embeds.session else { return }
    session.responderObservation = nil
    let window = markdownTextView.window
    let hadFocus = session.contains(window?.firstResponder)
    // Finishing the drawing's own interaction (text being typed) still reports its change.
    session.canvas.mode = .display
    session.canvas.onChange = nil
    session.canvas.onEndEditing = nil
    embeds.session = nil
    session.canvas.removeFromSuperview()
    session.toolbar?.removeFromSuperview()
    invalidateSessionLayout(session)
    if select {
      let line = highlighter.lineIndex.line(containing: session.lineStart)
      if let embed = embedLine(line), embed.lineStart == session.lineStart {
        embeds.selectedLineStart = embed.lineStart
      }
    }
    delegate?.editor(self, didEndEditingDrawing: session.path)
    if hadFocus { window?.makeFirstResponder(markdownTextView) }
    markdownTextView.updateInsertionPointStateAndRestartTimer(true)
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
  }

  private func endEditingIfFocusLeft() {
    guard let session = embeds.session, let window = markdownTextView.window,
      !session.contains(window.firstResponder)
    else { return }
    endEditingDrawing(select: false)
  }

  /// A committed change in the canvas: every embed of the drawing shows it, the host saves it, and
  /// the box grows to keep the drawing in view.
  func drawingSession(_ session: DrawingEditSession, didChange scene: ExcalidrawScene) {
    let hash = DrawingContentHash.hash(scene)
    session.reportedHash = hash
    let drawing = EditorDrawing(path: session.path, scene: scene, contentHash: hash)
    for (target, state) in embeds.drawings where state?.drawing?.path == session.path {
      embeds.drawings[target] = .some(.ready(drawing))
    }
    delegate?.editor(self, didEditDrawing: drawing)
    let bounds = DrawingImage.contentBounds(of: scene, renderer: session.renderer)
    let bottom = session.canvas.viewport.sceneToView(DrawingPoint(bounds.maxX, bounds.maxY)).y
    let needed = (bottom + 24).rounded(.up)
    if needed > session.height {
      session.height = min(needed, 4000)
      invalidateSessionLayout(session)
    }
  }

  /// The host's drawings changed: a new version of the drawing being edited that came from
  /// elsewhere (merged with ours by the host) replaces the canvas's scene, keeping its history.
  func drawingSessionHostDidChange() {
    guard let session = embeds.session else { return }
    let line = highlighter.lineIndex.line(containing: session.lineStart)
    guard let embed = embedLine(line), embed.lineStart == session.lineStart,
      let drawing = drawingState(for: embed.spec.target)?.drawing, drawing.path == session.path,
      drawing.contentHash != session.reportedHash
    else { return }
    session.reportedHash = drawing.contentHash
    let current = session.canvas.scene.elements
    let incoming = drawing.scene.elements
    let same =
      current.count == incoming.count
      && zip(current, incoming).allSatisfy {
        $0.id == $1.id && $0.version == $1.version && $0.versionNonce == $1.versionNonce
      }
    if !same { session.canvas.setScene(drawing.scene, keepHistory: true) }
  }

  /// Puts the canvas on the embed's box and its tool bar next to it (above, or below when there's
  /// no room above).
  func layoutEditSession() {
    guard let session = embeds.session else { return }
    let line = highlighter.lineIndex.line(containing: session.lineStart)
    guard let embed = embedLine(line), embed.lineStart == session.lineStart,
      let box = embedBoxInView(embed)
    else {
      session.canvas.isHidden = true
      session.toolbar?.isHidden = true
      if embedLine(line)?.lineStart != session.lineStart {
        // The embed's line went away (an undo, a change from elsewhere): so does editing.
        Task { @MainActor [weak self, weak session] in
          guard let self, let session, self.embeds.session === session else { return }
          self.endEditingDrawing()
        }
      }
      return
    }
    session.canvas.isHidden = false
    if session.canvas.frame != box { session.canvas.frame = box }
    guard let toolbar = session.toolbar else { return }
    toolbar.isHidden = false
    let size = toolbar.fittingSize
    let visible = markdownTextView.visibleRect
    let x = min(
      max(box.midX - size.width / 2, visible.minX + 8),
      max(visible.minX + 8, visible.maxX - size.width - 8))
    var y = box.minY - size.height - 8
    if y < visible.minY + 4 { y = box.maxY + 8 }
    let frame = CGRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height)
    if toolbar.frame != frame { toolbar.frame = frame }
  }

  /// The embed's box changed size while editing: re-lay out its line and the floats.
  private func invalidateSessionLayout(_ session: DrawingEditSession) {
    let line = highlighter.lineIndex.line(containing: session.lineStart)
    let range = highlighter.lineIndex.fullRange(ofLine: line, textLength: storage.length)
    if range.length > 0 {
      layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
    }
    embeds.floatsDirty = true
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
    if markdownTextView.window == nil { layoutEmbeds() }
  }

  /// The appearance changed: the canvas and its tool bar follow.
  func drawingSessionAppearanceDidChange() {
    guard let session = embeds.session else { return }
    session.canvas.theme = drawingTheme
    let toolbar = session.canvas.makeToolbarView()
    if let old = session.toolbar {
      toolbar.frame.origin = old.frame.origin
      old.removeFromSuperview()
    }
    markdownTextView.addSubview(toolbar)
    session.toolbar = toolbar
    layoutEditSession()
  }
}
