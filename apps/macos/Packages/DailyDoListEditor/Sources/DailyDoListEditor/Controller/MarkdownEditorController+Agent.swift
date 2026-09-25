import AppKit

/// The agent's marks in a note: sparkles ending the lines it wrote, bands behind the lines its
/// threads are anchored to, and hover previews of links (shown in the app's shared tooltip).
extension MarkdownEditorController {
  /// A drawn sparkle (an agent marker hidden by live preview).
  struct AgentSparkle: Equatable {
    /// The marker (with the blanks before it) in the text.
    var marker: NSRange
    /// The thread the marker names; the sparkle isn't clickable without one.
    var threadId: String?
    /// The sparkle's slot, in text-view coordinates.
    var rect: NSRect

    var toolTip: String {
      threadId == nil ? "Written by the agent" : "Written by the agent — open thread"
    }
  }

  // MARK: Agent lines

  /// The agent marker ending the line that holds `offset`, when the agent wrote that line.
  func agentMarker(onLineContaining offset: Int) -> NSRange? {
    let index = highlighter.lineIndex
    let content = index.contentRange(
      ofLine: index.line(containing: offset), textLength: storage.length)
    guard content.length > 0 else { return nil }
    var range = NSRange()
    guard
      let raw = storage.attribute(.ddlMarker, at: content.end - 1, effectiveRange: &range) as? Int,
      MarkerKind(rawValue: raw) == .agent
    else { return nil }
    return range
  }

  /// The thread named by the agent marker `marker`.
  func agentThreadId(ofMarker marker: NSRange) -> String? {
    AgentMarker.scan(storage.mutableString.utf16Units(in: marker))?.threadId
  }

  /// Drawn sparkles intersecting `rect` (default: the visible rect).
  func agentSparkles(in rect: NSRect? = nil) -> [AgentSparkle] {
    guard livePreview.isEnabled, storage.length > 0 else { return [] }
    let origin = markdownTextView.textContainerOrigin
    let area = (rect ?? markdownTextView.visibleRect).offsetBy(dx: -origin.x, dy: -origin.y)
    let glyphs = layoutManager.glyphRange(forBoundingRect: area, in: textContainer)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    var result: [AgentSparkle] = []
    storage.enumerateAttribute(.ddlMarker, in: chars.clamped(to: storage.length)) { value, run, _ in
      guard let raw = value as? Int, MarkerKind(rawValue: raw) == .agent else { return }
      var full = run
      _ = storage.attribute(.ddlMarker, at: run.location, effectiveRange: &full)
      guard full.location == run.location,
        let slot = decorations.slot(forMarker: full, kind: .agent, in: layoutManager)
      else { return }
      result.append(
        AgentSparkle(
          marker: full, threadId: agentThreadId(ofMarker: full),
          rect: slot.rect.offsetBy(dx: origin.x, dy: origin.y)))
    }
    return result
  }

  /// The sparkle under `point`.
  func agentSparkle(at point: NSPoint) -> AgentSparkle? {
    let strip = NSRect(
      x: markdownTextView.textContainerOrigin.x, y: point.y - 1,
      width: textContainer.size.width + 40, height: 2)
    return agentSparkles(in: strip).first { $0.rect.insetBy(dx: -2, dy: -2).contains(point) }
  }

  /// A caret right after an agent marker that live preview hides (clicking past the end of an agent
  /// line, moving onto it) goes before the marker, so typing extends the agent's text instead of
  /// pushing its marker off the end of the line.
  func caretBeforeHiddenAgentMarker(_ caret: Int) -> Int {
    guard caret > 0, let marker = glyphDelegate.hiddenMarker(at: caret - 1), marker.kind == .agent,
      marker.range.end == caret
    else { return caret }
    return marker.range.location
  }

  /// A caret between an agent line's text and the end of its marker, where Enter must start the
  /// next line after the marker (the marker stays on the agent's line): the line end.
  func newlinePosition(forCaret caret: Int) -> Int? {
    guard let marker = agentMarker(onLineContaining: caret), caret >= marker.location,
      caret < marker.end
    else {
      return nil
    }
    return marker.end
  }

  // MARK: Anchored lines

