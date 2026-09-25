import AppKit
import DailyDoListUI

extension MarkdownEditorController: MarkdownTextViewHooks {
  // MARK: Selection

  /// A caret landing strictly inside hidden syntax (vertical moves, clicks next to a checkbox) is
  /// moved to the edge of the hidden run in the direction of travel; one landing after a hidden
  /// agent marker goes before it.
  func textView(_ textView: MarkdownTextView, adjust proposed: [NSRange], previous: [NSRange])
    -> [NSRange]
  {
    guard !suppressSelectionAdjustment, livePreview.isEnabled, proposed.count == 1,
      let range = proposed.first,
      range.length == 0
    else { return proposed }
    var caret = range.location
    if caret > 0, caret < storage.length, let marker = glyphDelegate.hiddenMarker(at: caret),
      marker.range.location < caret
    {
      let forward = (previous.first?.location ?? 0) <= caret
      caret = forward ? marker.range.end : marker.range.location
    }
    caret = caretBeforeHiddenAgentMarker(caret)
    return caret == range.location ? proposed : [NSRange(location: caret, length: 0)]
  }

  func textViewDidChangeSelection(_ textView: MarkdownTextView, stillSelecting: Bool) {
    guard !stillSelecting else {
      vimHost.textViewSelectionDidChange(stillSelecting: true)
      return
    }
    refreshLivePreview()
    // After live preview re-laid out the lines it reveals (vim's block cursor measures them).
    vimHost.textViewSelectionDidChange(stillSelecting: false)
    guard !replacingText else { return }
    let line = caretLine
    if line != lastReportedLine {
      lastReportedLine = line
      lineNumberRulerNeedsDisplay()
      delegate?.editor(self, cursorDidMoveToLine: line)
    }
    updateTypingAttributes(line: line)
  }

  /// Typed text takes the attributes of its own line (every character of a line shares one
  /// paragraph style). A different paragraph style would make the storage re-fix the whole
  /// paragraph and widen the edit; the highlighter restyles the typed text right away anyway.
  private func updateTypingAttributes(line: Int) {
    let content = highlighter.lineIndex.contentRange(ofLine: line, textLength: storage.length)
    let caret = textView.selectedRange().location
    let source =
      content.length == 0
      ? content.location : min(max(content.location, caret - 1), content.end - 1)
    markdownTextView.typingAttributes =
      source < storage.length
      ? storage.attributes(at: source, effectiveRange: nil) : theme.baseAttributes
  }

  func textViewDidChangeFocus(_ textView: MarkdownTextView) {
    refreshLivePreview()
    vimHost.focusDidChange()
  }

  // MARK: Keys

  func textViewHandleNewline(_ textView: MarkdownTextView) -> Bool {
    guard configuration.isEditable else { return false }
    if let caret = currentSelection.first, currentSelection.count == 1, caret.length == 0,
      let end = newlinePosition(forCaret: caret.location)
    {
      setSelection([NSRange(location: end, length: 0)], adjust: false)
    }
    guard
      let edit = ListCommands.newline(
        in: storage.mutableString, selection: currentSelection, isLiteralLine: isLiteral)
    else { return false }
    return perform(edit, actionName: "Typing")
  }

  func textViewHandleTab(_ textView: MarkdownTextView, backwards: Bool) -> Bool {
    guard configuration.isEditable else { return false }
    let selection = currentSelection
    if backwards {
      return perform(
        ListCommands.outdent(in: storage.mutableString, selection: selection),
        actionName: "Outdent", userEvent: "delete.dedent")
    }
    if selection.allSatisfy({ $0.length == 0 }), let caret = selection.first,
      isLiteral(caret.location)
    {
      return false
    }
    guard let edit = ListCommands.indent(in: storage.mutableString, selection: selection) else {
      return false
    }
    return perform(edit, actionName: "Indent", userEvent: "input.indent")
  }

