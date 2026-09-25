import AppKit
import DailyDoListDrawing

/// What the user does with a drawn embed, like the web editor's embed layer (`embeds/widget.ts`):
/// click selects it (without moving the caret, which is hidden meanwhile); dragging shows where it
/// will land and moves its line there; the corner resizes it (the width modifier); Delete removes
/// its line; double-click or Return edits it in place; Escape, the arrows or typing leave it.
/// Moving, resizing and removing are the user's own edits, each one undoable step.
extension MarkdownEditorController {
  // MARK: Selection

  /// The selected embed, if it's still there.
  var selectedEmbed: EmbedLine? {
    guard let start = embeds.selectedLineStart else { return nil }
    let line = highlighter.lineIndex.line(containing: start)
    guard let embed = embedLine(line), embed.lineStart == start else { return nil }
    return embed
  }

  /// The selected drawing's 0-based line.
  public var selectedDrawingLine: Int? { selectedEmbed?.line }

  /// Selects the drawn embed on a line (nil deselects). The caret doesn't move.
  @discardableResult
  public func selectDrawing(atLine line: Int?) -> Bool {
    guard let line else {
      setSelectedEmbed(nil)
      return true
    }
    guard let embed = embedLine(line), isEmbedDrawn(embed) else { return false }
    setSelectedEmbed(embed.lineStart)
    return true
  }

  func setSelectedEmbed(_ lineStart: Int?) {
    guard lineStart != embeds.selectedLineStart else { return }
    embeds.selectedLineStart = lineStart
    markdownTextView.updateInsertionPointStateAndRestartTimer(true)
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
  }

  // MARK: Hit testing

  /// The drawn embed under `point` (text-view coordinates).
  func embed(at point: CGPoint) -> RenderedEmbed? {
    renderedEmbeds(in: CGRect(x: point.x - 1, y: point.y - 1, width: 2, height: 2)).last {
      $0.rect.contains(point)
    }
  }

  /// The selected embed's handle under `point`.
  func embedHandle(at point: CGPoint) -> (embed: EmbedLine, box: CGRect, handle: EmbedHandle)? {
    guard configuration.isEditable, embeds.session == nil, let embed = selectedEmbed,
      let box = embedBoxInView(embed)
    else { return nil }
    for handle in EmbedHandle.handles(for: embed.spec.placement).reversed()
    where handle.hitRect(in: box).contains(point) {
      return (embed, box, handle)
    }
    return nil
  }

  // MARK: Mouse

  /// A mouse down: on a drawn embed it selects it (and starts a possible move or resize, or edits
  /// it on a double click). True when the embed took the click.
  func embedMouseDown(at point: CGPoint, clickCount: Int) -> Bool {
    if let session = embeds.session, !session.canvas.frame.contains(point) {
      endEditingDrawing(select: false)
    }
    if let hit = embedHandle(at: point), hit.handle != .grip {
      embeds.interaction = EmbedInteraction(
        mode: hit.handle == .resizeStart ? .resizeStart : .resizeEnd,
        lineStart: hit.embed.lineStart, start: point, current: point, startBox: hit.box,
        maxWidth: columnWidth, width: hit.box.width)
      return true
    }
    guard let hit = embed(at: point) else {
      setSelectedEmbed(nil)
      return false
    }
    setSelectedEmbed(hit.embed.lineStart)
    if clickCount >= 2 {
      beginEditingDrawing(atLine: hit.embed.line)
      return true
    }
    if configuration.isEditable {
      embeds.interaction = EmbedInteraction(
        mode: .press, lineStart: hit.embed.lineStart, start: point, current: point,
        startBox: hit.rect, maxWidth: columnWidth, width: hit.rect.width)
    }
    return true
  }

  /// The mouse dragged during a press on an embed: past a few points it moves it (showing where
  /// it will land), or resizes it from a corner. True while an embed has the mouse.
  func embedMouseDragged(to point: CGPoint, event: NSEvent?) -> Bool {
    guard var interaction = embeds.interaction else { return false }
    interaction.current = point
    let dx = point.x - interaction.start.x
    let dy = point.y - interaction.start.y
    if interaction.mode == .press, hypot(dx, dy) >= EmbedInteraction.dragThreshold {
      interaction.mode = .move
    }
    switch interaction.mode {
    case .press:
      break
    case .move:
      interaction.target = dropTarget(at: point)
      if let event { markdownTextView.autoscroll(with: event) }
    case .resizeStart, .resizeEnd:
      let delta = interaction.mode == .resizeEnd ? dx : -dx
      let factor: CGFloat =
        selectedEmbed?.spec.placement == .center ? 2 : 1
      interaction.width = min(
        interaction.maxWidth,
        max(EmbedGeometry.minWidth, interaction.startBox.width + delta * factor))
      invalidateEmbedLayout(lineStart: interaction.lineStart)
    }
    embeds.interaction = interaction
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
    return true
  }

