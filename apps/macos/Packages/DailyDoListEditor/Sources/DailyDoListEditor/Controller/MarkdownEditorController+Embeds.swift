import AppKit
import DailyDoListDrawing

/// Drawing embeds in live preview: a line that is one `![[Plan.excalidraw|360|right-wrap]]` is
/// drawn as the drawing unless the selection is on it (then its syntax shows, as in source mode).
///
/// - A float (`left-wrap`, `right-wrap`) takes no height itself; its box is an exclusion path of
///   the text container, so the lines after it wrap around it. Floats are laid out top to bottom
///   (one that would overlap an earlier one goes below it) and only recomputed when something may
///   have moved them: an edit above them, a reveal, a drawing or the column changing. Never per
///   keystroke otherwise.
/// - Every other embed sits on a row of its own: the layout delegate gives its line fragment the
///   drawing's height (below any float it would overlap).
/// - Previews are rendered when drawn, cached by the drawing's content hash, width and theme; a
///   drawing's size is measured once per version.
extension MarkdownEditorController {
  // MARK: Model

  /// The drawing embed on a 0-based line, if the line is one.
  func embedLine(_ line: Int) -> EmbedLine? {
    guard highlighter.isEmbedLine(line) else { return nil }
    let content = highlighter.lineIndex.contentRange(ofLine: line, textLength: storage.length)
    guard content.length > 0,
      let spec = embeds.spec(forLine: storage.mutableString.substring(with: content))
    else { return nil }
    return EmbedLine(line: line, content: content, spec: spec)
  }

  /// What the host says about the drawing `target` names (asked once until `drawingsDidChange`).
  func drawingState(for target: String) -> EditorDrawingState? {
    if let known = embeds.drawings[target] { return known }
    guard let delegate else { return nil }
    let state = delegate.editor(self, drawingFor: target)
    embeds.drawings[target] = .some(state)
    return state
  }

  /// Whether the embed on the line holding `offset` is drawn when its line is hidden.
  func drawsEmbed(at offset: Int) -> Bool {
    let line = highlighter.lineIndex.line(containing: offset)
    guard let embed = embedLine(line) else { return false }
    return drawingState(for: embed.spec.target) != nil
  }

  /// Whether the embed shows as its drawing right now (live preview, the host shows drawings, the
  /// selection isn't on its line).
  func isEmbedDrawn(_ embed: EmbedLine) -> Bool {
    livePreview.isHidden(.embed, range: embed.content)
  }

  var columnWidth: CGFloat {
    max(1, textContainer.size.width - 2 * textContainer.lineFragmentPadding)
  }

  /// The drawing's box size (the editing height while it's edited in place, the dragged width
  /// while it's resized).
  func embedSize(_ embed: EmbedLine) -> CGSize {
    let natural = drawingState(for: embed.spec.target)?.drawing.flatMap {
      embeds.naturalSize(of: $0)
    }
    var spec = embed.spec
    if let interaction = embeds.interaction, interaction.mode.isResize,
      interaction.lineStart == embed.lineStart
    {
      if let height = spec.height, let width = spec.width, width > 0 {
        spec.height = height * Double(interaction.width) / width
      }
      spec.width = Double(interaction.width)
      spec.widthPercent = nil
    }
    var size = EmbedGeometry.size(for: spec, natural: natural, columnWidth: columnWidth)
    if let session = embeds.session, session.lineStart == embed.lineStart {
      size.height = max(size.height, session.height)
    }
    return size
  }

  /// The line fragment that holds the embed's line (text-container coordinates).
  func fragmentRect(atCharacter offset: Int) -> CGRect {
    let glyph = layoutManager.glyphIndexForCharacter(at: min(offset, max(0, storage.length - 1)))
    return layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
  }

  /// The drawing's box in text-container coordinates, while it's drawn.
  func embedBox(_ embed: EmbedLine) -> CGRect? {
    guard isEmbedDrawn(embed) else { return nil }
    if embed.spec.placement.wraps {
      return embeds.floats.first { $0.line == embed.line }?.box
    }
    let size = embedSize(embed)
    let fragment = fragmentRect(atCharacter: embed.lineStart)
    // At the bottom of its line: a line that starts next to a float is taller, not moved.
    return CGRect(
      x: EmbedGeometry.x(for: embed.spec.placement, width: size.width, columnWidth: columnWidth),
      y: fragment.maxY - EmbedGeometry.rowMargin - size.height, width: size.width,
      height: size.height)
  }