  func textViewHandleDeleteBackward(_ textView: MarkdownTextView) -> Bool {
    guard configuration.isEditable,
      let edit = ListCommands.deleteMarkupBackward(
        in: storage.mutableString, selection: currentSelection, isLiteralLine: isLiteral)
    else { return false }
    return perform(edit, actionName: "Delete", userEvent: "delete.backward")
  }

  func textView(_ textView: MarkdownTextView, performShortcut event: NSEvent) -> Bool {
    performShortcut(event)
  }

  private func isLiteral(_ offset: Int) -> Bool {
    highlighter.isLiteralLine(highlighter.lineIndex.line(containing: offset))
  }

  // MARK: Mouse

  func textView(
    _ textView: MarkdownTextView, mouseDownAt point: NSPoint, modifiers: NSEvent.ModifierFlags,
    clickCount: Int
  ) -> Bool {
    vimHost.textWasClicked()
    if embedMouseDown(at: point, clickCount: clickCount) { return true }
    return handleClick(at: point, modifiers: modifiers)
  }

  func textView(_ textView: MarkdownTextView, mouseDraggedTo point: NSPoint, event: NSEvent?)
    -> Bool
  {
    embedMouseDragged(to: point, event: event)
  }

  func textView(_ textView: MarkdownTextView, mouseUpAt point: NSPoint) -> Bool {
    embedMouseUp(at: point)
  }

  func textView(_ textView: MarkdownTextView, willShowMenu menu: NSMenu) {
    delegate?.editor(self, willShowContextMenu: menu)
  }

  func textViewDidChangeAppearance(_ textView: MarkdownTextView) {
    drawingSessionAppearanceDidChange()
    if !highlighter.embedLines.isEmpty { textView.setNeedsDisplay(textView.visibleRect) }
  }

  /// Badge → `didClickBadge`; checkbox → toggle; sparkle → `didClickAgentThread`; link → follow
  /// (⌘-click always, plain click when its syntax is hidden). Returns false to let the text view
  /// handle the click.
  @discardableResult
  func handleClick(at point: NSPoint, modifiers: NSEvent.ModifierFlags) -> Bool {
    if let layout = badgeLayout(at: point) {
      var badge = layout.badge
      badge.line = highlighter.lineIndex.line(containing: layout.anchor)
      delegate?.editor(self, didClickBadge: badge)
      return true
    }
    if let line = checkboxLine(at: point) {
      if configuration.isEditable { toggleTask(atLine: line) }
      return true
    }
    if let threadId = agentSparkle(at: point)?.threadId {
      delegate?.editor(self, didClickAgentThread: threadId)
      return true
    }
    let command = modifiers.contains(.command)
    if let link = link(at: point), command || isRendered(link.range) {
      follow(link.target, newWindow: command)
      return true
    }
    return false
  }

  func textView(
    _ textView: MarkdownTextView, mouseMovedTo point: NSPoint?, modifiers: NSEvent.ModifierFlags
  ) {
    let layout = point.flatMap { badgeLayout(at: $0) }
    if layout?.badge.id != hoveredBadgeID {
      for rect in drawnBadgeRects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
      hoveredBadgeID = layout?.badge.id
    }
    let sparkle = point.flatMap { agentSparkle(at: $0) }.flatMap { $0.threadId == nil ? nil : $0 }
    if sparkle?.marker.location != decorations.hoveredSparkle {
      for rect in drawnSparkleRects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
      decorations.hoveredSparkle = sparkle?.marker.location
    }
    let embedCursor = embedHover(at: point)
    guard let point else {
      hoverLinkDidChange(nil)
      hoverTooltip(nil)
      return
    }
    let hoveredLink = link(at: point)
    hoverLinkDidChange(hoveredLink)
    hoverTooltip(tooltipAnchor(at: point, badge: layout, link: hoveredLink))
    if let embedCursor {
      embedCursor.set()
      return
    }
    var clickable = layout != nil || sparkle != nil
    if !clickable, configuration.isEditable { clickable = checkboxLine(at: point) != nil }
    if !clickable, let hoveredLink {
      clickable = modifiers.contains(.command) || isRendered(hoveredLink.range)
    }
    (clickable ? NSCursor.pointingHand : NSCursor.iBeam).set()
  }