  /// The mouse went up: a move or a resize becomes the edit. True when an embed had the mouse.
  func embedMouseUp(at point: CGPoint) -> Bool {
    guard let interaction = embeds.interaction else { return false }
    embeds.interaction = nil
    defer { markdownTextView.setNeedsDisplay(markdownTextView.visibleRect) }
    let line = highlighter.lineIndex.line(containing: interaction.lineStart)
    guard let embed = embedLine(line), embed.lineStart == interaction.lineStart else { return true }
    switch interaction.mode {
    case .press:
      break
    case .move:
      if let target = interaction.target {
        moveEmbed(embed, before: target.before, placement: target.placement)
      }
    case .resizeStart, .resizeEnd:
      invalidateEmbedLayout(lineStart: embed.lineStart)
      resizeEmbed(embed, width: interaction.width)
    }
    return true
  }

  /// Where an embed dragged to `point` (text-view coordinates) would land.
  func dropTarget(at point: CGPoint) -> EmbedDropTarget {
    let origin = markdownTextView.textContainerOrigin
    let index = highlighter.lineIndex
    let length = storage.length
    let lineAt = { (y: CGFloat) -> EmbedEdits.LineBox in
      let local = CGPoint(x: 1, y: max(0, y - origin.y))
      let glyph = self.layoutManager.glyphIndex(for: local, in: self.textContainer)
      let character =
        glyph < self.layoutManager.numberOfGlyphs
        ? self.layoutManager.characterIndexForGlyph(at: glyph) : length
      let line = index.line(containing: character)
      return self.lineBox(line, origin: origin)
    }
    return EmbedEdits.dropTarget(
      at: point, lineAt: lineAt, lineCount: index.count, left: origin.x,
      right: origin.x + columnWidth)
  }

  /// A logical line's extent (all its wrapped fragments), in text-view coordinates.
  private func lineBox(_ line: Int, origin: CGPoint) -> EmbedEdits.LineBox {
    let range = highlighter.lineIndex.contentRange(ofLine: line, textLength: storage.length)
    let first = lineRectInTextView(at: range.location)
    let last = range.length > 0 ? lineRectInTextView(at: range.end - 1) : first
    return EmbedEdits.LineBox(index: line, top: first.minY, bottom: max(first.maxY, last.maxY))
  }

  private func invalidateEmbedLayout(lineStart: Int) {
    let line = highlighter.lineIndex.line(containing: lineStart)
    let range = highlighter.lineIndex.fullRange(ofLine: line, textLength: storage.length)
    if range.length > 0 {
      layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
    }
    embeds.floatsDirty = true
    if markdownTextView.window == nil { layoutEmbeds() }
  }

  // MARK: Edits

  /// Applies an embed edit as one undoable user change, keeping (or moving) the selection on it.
  @discardableResult
  private func performEmbedEdit(
    _ edit: TextEdit, actionName: String, userEvent: String, select lineStart: Int?
  ) -> Bool {
    let wasSelected = embeds.selectedLineStart != nil
    let applied = perform(edit, actionName: actionName, scroll: false, userEvent: userEvent)
    if applied, let lineStart, wasSelected { embeds.selectedLineStart = lineStart }
    embedsNeedLayout()
    if markdownTextView.window == nil { layoutEmbeds() }
    return applied
  }

  @discardableResult
  func moveEmbed(_ embed: EmbedLine, before: Int, placement: DrawingEmbed.Placement) -> Bool {
    guard configuration.isEditable,
      let result = EmbedEdits.move(
        embed, before: before, placement: placement, in: storage.mutableString,
        lineIndex: highlighter.lineIndex, selection: currentSelection)
    else { return false }
    return performEmbedEdit(
      result.edit, actionName: "Move Drawing", userEvent: "move.embed", select: result.lineStart)
  }

