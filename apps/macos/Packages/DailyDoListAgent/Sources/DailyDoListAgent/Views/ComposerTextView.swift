import AppKit
import DailyDoListUI
import SwiftUI

/// The composer's sizes: it grows from one line to `maxLines`, then scrolls.
@MainActor
enum ComposerMetrics {
  static let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
  static let inset = NSSize(width: 2, height: 3)
  static let maxLines = 8
  static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
  static let minHeight = lineHeight + inset.height * 2
  static let maxHeight = lineHeight * CGFloat(maxLines) + inset.height * 2

  /// The input's height for text that lays out `used` points tall.
  static func height(forUsedHeight used: CGFloat) -> CGFloat {
    min(max((used + inset.height * 2).rounded(.up), minHeight), maxHeight)
  }
}

/// Multi-line plain-text input backed by `NSTextView`: Return sends, Shift-Return (or
/// Option-Return) inserts a newline, and input methods composing text keep their Return. Reports
/// its height (one to eight lines) and whether it has the focus; a new `focusRequest` focuses it.
struct ComposerTextView: NSViewRepresentable {
  @Binding var text: String
  @Binding var height: CGFloat
  var isFocused: Binding<Bool> = .constant(false)
  var isEditable: Bool
  var focusRequest = 0
  var onSubmit: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    scrollView.drawsBackground = false
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    // What `NSTextView.scrollableTextView()` sets up, with a text view that reports its focus.
    let size = scrollView.contentSize
    let textView = FocusReportingTextView(frame: NSRect(origin: .zero, size: size))
    textView.minSize = NSSize(width: 0, height: size.height)
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.textContainer?.containerSize = NSSize(
      width: size.width, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.widthTracksTextView = true
    textView.onFocusChange = { [weak coordinator = context.coordinator] focused in
      coordinator?.focusChanged(focused)
    }
    textView.onWidthChange = { [weak coordinator = context.coordinator] view in
      coordinator?.updateHeight(of: view)
    }
    textView.delegate = context.coordinator
    textView.isRichText = false
    textView.importsGraphics = false
    textView.allowsUndo = true
    textView.drawsBackground = false
    textView.font = ComposerMetrics.font
    textView.textColor = .labelColor
    textView.insertionPointColor = NSColor(Theme.accent)
    textView.textContainerInset = ComposerMetrics.inset
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.string = text
    textView.isEditable = isEditable
    textView.setAccessibilityLabel("Message the agent")
    scrollView.documentView = textView
    context.coordinator.focusRequest = focusRequest
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let textView = scrollView.documentView as? NSTextView else { return }
    if textView.string != text { textView.string = text }
    textView.isEditable = isEditable
    textView.isSelectable = true
    context.coordinator.updateHeight(of: textView)
    if context.coordinator.focusRequest != focusRequest {
      context.coordinator.focusRequest = focusRequest
      textView.window?.makeFirstResponder(textView)
    }
  }

  @MainActor
  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: ComposerTextView
    var focusRequest = 0
    /// The modifiers held with the key being handled (tests set them).
    var modifierFlags: () -> NSEvent.ModifierFlags = { NSApp?.currentEvent?.modifierFlags ?? [] }

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
      let flags = modifierFlags()
      if flags.contains(.shift) || flags.contains(.option) {
        textView.insertNewlineIgnoringFieldEditor(nil)
        return true
      }
      parent.onSubmit()
      return true
    }

    func focusChanged(_ focused: Bool) {
      guard parent.isFocused.wrappedValue != focused else { return }
      let binding = parent.isFocused
      DispatchQueue.main.async { binding.wrappedValue = focused }
    }

    /// The height `textView`'s text needs, from one line to `ComposerMetrics.maxLines`.
    static func measuredHeight(of textView: NSTextView) -> CGFloat {
      guard let container = textView.textContainer, let layout = textView.layoutManager else {
        return ComposerMetrics.minHeight
      }
      layout.ensureLayout(for: container)
      return ComposerMetrics.height(forUsedHeight: layout.usedRect(for: container).height)
    }

    func updateHeight(of textView: NSTextView) {
      let height = Self.measuredHeight(of: textView)
      guard abs(height - parent.height) > 0.5 else { return }
      DispatchQueue.main.async { [parent] in parent.height = height }
    }
  }
}

/// Tells the composer when it gains or loses the focus (for its focus ring) and when its width
/// changes (the text wraps differently, so the height changes).
final class FocusReportingTextView: NSTextView {
  var onFocusChange: ((Bool) -> Void)?
  var onWidthChange: ((NSTextView) -> Void)?

  override func setFrameSize(_ newSize: NSSize) {
    let widthChanged = newSize.width != frame.width
    super.setFrameSize(newSize)
    if widthChanged { onWidthChange?(self) }
  }

  override func becomeFirstResponder() -> Bool {
    let became = super.becomeFirstResponder()
    if became { onFocusChange?(true) }
    return became
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned { onFocusChange?(false) }
    return resigned
  }
}