  /// The tooltip text of what's under `point`: a badge, a sparkle or a link.
  func textView(_ textView: MarkdownTextView, toolTipAt point: NSPoint) -> String? {
    tooltipAnchor(at: point, badge: badgeLayout(at: point), link: link(at: point))?.text()
  }

  // MARK: Tooltips

  /// A thing under the pointer with a tooltip, and where it is (text-view coordinates).
  struct TooltipAnchor {
    enum Key: Hashable {
      case badge(String)
      case sparkle(Int)
      case link(NSRange)
      case embedHandle(Int, EmbedHandle)
    }

    var key: Key
    var rect: NSRect
    /// Read when the tooltip shows, so it's current (a link preview that finished loading).
    var text: @MainActor () -> String?
  }

  func tooltipAnchor(
    at point: NSPoint, badge: BadgeRenderer.Layout?, link: (target: LinkTarget, range: NSRange)?
  ) -> TooltipAnchor? {
    if let hit = embedHandle(at: point) {
      let text = hit.handle.tooltip
      return TooltipAnchor(
        key: .embedHandle(hit.embed.lineStart, hit.handle), rect: hit.handle.rect(in: hit.box)
      ) { text }
    }
    if let badge {
      let id = badge.badge.id
      return TooltipAnchor(key: .badge(id), rect: badge.rect) { [weak self] in
        let current = self?.badgeStore.items.first { $0.badge.id == id }?.badge ?? badge.badge
        return BadgeRenderer.toolTip(for: current)
      }
    }
    if let sparkle = agentSparkle(at: point) {
      return TooltipAnchor(key: .sparkle(sparkle.marker.location), rect: sparkle.rect) {
        sparkle.toolTip
      }
    }
    if let link, let rect = linkRect(of: link.range, containing: point) {
      return TooltipAnchor(key: .link(link.range), rect: rect) { [weak self] in
        self?.linkToolTip(for: link)
      }
    }
    return nil
  }

  /// The pointer moved onto another thing with a tooltip (or off them): the shared tooltip follows,
  /// gliding straight from one to the next.
  func hoverTooltip(_ anchor: TooltipAnchor?) {
    if let anchor, let hovered = hoveredTooltip, hovered.key == anchor.key {
      hovered.region.rect = anchor.rect
      return
    }
    let previous = hoveredTooltip
    hoveredTooltip = nil
    if let anchor {
      let region = TooltipRegion(view: markdownTextView, rect: anchor.rect) {
        anchor.text().flatMap(TooltipContent.init(multilineText:))
      }
      hoveredTooltip = (anchor.key, region)
      tooltipCenter.pointerEntered(region)
    }
    if let previous { tooltipCenter.pointerExited(previous.region) }
  }

  /// The document or its badges changed under a hovered badge: it follows (or goes away).
  func badgesDidChangeUnderTooltip() {
    guard let hovered = hoveredTooltip, case .badge(let id) = hovered.key else { return }
    if badgeStore.items.contains(where: { $0.badge.id == id && $0.badge.isDrawn }) {
      tooltipCenter.targetChanged(hovered.region)
    } else {
      hoveredTooltip = nil
      tooltipCenter.targetRemoved(hovered.region)
    }
  }

  /// A new document: nothing that was hovered is there anymore.
  func dropHoveredTooltip() {
    guard let hovered = hoveredTooltip else { return }
    hoveredTooltip = nil
    tooltipCenter.targetRemoved(hovered.region)
  }

  // MARK: Drawing and geometry