  /// `embedBox` in text-view coordinates.
  func embedBoxInView(_ embed: EmbedLine) -> CGRect? {
    let origin = markdownTextView.textContainerOrigin
    return embedBox(embed)?.offsetBy(dx: origin.x, dy: origin.y)
  }

  // MARK: Layout

  /// From the layout delegate: the line fragment of a drawn embed's line. A float takes no
  /// height; any other embed takes its drawing's height, below floats above it that it would
  /// overlap (the fragment grows rather than moves, which TextKit's layout keeps consistent).
  func embedFragment(at index: Int, proposed: CGRect) -> CGRect? {
    let line = highlighter.lineIndex.line(containing: index)
    guard let embed = embedLine(line), embed.lineStart == index else { return nil }
    if embed.spec.placement.wraps {
      return CGRect(x: proposed.minX, y: proposed.minY, width: proposed.width, height: 0)
    }
    let size = embedSize(embed)
    let column = columnWidth
    let x = EmbedGeometry.x(for: embed.spec.placement, width: size.width, columnWidth: column)
    let height = size.height + 2 * EmbedGeometry.rowMargin
    var top = proposed.minY
    var moved = true
    while moved {
      moved = false
      for float in embeds.floats where float.line < line {
        let row = CGRect(x: x, y: top, width: size.width, height: height)
        if float.exclusion.intersects(row) {
          top = float.exclusion.maxY
          moved = true
        }
      }
    }
    return CGRect(x: 0, y: proposed.minY, width: column, height: top - proposed.minY + height)
  }

  /// Lays out the floats the text wraps around, down to character `limit`, and updates the
  /// container's exclusion paths when they moved. Converges in a few passes: a float's line may
  /// move when a float above it does.
  func updateFloats(through limit: Int) {
    guard embeds.floatsDirty || limit > embeds.floatLimit else { return }
    embeds.floatsDirty = false
    embeds.floatLimit = limit
    // A float is placed where its line is, so lines must be laid out where they really are:
    // non-contiguous layout would place a float's line at an estimate before the text above it.
    let contiguous = hasDrawnFloats()
    if layoutManager.allowsNonContiguousLayout == contiguous {
      layoutManager.allowsNonContiguousLayout = !contiguous
    }
    for _ in 0..<8 {
      var floats = computeFloats(through: limit)
      // Floats below what's laid out stay until they scroll into view (recomputing them would
      // lay out everything above them; dropping them would re-lay out the text for nothing).
      let limitLine = highlighter.lineIndex.line(containing: limit)
      floats += embeds.floats.filter { $0.line > limitLine }
      guard floats != embeds.floats else { return }
      embeds.floats = floats
      embeds.exclusionUpdates += 1
      textContainer.exclusionPaths = floats.map { NSBezierPath(rect: $0.exclusion) }
    }
  }

  private func hasDrawnFloats() -> Bool {
    guard livePreview.isEnabled else { return false }
    return highlighter.embedLines.contains { line in
      guard let embed = embedLine(line) else { return false }
      return embed.spec.placement.wraps && isEmbedDrawn(embed)
    }
  }

  private func computeFloats(through limit: Int) -> [EmbedFloat] {
    guard livePreview.isEnabled else { return [] }
    let index = highlighter.lineIndex
    let column = columnWidth
    var floats: [EmbedFloat] = []
    for line in highlighter.embedLines {
      guard index.start(ofLine: line) <= limit else { break }
      guard let embed = embedLine(line), embed.spec.placement.wraps, isEmbedDrawn(embed) else {
        continue
      }
      let size = embedSize(embed)
      let top = fragmentRect(atCharacter: embed.lineStart).minY
      var box = CGRect(
        x: EmbedGeometry.x(for: embed.spec.placement, width: size.width, columnWidth: column),
        y: top + EmbedGeometry.floatTop, width: size.width, height: size.height)
      var moved = true
      while moved {
        moved = false
        for other in floats {
          let exclusion = EmbedGeometry.exclusion(
            forFloat: box, placement: embed.spec.placement, columnWidth: column)
          if other.exclusion.intersects(exclusion.insetBy(dx: 0.5, dy: 0.5)) {
            box.origin.y = other.exclusion.maxY + EmbedGeometry.floatTop
            moved = true
          }
        }
      }
      floats.append(
        EmbedFloat(
          line: line, box: box,
          exclusion: EmbedGeometry.exclusion(
            forFloat: box, placement: embed.spec.placement, columnWidth: column)))
    }
    return floats
  }

