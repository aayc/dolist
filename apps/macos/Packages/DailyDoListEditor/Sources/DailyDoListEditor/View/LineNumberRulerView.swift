import AppKit

/// Lightweight line-number gutter: draws the numbers of the visible lines only, aligned with each
/// line's first baseline, and emphasizes the caret's line.
final class LineNumberRulerView: NSRulerView {
  private weak var textView: NSTextView?
  private let lineIndex: @MainActor () -> LineIndex
  private let caretLine: @MainActor () -> Int
  private var numberFont: NSFont

  init(
    textView: NSTextView, fontSize: CGFloat, lineIndex: @escaping @MainActor () -> LineIndex,
    caretLine: @escaping @MainActor () -> Int
  ) {
    self.textView = textView
    self.lineIndex = lineIndex
    self.caretLine = caretLine
    numberFont = NSFont.monospacedDigitSystemFont(ofSize: max(9, (fontSize * 0.72).rounded()), weight: .regular)
    super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
    clientView = textView
    ruleThickness = 40
  }

  @available(*, unavailable)
  required init(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override var isFlipped: Bool { true }

  func setFontSize(_ fontSize: CGFloat) {
    numberFont = NSFont.monospacedDigitSystemFont(ofSize: max(9, (fontSize * 0.72).rounded()), weight: .regular)
    needsDisplay = true
  }

  /// Widens the gutter for the number of digits needed.
  func updateThickness() {
    let digits = max(2, String(lineIndex().count).count)
    let digitWidth = ("8" as NSString).size(withAttributes: [.font: numberFont]).width
    let thickness = ceil(CGFloat(digits) * digitWidth + 20)
    if abs(ruleThickness - thickness) > 0.5 { ruleThickness = thickness }
  }

  override func drawHashMarksAndLabels(in rect: NSRect) {
    guard let textView, let layoutManager = textView.layoutManager, let container = textView.textContainer,
      let storage = textView.textStorage
    else { return }
    EditorColors.background.setFill()
    rect.fill()
    let index = lineIndex()
    let origin = textView.textContainerOrigin
    let visible = textView.visibleRect
    let glyphs = layoutManager.glyphRange(forBoundingRect: visible.offsetBy(dx: -origin.x, dy: -origin.y), in: container)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    let length = storage.length
    let current = caretLine()
    var line = index.line(containing: chars.location)
    while line < index.count {
      let start = index.start(ofLine: line)
      guard start <= chars.end else { break }
      let baseline: CGFloat
      if start >= length {
        let extra = layoutManager.extraLineFragmentRect
        guard extra.height > 0 else { break }
        baseline = extra.minY + numberFont.ascender + (extra.height - (numberFont.ascender - numberFont.descender)) / 2
      } else {
        let glyph = layoutManager.glyphIndexForCharacter(at: start)
        let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        baseline = fragment.minY + layoutManager.location(forGlyphAt: glyph).y
      }
      let y = convert(NSPoint(x: 0, y: baseline + origin.y), from: textView).y
      let color = line == current ? EditorColors.currentLineNumber : EditorColors.lineNumber
      let label = String(line + 1) as NSString
      let attributes: [NSAttributedString.Key: Any] = [.font: numberFont, .foregroundColor: color]
      let size = label.size(withAttributes: attributes)
      label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y - numberFont.ascender), withAttributes: attributes)
      line += 1
    }
  }
}