  /// Before each draw: redraw badges that moved, note where sparkles are (hover redraws), and keep
  /// the pulse of a triaging badge in view going.
  func textViewWillDraw(_ textView: MarkdownTextView) {
    layoutEmbedsForDrawing()
    let layouts = currentBadgeLayouts()
    motion.willDraw(pulseVisible: layouts.contains { self.motion.state.isPulsing($0.badge.id) })
    let rects = layouts.map(\.rect)
    if rects != drawnBadgeRects {
      for rect in drawnBadgeRects + rects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
      drawnBadgeRects = rects
    }
    drawnSparkleRects = agentSparkles().map(\.rect)
  }

  func textView(_ textView: MarkdownTextView, drawBackgroundIn rect: NSRect) {
    drawAnchoredLines(in: rect)
    drawEmbeds(in: rect)
  }

  func textView(_ textView: MarkdownTextView, drawOverlaysIn dirtyRect: NSRect) {
    drawEmbedOverlays(in: dirtyRect)
    vimHost.drawOverlays(in: dirtyRect)
    guard !badgeStore.isEmpty else { return }
    let layouts = currentBadgeLayouts()
    guard !motion.state.isIdle else {
      badgeRenderer.draw(layouts, hovered: hoveredBadgeID, dirtyRect: dirtyRect)
      return
    }
    let motion = self.motion
    let now = motion.now
    badgeRenderer.draw(layouts, hovered: hoveredBadgeID, dirtyRect: dirtyRect) {
      motion.paint(for: $0.badge, now: now)
    }
  }

  /// Back on screen: redrawing the badges resumes a pulse (frames stop by themselves when hidden).
  func textViewDidChangeOcclusion(_ textView: MarkdownTextView) {
    guard motion.state.hasPulses, !motion.isTicking, motion.canAnimate else { return }
    for rect in drawnBadgeRects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
  }

  func textViewDidChangeWidth(_ textView: MarkdownTextView) {
    updateTextGeometry()
    embedsNeedLayout()
    vimHost.layoutDidChange()
  }

  // MARK: Vim

  func textView(_ textView: MarkdownTextView, handleKeyDown event: NSEvent) -> Bool {
    if handleEmbedKey(event) { return true }
    return vimHost.handleKeyDown(event)
  }

  func textView(_ textView: MarkdownTextView, claimsKeyEquivalent event: NSEvent) -> Bool {
    vimHost.claimsKeyEquivalent(event)
  }

  func textView(_ textView: MarkdownTextView, willReplace ranges: [NSRange], with strings: [String])
    -> Bool
  {
    vimHost.willReplace(ranges, with: strings)
  }

  func textViewDidRefuseChange(_ textView: MarkdownTextView) {
    vimHost.changeWasRefused()
  }

  func textView(_ textView: MarkdownTextView, edit userEvent: String, _ body: () -> Void) {
    // In vim mode the text view registers nothing (not even action names outside a group): vim's
    // history records the edit (`VimUndoRecorder`).
    let manager = noteUndoManager
    let recordsItself = vimHost.isAttached
    if recordsItself { manager.disableUndoRegistration() }
    beginEditorOperation(userEvent: userEvent)
    body()
    endEditorOperation()
    if recordsItself { manager.enableUndoRegistration() }
  }

  func textView(_ textView: MarkdownTextView, insertAtEveryCursor text: String) -> Bool {
    vimHost.insertAtEveryCursor(text)
  }

  func textView(_ textView: MarkdownTextView, deleteAtEveryCursor forward: Bool) -> Bool {
    vimHost.deleteAtEveryCursor(forward: forward)
  }

  func textViewWillPaste(_ textView: MarkdownTextView) -> Bool {
    vimHost.willPaste()
  }

  func textViewDrawsInsertionPoint(_ textView: MarkdownTextView) -> Bool {
    !vimHost.drawsBlockCursor && embeds.selectedLineStart == nil && embeds.session == nil
  }

