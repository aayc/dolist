#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  /// Paint only visible line numbers; wrapped fragments share the source line's first number.
  @MainActor final class MobileLineNumberGutter: UIView {
    weak var owner: MobileMarkdownController?
    init(owner: MobileMarkdownController) {
      self.owner = owner
      super.init(frame: .zero)
      backgroundColor = .clear
      isUserInteractionEnabled = false
      isAccessibilityElement = false
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("Use init") }
    override func draw(_ rect: CGRect) {
      guard let owner, owner.configuration.showLineNumbers else { return }
      let input = owner.input
      let layout = input.layoutManager
      let visible = input.bounds.offsetBy(
        dx: -input.textContainerInset.left, dy: -input.textContainerInset.top)
      let glyphs = layout.glyphRange(forBoundingRect: visible, in: input.textContainer)
      let characters = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
      let first = owner.parser.lineIndex.line(containing: characters.location)
      let last = owner.parser.lineIndex.line(containing: characters.end)
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .right
      let font = UIFont.monospacedDigitSystemFont(
        ofSize: max(10, owner.configuration.fontSize * 0.72), weight: .regular)
      let attributes: [NSAttributedString.Key: Any] = [
        .font: font, .foregroundColor: UIColor.tertiaryLabel, .paragraphStyle: paragraph,
      ]
      for line in first...max(first, last) {
        let start = owner.parser.lineIndex.start(ofLine: line)
        let fragment: CGRect
        if start >= input.textStorage.length {
          fragment = layout.extraLineFragmentRect
        } else {
          fragment = layout.lineFragmentRect(
            forGlyphAt: layout.glyphIndexForCharacter(at: start), effectiveRange: nil)
        }
        let top = fragment.minY + input.textContainerInset.top - frame.minY
        (String(line + 1) as NSString).draw(
          in: CGRect(x: 0, y: top + 3, width: bounds.width - 8, height: max(16, fragment.height)),
          withAttributes: attributes)
      }
    }
  }

  extension MobileMarkdownController {
    func updateMobileGeometry() {
      guard input.bounds.width > 0 else { return }
      let gutter: CGFloat = configuration.showLineNumbers ? 40 : 0
      let available = max(80, input.bounds.width - 32 - gutter)
      let column = configuration.readableLineLength ? min(700, available) : available
      let left = floor((input.bounds.width - column - gutter) / 2) + gutter
      let inset = UIEdgeInsets(
        top: 16, left: left, bottom: 24, right: input.bounds.width - column - left)
      if input.textContainerInset != inset { input.textContainerInset = inset }
      if configuration.showLineNumbers {
        if lineNumberGutter.superview == nil { input.addSubview(lineNumberGutter) }
        lineNumberGutter.frame = CGRect(
          x: max(0, left - gutter), y: input.contentOffset.y, width: gutter,
          height: input.bounds.height)
        lineNumberGutter.setNeedsDisplay()
      } else {
        lineNumberGutter.removeFromSuperview()
      }
    }
  }
#endif
