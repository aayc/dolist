import AppKit
import DailyDoListVim
import Foundation
import Testing

@testable import DailyDoListEditor

/// Keystrokes with vim mode on, through `keyDown` like a keyboard, on a 10,000-line note with
/// mixed markdown and live preview: insert-mode typing (vim → NSTextView → restyle, badges,
/// report back to vim, undo step) and normal-mode motions and edits. Same budgets as the editor's
/// keystroke test (`PerformanceTests`), scaled by `EDITOR_PERF_BUDGET_MULTIPLIER`; the measured
/// numbers are printed (`PERF …`).
@MainActor
@Suite("Vim performance", .serialized)
struct VimPerformanceTests {
  static let multiplier = PerformanceTests.multiplier
  static let note = SampleNote.long(lines: 10_000)

  private func makeEditor(vimMode: Bool = true) -> VimEditorHarness {
    let editor = VimEditorHarness(
      "", configuration: EditorConfiguration(livePreview: true, vimMode: vimMode), size: NSSize(width: 900, height: 800))
    editor.controller.setText(Self.note, resetUndo: true)
    // Without vim the text view's undo groups open with the event, as in the app.
    editor.controller.noteUndoManager.groupsByEvent = !vimMode
    editor.controller.scrollToLine(5_000)
    editor.controller.layoutManager.ensureLayout(forBoundingRect: editor.textView.visibleRect, in: editor.controller.textContainer)
    return editor
  }

  private func measure(_ editor: VimEditorHarness, _ keys: [String], repeat count: Int) -> PerformanceTests.Stats {
    let clock = ContinuousClock()
    var samples: [Double] = []
    let events = keys.map { VimEditorHarness.event(for: $0, window: editor.window) }
    for index in 0..<count {
      let event = events[index % events.count]
      let elapsed = clock.measure {
        editor.send(event)
        let caret = editor.textView.selectedRange().location
        editor.controller.layoutManager.ensureLayout(forCharacterRange: NSRange(location: max(0, caret - 1), length: 1))
      }
      samples.append(PerformanceTests.milliseconds(elapsed))
    }
    // Every key counts, the first ones too (they pay for layout nobody asked for before).
    return PerformanceTests.Stats(samples: samples)
  }

  @Test func insertModeTyping() {
    let keys = ["x", "y", "z", " "]
    let plainEditor = makeEditor(vimMode: false)
    plainEditor.textView.moveToEndOfLine(nil)
    let plain = measure(plainEditor, keys, repeat: 300)
    let editor = makeEditor()
    editor.press("A")
    let stats = measure(editor, keys, repeat: 300)
    editor.press("<Esc>")
    print("PERF vim insert-mode keystroke (10k lines, keyDown → vim → NSTextView → report): \(stats)")
    print("PERF the same keystroke without vim: \(plain)")
    #expect(stats.average < 12 * Self.multiplier)
    #expect(stats.p95 < 30 * Self.multiplier)
  }

  @Test func normalModeMotions() {
    let editor = makeEditor()
    let stats = measure(editor, ["j", "w", "w", "k", "b", "l", "h", "e"], repeat: 400)
    print("PERF vim normal-mode motion (10k lines, j w k b l h e): \(stats)")
    #expect(stats.average < 12 * Self.multiplier)
    #expect(stats.p95 < 30 * Self.multiplier)
  }

  @Test func normalModeEditsAndUndo() {
    let editor = makeEditor()
    let stats = measure(editor, ["x", "u", "j", "d", "d", "u", "p", "u"], repeat: 400)
    print("PERF vim normal-mode edit (10k lines, x u dd p): \(stats)")
    #expect(stats.average < 12 * Self.multiplier)
    #expect(stats.p95 < 30 * Self.multiplier)
  }
}
