import AppKit
import SwiftUI
import Testing

@testable import DailyDoListAgent

@MainActor
@Suite("Composer keys")
struct ComposerTests {
  private func coordinator(onSubmit: @escaping () -> Void) -> ComposerTextView.Coordinator {
    ComposerTextView.Coordinator(
      parent: ComposerTextView(
        text: .constant("Hi"), height: .constant(22), isEditable: true, onSubmit: onSubmit))
  }

  @Test func returnSendsAndOtherCommandsPassThrough() {
    var submitted = 0
    let coordinator = coordinator { submitted += 1 }
    let textView = NSTextView()
    #expect(coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    #expect(submitted == 1)
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.moveUp(_:))))
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertTab(_:))))
    #expect(submitted == 1)
  }

  @Test func returnFinishesInputMethodCompositionInsteadOfSending() {
    var submitted = 0
    let coordinator = coordinator { submitted += 1 }
    let textView = NSTextView()
    textView.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(textView.hasMarkedText())
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    #expect(submitted == 0)
  }
}