  /// Before a draw: floats down to the end of what's visible, and the canvas of a drawing being
  /// edited where its box is now.
  func layoutEmbedsForDrawing() {
    guard !highlighter.embedLines.isEmpty || !embeds.floats.isEmpty else { return }
    let origin = markdownTextView.textContainerOrigin
    let visible = markdownTextView.visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
    let glyphs = layoutManager.glyphRange(forBoundingRect: visible, in: textContainer)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    updateFloats(through: chars.end)
    layoutEditSession()
  }

  /// Floats for the whole document (offscreen editors and tests have no draw pass).
  func layoutEmbeds() {
    updateFloats(through: storage.length)
    layoutEditSession()
  }

  /// Something may have moved or resized floats: recompute them before the next draw.
  func embedsNeedLayout() {
    guard !highlighter.embedLines.isEmpty || !embeds.floats.isEmpty else { return }
    embeds.floatsDirty = true
    markdownTextView.needsDisplay = true
  }

  /// After a character edit: follow the selected and edited embeds, and recompute floats when the
  /// edit was above one (or changed embed lines).
  func embedsDidEdit(location: Int, oldLength: Int, newLength: Int) {
    let text = storage.mutableString
    if let selected = embeds.selectedLineStart {
      embeds.selectedLineStart = EmbedState.remap(
        selected, location: location, oldLength: oldLength, newLength: newLength, text: text)
    }
    if let session = embeds.session {
      if let start = EmbedState.remap(
        session.lineStart, location: location, oldLength: oldLength, newLength: newLength,
        text: text)
      {
        session.lineStart = start
      }
    }
    guard !highlighter.embedLines.isEmpty || !embeds.floats.isEmpty else { return }
    // An edit below every embed line can't move a float.
    let lastEmbed = highlighter.embedLines.last.map {
      highlighter.lineIndex.fullRange(ofLine: $0, textLength: storage.length).end
    }
    if highlighter.embedLinesChanged || location < (lastEmbed ?? -1) {
      embeds.floatsDirty = true
    }
  }

  /// A new document: nothing about the previous one's embeds applies.
  func resetEmbeds() {
    endEditingDrawing(select: false)
    embeds.reset()
    if !textContainer.exclusionPaths.isEmpty { textContainer.exclusionPaths = [] }
    if !layoutManager.allowsNonContiguousLayout { layoutManager.allowsNonContiguousLayout = true }
  }

  // MARK: Host

  /// The host's drawings changed (loaded, edited elsewhere, created, deleted): embeds ask again,
  /// re-lay out the ones whose drawing changed, and a drawing being edited in place takes a new
  /// version that came from somewhere else.
  public func drawingsDidChange() {
    let previous = embeds.drawings
    embeds.drawings.removeAll()
    var changed: [NSRange] = []
    for line in highlighter.embedLines {
      guard let embed = embedLine(line) else { continue }
      let before: EditorDrawingState? = previous[embed.spec.target] ?? nil
      let now = drawingState(for: embed.spec.target)
      if before != now {
        changed.append(
          highlighter.lineIndex.fullRange(ofLine: line, textLength: storage.length))
      }
    }
    if !changed.isEmpty {
      invalidateGlyphs(in: changed)
      embeds.floatsDirty = true
    }
    drawingSessionHostDidChange()
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
  }

  // MARK: Drawing

  /// A drawn embed and where it is (text-view coordinates).
  struct RenderedEmbed {
    var embed: EmbedLine
    var rect: CGRect
    var state: EditorDrawingState
  }

