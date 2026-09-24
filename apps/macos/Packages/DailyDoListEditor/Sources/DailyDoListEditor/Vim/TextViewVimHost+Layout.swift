import AppKit
import DailyDoListVim

/// Layout for vim (`H`/`M`/`L`, `gj`/`gk`, `<C-d>`, `zz`…), from the layout manager. Content
/// coordinates are text-container coordinates: y grows down from the top of the first line.
extension TextViewVimHost {
  var layoutManager: NSLayoutManager { controller.layoutManager }
  var textContainer: NSTextContainer { controller.textContainer }

  var vimLineHeight: Double { Double(controller.theme.lineHeight(.body)) }

  var vimTextHeight: Double {
    let font = controller.theme.bodyFont
    return Double(font.ascender - font.descender)
  }

  var vimViewport: VimViewport {
    let clip = controller.scrollView.contentView.bounds
    let origin = textView.textContainerOrigin
    return VimViewport(
      scrollTop: Double(clip.minY - origin.y), scrollLeft: Double(clip.minX - origin.x), clientHeight: Double(clip.height),
      clientWidth: Double(clip.width), contentHeight: Double(contentHeight))
  }

  /// The height of all lines (the extra fragment of a trailing line break included). A document
  /// taller than the view sized the text view to it (from the layout manager's estimate for text
  /// not laid out yet); asking the layout manager instead would lay out the whole document.
  private var contentHeight: CGFloat {
    let textView = self.textView
    if textView.frame.height > textView.minSize.height + 0.5 {
      return textView.frame.height - 2 * textView.textContainerInset.height
    }
    return measuring { layoutManager.usedRect(for: textContainer).height }
  }

  /// Runs layout queries without letting the view scroll by itself. Filling holes of the
  /// non-contiguous layout resizes the text view from estimated heights: the text view then
  /// scrolls the selection into view and the clip view clamps its position to a document that
  /// is briefly too short. What vim sees must only scroll when vim asks.
  func measuring<T>(_ body: () -> T) -> T {
    let textView = self.textView
    guard !textView.suppressesAutomaticScrolling else { return body() }
    let clip = controller.scrollView.contentView
    let origin = clip.bounds.origin
    textView.suppressesAutomaticScrolling = true
    let result = body()
    if clip.bounds.origin != origin {
      let visible = NSRect(origin: origin, size: clip.bounds.size)
      let container = textView.textContainerOrigin
      layoutManager.ensureLayout(forBoundingRect: visible.offsetBy(dx: -container.x, dy: -container.y), in: textContainer)
      let maxY = max(0, textView.frame.height - clip.bounds.height)
      controller.scroll(to: NSPoint(x: origin.x, y: min(origin.y, maxY)))
    }
    textView.suppressesAutomaticScrolling = false
    return result
  }

  func vimScroll(top: Double?, left: Double?) {
    let clip = controller.scrollView.contentView.bounds
    let origin = textView.textContainerOrigin
    var point = clip.origin
    if let top { point.y = CGFloat(top) + origin.y }
    if let left { point.x = CGFloat(left) + origin.x }
    let maxY = max(0, textView.frame.height - clip.height)
    point.y = min(max(0, point.y), maxY)
    point.x = max(0, point.x)
    guard point != clip.origin else { return }
    controller.scroll(to: point)
  }

  func vimScrollIntoView(_ offset: Int?) {
    pendingScroll = offset.map { VimSelection.Range(cursor: $0) } ?? selection.main
  }

  /// CodeMirror's `scrollIntoView` of what vim asked for since the last layout pass: the nearest
  /// scroll position that shows it with a 5 pt margin.
  func applyPendingScroll() {
    guard let target = pendingScroll else { return }
    pendingScroll = nil
    let length = storage.length
    guard var rect = vimCoords(at: min(target.head, length), side: 1) else { return }
    if !target.isEmpty, let other = vimCoords(at: min(target.anchor, length), side: 1) {
      rect = VimRect(
        left: min(rect.left, other.left), top: min(rect.top, other.top), right: max(rect.right, other.right),
        bottom: max(rect.bottom, other.bottom))
    }
    let viewport = vimViewport
    guard viewport.contentHeight > viewport.clientHeight else { return }
    let side = target.head < target.anchor ? -1 : 1
    let margin = 5.0
    let top = rect.top - viewport.scrollTop
    let bottom = rect.bottom - viewport.scrollTop
    let height = viewport.clientHeight
    var moveY = 0.0
    if top < margin {
      moveY = top - margin
      if side > 0 && bottom > height + moveY { moveY = bottom - height + margin }
    } else if bottom > height - margin {
      moveY = bottom - height + margin
      if side < 0 && top - moveY < 0 { moveY = top - margin }
    }
    if moveY != 0 { vimScroll(top: viewport.scrollTop + moveY, left: nil) }
  }

  /// The glyph box at `offset` (side -1: attached to the character before), as tall as its font's
  /// text and vertically where the editor draws it.
  func vimCoords(at offset: Int, side: Int) -> VimRect? {
    measuring { coords(at: offset, side: side) }
  }

