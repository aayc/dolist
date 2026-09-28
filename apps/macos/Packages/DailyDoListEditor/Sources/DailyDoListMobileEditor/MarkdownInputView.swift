#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  /// Explicit TextKit 1 keeps markdown source positions stable for shared UTF-16 editing rules.
  @MainActor
  public final class MarkdownInputView: UITextView {
    weak var commandController: MobileMarkdownController?

    public override func insertText(_ text: String) {
      if text == "\n", commandController?.handleNewline() == true { return }
      super.insertText(text)
    }

    public override func unmarkText() {
      super.unmarkText()
      commandController?.compositionDidEnd()
    }

    public override func layoutSubviews() {
      commandController?.updateMobileGeometry()
      super.layoutSubviews()
      commandController?.embeds.layout()
      commandController?.content.layout()
      commandController?.annotations.layout()
      guard window != nil, bounds.height > 0, bounds.width > 0,
        let restored = commandController?.restoredScrollY
      else { return }
      commandController?.restoredScrollY = nil
      layoutManager.ensureLayout(for: textContainer)
      let height =
        layoutManager.usedRect(for: textContainer).height
        + textContainerInset.top + textContainerInset.bottom
      setContentOffset(
        CGPoint(x: 0, y: min(restored, max(0, height - bounds.height))), animated: false)
    }

    public init() {
      let storage = NSTextStorage()
      let layout = MobileLayoutManager()
      let container = NSTextContainer(
        size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
      storage.addLayoutManager(layout)
      layout.addTextContainer(container)
      super.init(frame: .zero, textContainer: container)
      font = .preferredFont(forTextStyle: .body)
      adjustsFontForContentSizeCategory = true
      textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 24, right: 16)
      accessibilityIdentifier = "note.editor"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Use init()") }
  }
#endif