  // MARK: Hit testing

  /// Layouts of the badges in the visible part of the document.
  func currentBadgeLayouts() -> [BadgeRenderer.Layout] {
    guard !badgeStore.isEmpty else { return [] }
    return badgeRenderer.layouts(
      for: badgeStore.items, in: markdownTextView, layoutManager: layoutManager,
      visibleRect: markdownTextView.visibleRect)
  }

  func badgeLayout(at point: NSPoint) -> BadgeRenderer.Layout? {
    currentBadgeLayouts().last { $0.rect.insetBy(dx: -2, dy: -2).contains(point) }
  }

  /// Rendered checkboxes intersecting `rect` (default: the visible rect): 0-based line and square,
  /// in text-view coordinates.
  func checkboxRects(in rect: NSRect? = nil) -> [(line: Int, rect: NSRect)] {
    guard livePreview.isEnabled, storage.length > 0 else { return [] }
    let origin = markdownTextView.textContainerOrigin
    let area = (rect ?? markdownTextView.visibleRect).offsetBy(dx: -origin.x, dy: -origin.y)
    let glyphs = layoutManager.glyphRange(forBoundingRect: area, in: textContainer)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    var result: [(line: Int, rect: NSRect)] = []
    storage.enumerateAttribute(.ddlMarker, in: chars.clamped(to: storage.length)) { value, run, _ in
      guard let raw = value as? Int, MarkerKind(rawValue: raw) == .task else { return }
      var full = run
      _ = storage.attribute(.ddlMarker, at: run.location, effectiveRange: &full)
      guard full.location == run.location,
        let slot = decorations.slot(forMarker: full, kind: .task, in: layoutManager)
      else { return }
      let box = decorations.checkboxRect(
        inSlot: slot.rect, baseline: slot.baseline, font: slot.font)
      result.append(
        (
          highlighter.lineIndex.line(containing: full.location),
          box.offsetBy(dx: origin.x, dy: origin.y)
        ))
    }
    return result
  }

  /// The line of the checkbox under `point`, if any.
  func checkboxLine(at point: NSPoint) -> Int? {
    let origin = markdownTextView.textContainerOrigin
    let strip = NSRect(x: origin.x, y: point.y - 1, width: textContainer.size.width, height: 2)
    return checkboxRects(in: strip).first { $0.rect.insetBy(dx: -3, dy: -3).contains(point) }?.line
  }

  /// The link whose visible text is under `point`.
  func link(at point: NSPoint) -> (target: LinkTarget, range: NSRange)? {
    guard storage.length > 0 else { return nil }
    let origin = markdownTextView.textContainerOrigin
    let local = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
    let glyph = layoutManager.glyphIndex(
      for: local, in: textContainer, fractionOfDistanceThroughGlyph: nil)
    guard glyph < layoutManager.numberOfGlyphs else { return nil }
    let bounds = layoutManager.boundingRect(
      forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
    guard bounds.insetBy(dx: -1, dy: -1).contains(local) else { return nil }
    let index = layoutManager.characterIndexForGlyph(at: glyph)
    var range = NSRange()
    guard index < storage.length,
      let attribute = storage.attribute(.ddlLink, at: index, effectiveRange: &range)
        as? LinkAttribute
    else { return nil }
    return (attribute.target, range)
  }

  /// Whether a link shows rendered (its syntax hidden), so a plain click follows it.
  func isRendered(_ range: NSRange) -> Bool {
    livePreview.isEnabled && !livePreview.isLineRevealed(containing: range.location)
  }

  func follow(_ target: LinkTarget, newWindow: Bool) {
    guard let destination = LinkClassifier.destination(for: target) else { return }
    switch destination {
    case .external(let url):
      delegate?.editor(self, didClickLink: url)
    case .note(let note, _):
      delegate?.editor(self, didClickWikiLink: note, newWindow: newWindow)
    }
  }
}
