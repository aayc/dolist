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