  @discardableResult
  func resizeEmbed(_ embed: EmbedLine, width: CGFloat) -> Bool {
    guard configuration.isEditable,
      let result = EmbedEdits.resize(
        embed, width: width, in: storage.mutableString, selection: currentSelection)
    else { return false }
    return performEmbedEdit(
      result.edit, actionName: "Resize Drawing", userEvent: "input.embed",
      select: result.lineStart)
  }

  @discardableResult
  func removeEmbed(_ embed: EmbedLine) -> Bool {
    guard configuration.isEditable else { return false }
    embeds.selectedLineStart = nil
    let edit = EmbedEdits.remove(embed, in: storage.mutableString, selection: currentSelection)
    return performEmbedEdit(
      edit, actionName: "Delete Drawing", userEvent: "delete.embed", select: nil)
  }

  /// Inserts a drawing embed (`![[Drawing 2026-09-25 11.52.33.excalidraw|360|right-wrap]]`) on a
  /// line of its own at the caret's line (on it when it's blank, else above it), as one undoable
  /// edit. Returns the embed's 0-based line, or nil in a read-only editor.
  @discardableResult
  public func insertDrawingEmbed(_ markdown: String) -> Int? {
    guard configuration.isEditable else { return nil }
    endEditingDrawing(select: false)
    setSelectedEmbed(nil)
    let result = EmbedEdits.insert(
      markdown, in: storage.mutableString, caret: textView.selectedRange().location,
      selection: currentSelection)
    guard perform(result.edit, actionName: "Insert Drawing", userEvent: "input.embed") else {
      return nil
    }
    embedsNeedLayout()
    if markdownTextView.window == nil { layoutEmbeds() }
    return highlighter.lineIndex.line(containing: result.lineStart)
  }

  // MARK: Keys

  /// Keys while an embed is selected: Return edits it, Delete removes its line, Escape deselects,
  /// the arrows put the caret on the line before or after it, and anything typed goes to the note
  /// (the embed is deselected first). True when the key was the embed's.
  func handleEmbedKey(_ event: NSEvent) -> Bool {
    guard embeds.session == nil, let embed = selectedEmbed else {
      if embeds.selectedLineStart != nil { setSelectedEmbed(nil) }
      return false
    }
    let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
    if embeds.interaction?.mode.isResize == true || embeds.interaction?.mode == .move {
      if event.keyCode == 53 {
        embeds.interaction = nil
        invalidateEmbedLayout(lineStart: embed.lineStart)
        markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
      }
      return true
    }
    let code = event.keyCode
    let command = flags.contains(.command)
    if code == 36 || code == 76, flags.isEmpty || flags == .shift {
      beginEditingDrawing(atLine: embed.line)
      return true
    }
    if code == 51 || code == 117, !command {
      if configuration.isEditable { removeEmbed(embed) }
      return true
    }
    if code == 53 {
      setSelectedEmbed(nil)
      return true
    }
    if (123...126).contains(code), !command {
      let back = code == 123 || code == 126
      let index = highlighter.lineIndex
      let length = storage.length
      let caret: Int
      if back {
        caret =
          embed.line > 0
          ? index.contentRange(ofLine: embed.line - 1, textLength: length).end : embed.lineStart
      } else {
        caret =
          embed.line + 1 < index.count ? index.start(ofLine: embed.line + 1) : embed.content.end
      }
      setSelectedEmbed(nil)
      setSelection([NSRange(location: caret, length: 0)])
      textView.scrollRangeToVisible(NSRange(location: caret, length: 0))
      return true
    }
    if !command { setSelectedEmbed(nil) }
    return false
  }

  // MARK: Overlays

  /// The selected or hovered embed's outline, its handles, and while dragging where it will land.
  func drawEmbedOverlays(in dirtyRect: CGRect) {
    guard livePreview.isEnabled, !highlighter.embedLines.isEmpty else { return }
    if let line = embeds.hoveredLine, embeds.session == nil, line != selectedEmbed?.line,
      let embed = embedLine(line), let box = embedBoxInView(embed), box.intersects(dirtyRect)
    {
      let path = NSBezierPath(roundedRect: box.insetBy(dx: -0.5, dy: -0.5), xRadius: 6, yRadius: 6)
      EditorColors.separator.setStroke()
      path.lineWidth = 1
      path.stroke()
    }
    guard embeds.session == nil, let embed = selectedEmbed, let box = embedBoxInView(embed) else {
      return
    }
    let interaction = embeds.interaction
    let moving = interaction?.mode == .move
    var shown = box
    if moving, let interaction {
      shown = box.offsetBy(
        dx: interaction.current.x - interaction.start.x,
        dy: interaction.current.y - interaction.start.y)
    }
    let outline = NSBezierPath(roundedRect: shown.insetBy(dx: -1, dy: -1), xRadius: 7, yRadius: 7)
    EditorColors.accent.setStroke()
    outline.lineWidth = 2
    outline.stroke()
    if moving, let interaction {
      drawDragPreview(of: embed, from: box, to: shown)
      if let target = interaction.target { drawDropIndicator(target, box: box) }
      return
    }
    guard configuration.isEditable else { return }
    for handle in EmbedHandle.handles(for: embed.spec.placement) {
      drawHandle(handle, in: shown)
    }
  }

