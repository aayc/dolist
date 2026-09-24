import AppKit

/// Layout-manager delegate implementing live preview and line metrics:
///
/// - Hidden syntax gets the `.null` glyph property (no glyph, zero advance). A hidden character at
///   the very start of a line is instead a zero-advance control glyph: TextKit attaches leading
///   null glyphs to the *previous* line fragment, which would drop the paragraph's first-line indent
///   and spacing (verified experimentally).
/// - A replaced marker (`- [ ]`, `-`, an agent marker) keeps its first character as a whitespace
///   control glyph with a fixed width (the checkbox, bullet or sparkle slot, drawn by
///   `DecorationRenderer`); the rest is null.
/// - Fixed line heights come from the paragraph styles; this delegate moves the baseline so the text
///   is vertically centered in the line box instead of sitting at its bottom.
@MainActor
final class GlyphLayoutDelegate: NSObject {
  private weak var storage: NSTextStorage?
  private let livePreview: LivePreviewState
  var theme: EditorTheme

  init(storage: NSTextStorage, livePreview: LivePreviewState, theme: EditorTheme) {
    self.storage = storage
    self.livePreview = livePreview
    self.theme = theme
  }

  /// The hidden marker at `index` and its full range, if live preview currently hides it.
  func hiddenMarker(at index: Int) -> (kind: MarkerKind, range: NSRange)? {
    guard livePreview.isEnabled, let storage, index >= 0, index < storage.length else { return nil }
    var range = NSRange()
    guard let raw = storage.attribute(.ddlMarker, at: index, effectiveRange: &range) as? Int,
      let kind = MarkerKind(rawValue: raw), livePreview.isHidden(kind, range: range)
    else { return nil }
    return (kind, range)
  }

  private func slotWidth(forReplacementAt index: Int, kind: MarkerKind) -> CGFloat {
    guard kind != .task, let storage else { return theme.checkboxSlotWidth }
    let font = storage.attribute(.font, at: index, effectiveRange: nil) as? NSFont ?? theme.bodyFont
    if kind == .agent { return theme.agentSlotWidth(font: font) }
    return theme.bulletSlotWidth(storage.mutableString.character(at: index), font: font)
  }
}

extension GlyphLayoutDelegate: @preconcurrency NSLayoutManagerDelegate {
  func layoutManager(
    _ layoutManager: NSLayoutManager, shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
    properties props: UnsafePointer<NSLayoutManager.GlyphProperty>, characterIndexes charIndexes: UnsafePointer<Int>,
    font aFont: NSFont, forGlyphRange glyphRange: NSRange
  ) -> Int {
    guard livePreview.isEnabled, let storage, glyphRange.length > 0 else { return 0 }
    let count = glyphRange.length
    let first = charIndexes[0]
    let last = charIndexes[count - 1]
    guard first >= 0, last >= first, last < storage.length else { return 0 }
    var hidden: [(range: NSRange, replacementStart: Int)] = []
    storage.enumerateAttribute(.ddlMarker, in: NSRange(first, last + 1)) { value, run, _ in
      guard let raw = value as? Int, let kind = MarkerKind(rawValue: raw) else { return }
      var full = run
      if kind.isReplacement {
        _ = storage.attribute(.ddlMarker, at: run.location, effectiveRange: &full)
      }
      guard livePreview.isHidden(kind, range: full) else { return }
      hidden.append((run, kind.isReplacement ? full.location : -1))
    }
    guard !hidden.isEmpty else { return 0 }
    let text = storage.mutableString
    var properties = Array(UnsafeBufferPointer(start: props, count: count))
    var next = 0
    for i in 0..<count {
      let index = charIndexes[i]
      while next < hidden.count, hidden[next].range.end <= index { next += 1 }
      guard next < hidden.count, hidden[next].range.location <= index else { continue }
      let lineStart = index == 0 || text.character(at: index - 1) == UTF16Unit.newline
      properties[i] = hidden[next].replacementStart == index || lineStart ? .controlCharacter : .null
    }
    properties.withUnsafeBufferPointer { buffer in
      layoutManager.setGlyphs(
        glyphs, properties: buffer.baseAddress!, characterIndexes: charIndexes, font: aFont, forGlyphRange: glyphRange)
    }
    return count
  }

  func layoutManager(
    _ layoutManager: NSLayoutManager, shouldUse action: NSLayoutManager.ControlCharacterAction,
    forControlCharacterAt charIndex: Int
  ) -> NSLayoutManager.ControlCharacterAction {
    guard let marker = hiddenMarker(at: charIndex) else { return action }
    return marker.kind.isReplacement && marker.range.location == charIndex ? .whitespace : .zeroAdvancement
  }

  func layoutManager(
    _ layoutManager: NSLayoutManager, boundingBoxForControlGlyphAt glyphIndex: Int, for textContainer: NSTextContainer,
    proposedLineFragment proposedRect: NSRect, glyphPosition: NSPoint, characterIndex charIndex: Int
  ) -> NSRect {
    guard let marker = hiddenMarker(at: charIndex), marker.kind.isReplacement else {
      return NSRect(x: glyphPosition.x, y: glyphPosition.y, width: 0, height: proposedRect.height)
    }
    let width = slotWidth(forReplacementAt: charIndex, kind: marker.kind)
    return NSRect(x: glyphPosition.x, y: glyphPosition.y, width: width, height: proposedRect.height)
  }

  func layoutManager(
    _ layoutManager: NSLayoutManager, shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
    lineFragmentUsedRect: UnsafeMutablePointer<NSRect>, baselineOffset: UnsafeMutablePointer<CGFloat>,
    in textContainer: NSTextContainer, forGlyphRange glyphRange: NSRange
  ) -> Bool {
    guard let storage, glyphRange.length > 0 else { return false }
    let index = layoutManager.characterIndexForGlyph(at: glyphRange.location)
    guard index < storage.length,
      let baseline = storage.attribute(.ddlBaseline, at: index, effectiveRange: nil) as? NSNumber
    else { return false }
    let spacingBefore = lineFragmentUsedRect.pointee.minY - lineFragmentRect.pointee.minY
    baselineOffset.pointee = spacingBefore + CGFloat(baseline.doubleValue)
    return true
  }
}
