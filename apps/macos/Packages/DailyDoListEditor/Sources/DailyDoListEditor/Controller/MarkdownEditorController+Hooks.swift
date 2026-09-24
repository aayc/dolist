import AppKit

extension MarkdownEditorController: MarkdownTextViewHooks {
  // MARK: Selection

  /// A caret landing strictly inside hidden syntax (vertical moves, clicks next to a checkbox) is
  /// moved to the edge of the hidden run in the direction of travel.
  func textView(_ textView: MarkdownTextView, adjust proposed: [NSRange], previous: [NSRange]) -> [NSRange] {
    guard !suppressSelectionAdjustment, livePreview.isEnabled, proposed.count == 1, let range = proposed.first,
      range.length == 0
    else { return proposed }
    let caret = range.location
    guard caret > 0, caret < storage.length, let marker = glyphDelegate.hiddenMarker(at: caret),
      marker.range.location < caret
    else { return proposed }
    let forward = (previous.first?.location ?? 0) <= caret
    return [NSRange(location: forward ? marker.range.end : marker.range.location, length: 0)]
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
    let source = content.length == 0 ? content.location : min(max(content.location, caret - 1), content.end - 1)
    markdownTextView.typingAttributes =
      source < storage.length ? storage.attributes(at: source, effectiveRange: nil) : theme.baseAttributes
  }

  func textViewDidChangeFocus(_ textView: MarkdownTextView) {
    refreshLivePreview()
    vimHost.focusDidChange()
  }

  // MARK: Keys

  func textViewHandleNewline(_ textView: MarkdownTextView) -> Bool {
    guard configuration.isEditable,
      let edit = ListCommands.newline(in: storage.mutableString, selection: currentSelection, isLiteralLine: isLiteral)
    else { return false }
    return perform(edit, actionName: "Typing")
  }

  func textViewHandleTab(_ textView: MarkdownTextView, backwards: Bool) -> Bool {
    guard configuration.isEditable else { return false }
    let selection = currentSelection
    if backwards {
      return perform(ListCommands.outdent(in: storage.mutableString, selection: selection), actionName: "Outdent", userEvent: "delete.dedent")
    }
    if selection.allSatisfy({ $0.length == 0 }), let caret = selection.first, isLiteral(caret.location) {
      return false
    }
    guard let edit = ListCommands.indent(in: storage.mutableString, selection: selection) else { return false }
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

  func textView(_ textView: MarkdownTextView, mouseDownAt point: NSPoint, modifiers: NSEvent.ModifierFlags) -> Bool {
    vimHost.textWasClicked()
    return handleClick(at: point, modifiers: modifiers)
  }

  /// Badge → `didClickBadge`; checkbox → toggle; link → follow (⌘-click always, plain click when its
  /// syntax is hidden). Returns false to let the text view handle the click.
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
    let command = modifiers.contains(.command)
    if let link = link(at: point), command || isRendered(link.range) {
      follow(link.target, newWindow: command)
      return true
    }
    return false
  }

  func textView(_ textView: MarkdownTextView, mouseMovedTo point: NSPoint?, modifiers: NSEvent.ModifierFlags) {
    let layout = point.flatMap { badgeLayout(at: $0) }
    if layout?.badge.id != hoveredBadgeID {
      for rect in drawnBadgeRects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
      hoveredBadgeID = layout?.badge.id
    }
    guard let point else { return }
    let clickable =
      layout != nil || (configuration.isEditable && checkboxLine(at: point) != nil)
      || (link(at: point).map { modifiers.contains(.command) || isRendered($0.range) } ?? false)
    (clickable ? NSCursor.pointingHand : NSCursor.iBeam).set()
  }

  func textView(_ textView: MarkdownTextView, toolTipAt point: NSPoint) -> String? {
    badgeLayout(at: point).map { BadgeRenderer.toolTip(for: $0.badge) }
  }

  // MARK: Drawing and geometry

  /// Before each draw: redraw badges that moved, refresh their tooltip rects, and keep the pulse
  /// of a triaging badge in view going.
  func textViewWillDraw(_ textView: MarkdownTextView) {
    let layouts = currentBadgeLayouts()
    motion.willDraw(pulseVisible: layouts.contains { self.motion.state.isPulsing($0.badge.id) })
    let rects = layouts.map(\.rect)
    guard rects != drawnBadgeRects else { return }
    for rect in drawnBadgeRects + rects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
    textView.removeAllToolTips()
    for rect in rects { textView.addToolTip(rect, owner: textView, userData: nil) }
    drawnBadgeRects = rects
  }

  func textView(_ textView: MarkdownTextView, drawOverlaysIn dirtyRect: NSRect) {
    vimHost.drawOverlays(in: dirtyRect)
    guard !badgeStore.isEmpty else { return }
    let layouts = currentBadgeLayouts()
    guard !motion.state.isIdle else {
      badgeRenderer.draw(layouts, hovered: hoveredBadgeID, dirtyRect: dirtyRect)
      return
    }
    let motion = self.motion
    let now = motion.now
    badgeRenderer.draw(layouts, hovered: hoveredBadgeID, dirtyRect: dirtyRect) { motion.paint(for: $0.badge, now: now) }
  }

  /// Back on screen: redrawing the badges resumes a pulse (frames stop by themselves when hidden).
  func textViewDidChangeOcclusion(_ textView: MarkdownTextView) {
    guard motion.state.hasPulses, !motion.isTicking, motion.canAnimate else { return }
    for rect in drawnBadgeRects { textView.setNeedsDisplay(rect.insetBy(dx: -2, dy: -2)) }
  }

  func textViewDidChangeWidth(_ textView: MarkdownTextView) {
    updateTextGeometry()
    vimHost.layoutDidChange()
  }

  // MARK: Vim

  func textView(_ textView: MarkdownTextView, handleKeyDown event: NSEvent) -> Bool {
    vimHost.handleKeyDown(event)
  }

  func textView(_ textView: MarkdownTextView, claimsKeyEquivalent event: NSEvent) -> Bool {
    vimHost.claimsKeyEquivalent(event)
  }

  func textView(_ textView: MarkdownTextView, willReplace ranges: [NSRange], with strings: [String]) -> Bool {
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
    !vimHost.drawsBlockCursor
  }

  // MARK: Hit testing

  /// Layouts of the badges in the visible part of the document.
  func currentBadgeLayouts() -> [BadgeRenderer.Layout] {
    guard !badgeStore.isEmpty else { return [] }
    return badgeRenderer.layouts(
      for: badgeStore.items, in: markdownTextView, layoutManager: layoutManager, visibleRect: markdownTextView.visibleRect)
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
      let box = decorations.checkboxRect(inSlot: slot.rect, baseline: slot.baseline, font: slot.font)
      result.append((highlighter.lineIndex.line(containing: full.location), box.offsetBy(dx: origin.x, dy: origin.y)))
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
    let glyph = layoutManager.glyphIndex(for: local, in: textContainer, fractionOfDistanceThroughGlyph: nil)
    guard glyph < layoutManager.numberOfGlyphs else { return nil }
    let bounds = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
    guard bounds.insetBy(dx: -1, dy: -1).contains(local) else { return nil }
    let index = layoutManager.characterIndexForGlyph(at: glyph)
    var range = NSRange()
    guard index < storage.length,
      let attribute = storage.attribute(.ddlLink, at: index, effectiveRange: &range) as? LinkAttribute
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
    case let .external(url):
      delegate?.editor(self, didClickLink: url)
    case let .note(note, _):
      delegate?.editor(self, didClickWikiLink: note, newWindow: newWindow)
    }
  }
}
