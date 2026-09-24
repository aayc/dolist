import AppKit
import SwiftUI

/// Multi-line plain-text input backed by `NSTextView`: Return sends, Shift-Return (or
/// Option-Return) inserts a newline, and input methods composing text keep their Return.
struct ComposerTextView: NSViewRepresentable {
  @Binding var text: String
  @Binding var height: CGFloat
  var isEditable: Bool
  var minHeight: CGFloat = 22
  var maxHeight: CGFloat = 120
  var onSubmit: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSTextView.scrollableTextView()
    scrollView.drawsBackground = false
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    if let textView = scrollView.documentView as? NSTextView {
      textView.delegate = context.coordinator
      textView.isRichText = false
      textView.importsGraphics = false
      textView.allowsUndo = true
      textView.drawsBackground = false
      textView.font = .systemFont(ofSize: NSFont.systemFontSize)
      textView.textColor = .labelColor
      textView.textContainerInset = NSSize(width: 2, height: 3)
      textView.isAutomaticQuoteSubstitutionEnabled = false
      textView.isAutomaticDashSubstitutionEnabled = false
      textView.isAutomaticTextReplacementEnabled = false
      textView.string = text
      textView.isEditable = isEditable
      textView.setAccessibilityLabel("Message the agent")
    }
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let textView = scrollView.documentView as? NSTextView else { return }
    if textView.string != text { textView.string = text }
    textView.isEditable = isEditable
    textView.isSelectable = true
    context.coordinator.updateHeight(of: textView)
  }

  @MainActor
  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: ComposerTextView

    init(parent: ComposerTextView) {
      self.parent = parent
    }

    func textDidChange(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView else { return }
      parent.text = textView.string
      updateHeight(of: textView)
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
      guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
      // Let an input method finish composing.
      if textView.hasMarkedText() { return false }
      let flags = NSApp?.currentEvent?.modifierFlags ?? []
      if flags.contains(.shift) || flags.contains(.option) {
        textView.insertNewlineIgnoringFieldEditor(nil)
        return true
      }
      parent.onSubmit()
      return true
    }

    func updateHeight(of textView: NSTextView) {
      guard let container = textView.textContainer, let layout = textView.layoutManager else { return }
      layout.ensureLayout(for: container)
      let used = layout.usedRect(for: container).height + textView.textContainerInset.height * 2
      let clamped = min(max(used.rounded(.up), parent.minHeight), parent.maxHeight)
      guard abs(clamped - parent.height) > 0.5 else { return }
      DispatchQueue.main.async { [parent] in parent.height = clamped }
    }
  }
}