  /// Bands behind the lines threads are anchored to (drawn badges only), in text-view coordinates:
  /// the full text column, a little wider, and as tall as the line's fragments.
  func anchoredLineBands(in rect: NSRect) -> [NSRect] {
    let items = badgeStore.items.filter { $0.badge.highlightsLine && $0.badge.isDrawn }
    guard !items.isEmpty, storage.length > 0 else { return [] }
    let origin = markdownTextView.textContainerOrigin
    let visible = rect.offsetBy(dx: -origin.x, dy: -origin.y)
    let chars = layoutManager.characterRange(
      forGlyphRange: layoutManager.glyphRange(forBoundingRect: visible, in: textContainer),
      actualGlyphRange: nil)
    let pad = (theme.fontSize * 0.5).rounded()
    var bands: [NSRect] = []
    for item in items
    where item.lineEnd >= chars.location && item.anchor <= chars.end && item.anchor < storage.length
    {
      let content = NSRange(item.anchor, max(item.anchor + 1, item.lineEnd)).clamped(
        to: storage.length)
      let glyphs = layoutManager.glyphRange(forCharacterRange: content, actualCharacterRange: nil)
      var band = NSRect.null
      layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { fragment, used, _, _, _ in
        band = band.union(
          NSRect(x: fragment.minX, y: used.minY, width: fragment.width, height: used.height))
      }
      guard !band.isNull else { continue }
      bands.append(
        NSRect(x: band.minX - pad, y: band.minY, width: band.width + 2 * pad, height: band.height)
          .offsetBy(dx: origin.x, dy: origin.y))
    }
    return bands
  }

  /// Draws the anchored-line bands behind the text: a soft accent fill with a 2 pt accent bar at
  /// the left edge.
  func drawAnchoredLines(in dirtyRect: NSRect) {
    for band in anchoredLineBands(in: markdownTextView.visibleRect) where band.intersects(dirtyRect)
    {
      NSGraphicsContext.saveGraphicsState()
      let shape = NSBezierPath(roundedRect: band, xRadius: 4, yRadius: 4)
      shape.addClip()
      EditorColors.anchorBackground.setFill()
      band.fill()
      EditorColors.accent.setFill()
      NSRect(x: band.minX, y: band.minY, width: 2, height: band.height).fill()
      NSGraphicsContext.restoreGraphicsState()
    }
  }

  // MARK: Link previews

  /// The hover preview request for a link (nil for links that are never followed).
  func linkPreview(for link: (target: LinkTarget, range: NSRange)) -> EditorLinkPreview? {
    guard let destination = LinkClassifier.destination(for: link.target) else { return nil }
    let target: EditorLinkPreview.Target =
      switch destination {
      case .external(let url): .external(url)
      case .note(let note, let subpath): .note(target: note, subpath: subpath)
      }
    let threadId = agentMarker(onLineContaining: link.range.location).flatMap(
      agentThreadId(ofMarker:))
    return EditorLinkPreview(
      target: target, label: visibleText(of: link.range), agentThreadId: threadId)
  }

  /// The text of `range` without its markdown syntax (what live preview shows).
  func visibleText(of range: NSRange) -> String {
    let text = storage.mutableString
    var visible = ""
    storage.enumerateAttribute(.ddlMarker, in: range.clamped(to: storage.length)) { value, run, _ in
      if value == nil { visible += text.substring(with: run) }
    }
    return visible.trimmingCharacters(in: .whitespaces)
  }

  /// The tooltip of `link`: the host's preview, else the fallback.
  func linkToolTip(for link: (target: LinkTarget, range: NSRange)) -> String? {
    guard let preview = linkPreview(for: link) else { return nil }
    return delegate?.editor(self, previewFor: preview) ?? preview.fallbackText
  }

  /// The pointer moved onto another link (or off links): lets the host start loading the preview.
  func hoverLinkDidChange(_ link: (target: LinkTarget, range: NSRange)?) {
    guard link?.range != hoveredLinkRange else { return }
    hoveredLinkRange = link?.range
    if let link, let preview = linkPreview(for: link) {
      _ = delegate?.editor(self, previewFor: preview)
    }
  }

  /// The piece of `range` (a link, maybe wrapped over lines) under `point`, in text-view
  /// coordinates: where its tooltip points.
  func linkRect(of range: NSRange, containing point: NSPoint) -> NSRect? {
    guard range.length > 0, range.end <= storage.length else { return nil }
    let origin = markdownTextView.textContainerOrigin
    let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    var found: NSRect?
    layoutManager.enumerateEnclosingRects(
      forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
      in: textContainer
    ) { rect, stop in
      let piece = rect.offsetBy(dx: origin.x, dy: origin.y)
      if piece.width > 0.5, piece.insetBy(dx: -1, dy: -1).contains(point) {
        found = piece
        stop.pointee = true
      }
    }
    return found
  }
}
