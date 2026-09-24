import AppKit
import SwiftUI

/// Keys the palette reacts to while its search field has focus.
enum PaletteKey: Equatable, Sendable {
  case up, down
  /// ↩ with the modifiers held (⌘↩ creates in the switcher, ⇧↩ opens in a new tab).
  case submit(command: Bool, shift: Bool)
  case cancel
}

/// Borderless `NSTextField` that takes focus when shown and reports ↑↓ ↩ ⌘↩ ⎋ (and ⌃N/⌃P)
/// through the field editor's commands, which is reliable where SwiftUI key handlers are not.
struct PaletteSearchField: NSViewRepresentable {
  @Binding var text: String
  let placeholder: String
  let onKey: (PaletteKey) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSTextField {
    let field = AutoFocusTextField()
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = .systemFont(ofSize: 17)
    field.placeholderString = placeholder
    field.lineBreakMode = .byTruncatingTail
    field.cell?.usesSingleLineMode = true
    field.delegate = context.coordinator
    field.stringValue = text
    field.setAccessibilityLabel(placeholder)
    return field
  }

  func updateNSView(_ field: NSTextField, context: Context) {
    context.coordinator.parent = self
    if field.stringValue != text { field.stringValue = text }
    field.placeholderString = placeholder
  }

  @MainActor
  final class Coordinator: NSObject, NSTextFieldDelegate {
    var parent: PaletteSearchField

    init(_ parent: PaletteSearchField) {
      self.parent = parent
    }

    func controlTextDidChange(_ notification: Notification) {
      guard let field = notification.object as? NSTextField else { return }
      parent.text = field.stringValue
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool
    {
      switch selector {
      case #selector(NSResponder.moveUp(_:)):
        parent.onKey(.up)
      case #selector(NSResponder.moveDown(_:)):
        parent.onKey(.down)
      case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertLineBreak(_:)),
        #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        parent.onKey(.submit(command: flags.contains(.command), shift: flags.contains(.shift)))
      case #selector(NSResponder.cancelOperation(_:)):
        parent.onKey(.cancel)
      case Selector(("noop:")):
        // ⌘↩ has no key binding and arrives as `noop:`.
        guard let event = NSApp.currentEvent, event.type == .keyDown,
          event.keyCode == 36 || event.keyCode == 76
        else { return false }
        parent.onKey(
          .submit(
            command: event.modifierFlags.contains(.command),
            shift: event.modifierFlags.contains(.shift)))
      default:
        return false
      }
      return true
    }
  }
}

/// Becomes first responder as soon as it's in a window.
final class AutoFocusTextField: NSTextField {
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    guard window != nil else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, let window = self.window else { return }
      window.makeFirstResponder(self)
    }
  }
}