  private func drawHandle(_ handle: EmbedHandle, in box: CGRect) {
    let rect = handle.rect(in: box)
    switch handle {
    case .grip:
      let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 5, yRadius: 5)
      EditorColors.elevated.setFill()
      path.fill()
      EditorColors.separator.setStroke()
      path.lineWidth = 1
      path.stroke()
      EditorColors.secondaryText.setFill()
      for row in 0..<3 {
        for column in 0..<2 {
          let dot = CGRect(
            x: rect.minX + 7 + CGFloat(column) * 6, y: rect.minY + 5 + CGFloat(row) * 5,
            width: 2.4, height: 2.4)
          NSBezierPath(ovalIn: dot).fill()
        }
      }
    case .resizeStart, .resizeEnd:
      EditorColors.background.setFill()
      NSBezierPath(ovalIn: rect).fill()
      EditorColors.accent.setFill()
      NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
    }
  }

  /// The dragged drawing, faded, under the pointer.
  private func drawDragPreview(of embed: EmbedLine, from box: CGRect, to shown: CGRect) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    context.saveGState()
    context.setAlpha(0.75)
    EditorColors.background.setFill()
    NSBezierPath(roundedRect: shown, xRadius: 6, yRadius: 6).fill()
    if let drawing = drawingState(for: embed.spec.target)?.drawing,
      let natural = embeds.naturalSize(of: drawing)
    {
      let target = EmbedGeometry.fit(natural, in: shown)
      let scale = Double(markdownTextView.window?.backingScaleFactor ?? 2)
      if let image = embeds.previews.image(
        for: drawing.scene, contentHash: drawing.contentHash, width: Double(target.width),
        displayScale: scale, theme: drawingTheme, background: .transparent)
      {
        context.translateBy(x: target.minX, y: target.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: target.size))
      }
    }
    context.restoreGState()
  }

  /// Where a dragged embed will land: a line between two lines, and its box on that side.
  private func drawDropIndicator(_ target: EmbedDropTarget, box: CGRect) {
    let origin = markdownTextView.textContainerOrigin
    let left = origin.x
    let column = columnWidth
    EditorColors.accent.setFill()
    CGRect(x: left, y: (target.y - 1).rounded(), width: column, height: 2).fill()
    let width = target.placement == .full ? column : min(box.width, column)
    let height = target.placement == .full ? box.height * column / max(1, box.width) : box.height
    let x = target.placement == .rightWrap ? left + column - width : left
    let preview = CGRect(x: x, y: target.y + 2, width: width, height: height)
    let path = NSBezierPath(roundedRect: preview, xRadius: 6, yRadius: 6)
    EditorColors.accent.withAlphaComponent(0.08).setFill()
    path.fill()
    EditorColors.accent.withAlphaComponent(0.5).setStroke()
    path.setLineDash([4, 3], count: 2, phase: 0)
    path.lineWidth = 1
    path.stroke()
  }

  // MARK: Hover

  /// The pointer moved: the hovered embed's outline, the cursor and the handles' tooltips.
  /// Returns the cursor to show, or nil when the pointer isn't over an embed.
  func embedHover(at point: CGPoint?) -> NSCursor? {
    let hovered = point.flatMap { embed(at: $0) }?.embed.line
    if hovered != embeds.hoveredLine {
      embeds.hoveredLine = hovered
      markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
    }
    guard let point else { return nil }
    if let handle = embedHandle(at: point)?.handle {
      switch handle {
      case .grip: return .openHand
      case .resizeStart, .resizeEnd: return .resizeLeftRight
      }
    }
    guard hovered != nil else { return nil }
    return hovered == selectedEmbed?.line && configuration.isEditable ? .openHand : .arrow
  }
}