  /// The embeds drawn in `rect` (text-view coordinates), floats first.
  func renderedEmbeds(in rect: CGRect) -> [RenderedEmbed] {
    guard livePreview.isEnabled, !highlighter.embedLines.isEmpty, storage.length > 0 else {
      return []
    }
    let origin = markdownTextView.textContainerOrigin
    var result: [RenderedEmbed] = []
    for float in embeds.floats {
      let box = float.box.offsetBy(dx: origin.x, dy: origin.y)
      guard box.intersects(rect), let embed = embedLine(float.line), embed.spec.placement.wraps,
        isEmbedDrawn(embed), let state = drawingState(for: embed.spec.target)
      else { continue }
      result.append(RenderedEmbed(embed: embed, rect: box, state: state))
    }
    let area = rect.offsetBy(dx: -origin.x, dy: -origin.y)
    let glyphs = layoutManager.glyphRange(forBoundingRect: area, in: textContainer)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    let index = highlighter.lineIndex
    let first = index.line(containing: chars.location)
    let last = index.line(containing: chars.end)
    for line in highlighter.embedLines where line >= first && line <= last {
      guard let embed = embedLine(line), !embed.spec.placement.wraps,
        let box = embedBoxInView(embed), box.intersects(rect),
        let state = drawingState(for: embed.spec.target)
      else { continue }
      result.append(RenderedEmbed(embed: embed, rect: box, state: state))
    }
    return result
  }

  /// The theme drawings are rendered in: the editor's appearance.
  var drawingTheme: DrawingTheme {
    markdownTextView.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      ? .dark : .light
  }

  /// Draws the drawn embeds in `dirtyRect` (behind the text, which never overlaps them).
  func drawEmbeds(in dirtyRect: CGRect) {
    let items = renderedEmbeds(in: dirtyRect)
    guard !items.isEmpty, let context = NSGraphicsContext.current?.cgContext else { return }
    let scale = Double(markdownTextView.window?.backingScaleFactor ?? 2)
    let theme = drawingTheme
    for item in items {
      if embeds.session?.lineStart == item.embed.lineStart {
        drawEditingFrame(item.rect)
        continue
      }
      switch item.state {
      case .ready(let drawing):
        guard let natural = embeds.naturalSize(of: drawing) else {
          drawPlaceholder(
            item.rect,
            text: configuration.isEditable
              ? "Empty drawing · double-click to draw" : "Empty drawing")
          continue
        }
        let target = EmbedGeometry.fit(natural, in: item.rect)
        guard
          let image = embeds.previews.image(
            for: drawing.scene, contentHash: drawing.contentHash, width: Double(target.width),
            displayScale: scale, theme: theme, background: .transparent)
        else { continue }
        context.saveGState()
        context.translateBy(x: target.minX, y: target.maxY)
        context.scaleBy(x: 1, y: -1)
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(origin: .zero, size: target.size))
        context.restoreGState()
      case .loading:
        drawPlaceholder(item.rect, text: nil)
      case .missing:
        drawPlaceholder(item.rect, text: "“\(item.embed.spec.name)” doesn't exist")
      case .unreadable:
        drawPlaceholder(item.rect, text: "This drawing can't be read")
      }
    }
  }

  private func drawPlaceholder(_ rect: CGRect, text: String?) {
    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
    EditorColors.codeBackground.setFill()
    path.fill()
    guard let text else { return }
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 13), .foregroundColor: EditorColors.secondaryText,
      .paragraphStyle: paragraph,
    ]
    let box = rect.insetBy(dx: 8, dy: 6)
    let options: NSString.DrawingOptions = [.usesLineFragmentOrigin, .truncatesLastVisibleLine]
    let needed = (text as NSString).boundingRect(
      with: box.size, options: options, attributes: attributes)
    let height = min(box.height, ceil(needed.height))
    (text as NSString).draw(
      with: CGRect(x: box.minX, y: box.midY - height / 2, width: box.width, height: height),
      options: options, attributes: attributes)
  }

  private func drawEditingFrame(_ rect: CGRect) {
    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
    EditorColors.codeBackground.withAlphaComponent(0.5).setFill()
    path.fill()
    EditorColors.accent.setStroke()
    path.lineWidth = 1
    path.stroke()
  }
}
