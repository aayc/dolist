#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

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
  final class MobileGlyphDelegate: NSObject {
    private weak var storage: NSTextStorage?
    private let livePreview: LivePreviewState
    var theme: MobileMarkdownStyle
    /// The line fragment of a drawn embed's line, given the character at its start and the
    /// proposed fragment (the controller sizes it for the drawing).
    var embedFragment: ((Int, CGRect) -> CGRect?)?
    var contentRange: ((Int) -> NSRange?)?
    var contentFragment: ((Int, CGRect) -> CGRect?)?

    init(storage: NSTextStorage, livePreview: LivePreviewState, theme: MobileMarkdownStyle) {
      self.storage = storage
      self.livePreview = livePreview
      self.theme = theme
    }

    /// The hidden marker at `index` and its full range, if live preview currently hides it.
    func hiddenMarker(at index: Int) -> (kind: MarkerKind, range: NSRange)? {
      guard livePreview.isEnabled, let storage, index >= 0, index < storage.length else {
        return nil
      }
      var range = NSRange()
      guard let raw = storage.attribute(.ddlMarker, at: index, effectiveRange: &range) as? Int,
        let kind = MarkerKind(rawValue: raw), livePreview.isHidden(kind, range: range)
      else { return nil }
      return (kind, range)
    }

    private func slotWidth(forReplacementAt index: Int, kind: MarkerKind) -> CGFloat {
      guard kind != .task, let storage else { return theme.checkboxSlotWidth }
      let font =
        storage.attribute(.font, at: index, effectiveRange: nil) as? UIFont ?? theme.bodyFont
      if kind == .agent { return theme.agentSlotWidth(font: font) }
      return theme.bulletSlotWidth(storage.mutableString.character(at: index), font: font)
    }
  }

  extension MobileGlyphDelegate: @preconcurrency NSLayoutManagerDelegate {
    func layoutManager(
      _ layoutManager: NSLayoutManager, shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
      properties props: UnsafePointer<NSLayoutManager.GlyphProperty>,
      characterIndexes charIndexes: UnsafePointer<Int>,
      font aFont: UIFont, forGlyphRange glyphRange: NSRange
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
      var probe = first
      while probe <= last {
        if let range = contentRange?(probe), range.length > 0 {
          hidden.append((range, -1))
          probe = max(probe + 1, range.end)
        } else {
          // Content ranges are whole lines; skip to the next line rather than querying per glyph.
          let tail = storage.mutableString.range(of: "\n", range: NSRange(probe, last + 1))
          probe = tail.location == NSNotFound ? last + 1 : tail.location + 1
        }
      }
      hidden.sort { $0.range.location < $1.range.location }
      guard !hidden.isEmpty else { return 0 }
      let text = storage.mutableString
      var properties = Array(UnsafeBufferPointer(start: props, count: count))
      var next = 0
      for i in 0..<count {
        let index = charIndexes[i]
        while next < hidden.count, hidden[next].range.end <= index { next += 1 }
        guard next < hidden.count, hidden[next].range.location <= index else { continue }
        let lineStart = index == 0 || text.character(at: index - 1) == UTF16Unit.newline
        properties[i] =
          hidden[next].replacementStart == index || lineStart ? .controlCharacter : .null
      }
      properties.withUnsafeBufferPointer { buffer in
        layoutManager.setGlyphs(
          glyphs, properties: buffer.baseAddress!, characterIndexes: charIndexes, font: aFont,
          forGlyphRange: glyphRange)
      }
      return count
    }

    func layoutManager(
      _ layoutManager: NSLayoutManager, shouldUse action: NSLayoutManager.ControlCharacterAction,
      forControlCharacterAt charIndex: Int
    ) -> NSLayoutManager.ControlCharacterAction {
      if let range = contentRange?(charIndex), NSLocationInRange(charIndex, range) {
        return .zeroAdvancement
      }
      guard let marker = hiddenMarker(at: charIndex) else { return action }
      return marker.kind.isReplacement && marker.range.location == charIndex
        ? .whitespace : .zeroAdvancement
    }

    func layoutManager(
      _ layoutManager: NSLayoutManager, boundingBoxForControlGlyphAt glyphIndex: Int,
      for textContainer: NSTextContainer,
      proposedLineFragment proposedRect: CGRect, glyphPosition: CGPoint,
      characterIndex charIndex: Int
    ) -> CGRect {
      guard let marker = hiddenMarker(at: charIndex), marker.kind.isReplacement else {
        return CGRect(x: glyphPosition.x, y: glyphPosition.y, width: 0, height: proposedRect.height)
      }
      let width = slotWidth(forReplacementAt: charIndex, kind: marker.kind)
      return CGRect(
        x: glyphPosition.x, y: glyphPosition.y, width: width, height: proposedRect.height)
    }

    func layoutManager(
      _ layoutManager: NSLayoutManager,
      shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<CGRect>,
      lineFragmentUsedRect: UnsafeMutablePointer<CGRect>,
      baselineOffset: UnsafeMutablePointer<CGFloat>,
      in textContainer: NSTextContainer, forGlyphRange glyphRange: NSRange
    ) -> Bool {
      guard glyphRange.length > 0 else { return false }
      let character = layoutManager.characterIndexForGlyph(at: glyphRange.location)
      let content = contentFragment?(character, lineFragmentRect.pointee)
      let embed =
        hiddenMarker(at: character)?.kind == .embed
        ? embedFragment?(character, lineFragmentRect.pointee) : nil
      guard let rect = content ?? embed else { return false }
      lineFragmentRect.pointee = rect
      lineFragmentUsedRect.pointee = rect
      return true
    }

  }
#endif