  private func coords(at offsetIn: Int, side: Int) -> VimRect? {
    let length = storage.length
    let offset = min(max(offsetIn, 0), length)
    let string = storage.mutableString
    let endsWithBreak = length > 0 && string.character(at: length - 1) == UTF16Unit.newline
    if length == 0 || (offset == length && endsWithBreak) {
      layoutManager.ensureLayout(for: textContainer)
      let fragment = layoutManager.extraLineFragmentRect
      guard !fragment.isEmpty || length == 0 else { return nil }
      let x = max(fragment.minX, layoutManager.extraLineFragmentUsedRect.minX)
      return box(x: x, fragment: fragment, baseline: nil, fontIndex: max(0, offset - 1))
    }
    var index = offset < length ? offset : length - 1
    if side < 0, offset > 0, offset < length, string.character(at: offset - 1) != UTF16Unit.newline {
      // At a wrap, the position attached to the previous character is the end of the line above.
      let previous = layoutManager.glyphIndexForCharacter(at: offset - 1)
      let current = layoutManager.glyphIndexForCharacter(at: offset)
      var previousRange = NSRange()
      layoutManager.lineFragmentRect(forGlyphAt: previous, effectiveRange: &previousRange)
      if !NSLocationInRange(current, previousRange) { index = offset - 1 }
    }
    layoutManager.ensureLayout(forCharacterRange: NSRange(location: index, length: 1))
    let glyph = layoutManager.glyphIndexForCharacter(at: index)
    var glyphRange = NSRange()
    let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: &glyphRange)
    let location = layoutManager.location(forGlyphAt: glyph)
    var x = fragment.minX + location.x
    if index < offset {
      // After the character at `index` (the end of the document, or the end of a wrapped line).
      let bounds = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
      x = max(x, bounds.maxX)
    }
    return box(x: x, fragment: fragment, baseline: location.y, fontIndex: index)
  }

  private func box(x: CGFloat, fragment: NSRect, baseline: CGFloat?, fontIndex: Int) -> VimRect {
    let font = fontIndex < storage.length ? (storage.attribute(.font, at: fontIndex, effectiveRange: nil) as? NSFont) : nil
    let used = font ?? controller.theme.bodyFont
    let ascender = used.ascender
    let textHeight = ascender - used.descender
    let top: CGFloat
    if let baseline {
      top = fragment.minY + baseline - ascender
    } else {
      top = fragment.minY + (fragment.height - textHeight) / 2
    }
    return VimRect(left: Double(x), top: Double(top), right: Double(x), bottom: Double(top + textHeight))
  }

  func vimOffset(at point: VimPoint) -> Int {
    measuring { offset(at: point) }
  }

  private func offset(at point: VimPoint) -> Int {
    let length = storage.length
    guard length > 0 else { return 0 }
    let p = NSPoint(x: max(0, point.x), y: max(0, point.y))
    layoutManager.ensureLayout(forBoundingRect: NSRect(x: 0, y: p.y - 1, width: textContainer.size.width, height: 2), in: textContainer)
    let extra = layoutManager.extraLineFragmentRect
    if !extra.isEmpty, p.y >= extra.minY { return length }
    var fraction: CGFloat = 0
    let index = layoutManager.characterIndex(for: p, in: textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction)
    guard index < length else { return length }
    let string = storage.mutableString
    if string.character(at: index) == UTF16Unit.newline { return index }
    return fraction > 0.5 ? string.rangeOfComposedCharacterSequence(at: index).upperBound : index
  }

  /// The line at `y`, from the layout (headings are taller, long lines wrap).
  func vimLine(atY y: Double) -> Int {
    measuring {
      let length = storage.length
      guard length > 0, y > 0 else { return 0 }
      let extra = layoutManager.extraLineFragmentRect
      if !extra.isEmpty, CGFloat(y) >= extra.minY { return lineIndex.count - 1 }
      let glyph = layoutManager.glyphIndex(for: NSPoint(x: 0, y: y), in: textContainer)
      let character = layoutManager.characterIndexForGlyph(at: glyph)
      return lineIndex.line(containing: min(character, length))
    }
  }

  /// The top of `line`'s first line fragment (the bottom of the last line past the end).
  func vimLineTop(_ line: Int) -> Double {
    measuring {
      let length = storage.length
      guard line > 0 else { return 0 }
      guard line < lineIndex.count else { return Double(contentHeight) }
      let start = lineIndex.start(ofLine: line)
      if start >= length {
        layoutManager.ensureLayout(for: textContainer)
        return Double(layoutManager.extraLineFragmentRect.minY)
      }
      let glyph = layoutManager.glyphIndexForCharacter(at: start)
      return Double(layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY)
    }
  }

  /// Lays out what vim measures before a key: the visible lines and the cursor's line. Moving the
  /// cursor re-lays out the lines live preview reveals or hides; answering one command from lines
  /// laid out and lines only estimated would disagree with itself.
  func prepareLayout() {
    measuring {
      let origin = textView.textContainerOrigin
      layoutManager.ensureLayout(forBoundingRect: textView.visibleRect.offsetBy(dx: -origin.x, dy: -origin.y), in: textContainer)
      let line = lineIndex.fullRange(ofLine: vimLineNumber(at: min(selection.main.head, storage.length)), textLength: storage.length)
      if line.length > 0 { layoutManager.ensureLayout(forCharacterRange: line) }
    }
  }

  /// The view's size or the text's layout changed.
  func layoutDidChange() {
    guard isAttached else { return }
    searchHighlighter.refresh(in: self)
    cursorDidChange()
  }

  /// The visible part of the document changed (scrolling).
  func viewportDidChange() {
    guard isAttached else { return }
    searchHighlighter.refresh(in: self)
  }
}
