import AppKit
import Foundation
import Testing

@testable import DailyDoListEditor

/// Typing in a 2,000-line note with six drawings (floats on both sides and full-width rows), with
/// the same budgets as `PerformanceTests.keystrokes`: each sample is the keystroke, the layout of
/// its line and the pre-draw pass (where floats are checked). Printed as `PERF …`.
@Suite("Drawing performance", .serialized)
@MainActor
struct DrawingPerformanceTests {
  static let multiplier = PerformanceTests.multiplier

  /// The long sample note with drawings every ~300 lines.
  static let note: String = {
    var lines = SampleNote.long(lines: 2000).components(separatedBy: "\n")
    let embeds = [
      "![[Plan.excalidraw|260|right-wrap]]", "![[Flow.excalidraw]]",
      "![[Plan.excalidraw|200|left-wrap]]", "![[Flow.excalidraw|400|center]]",
      "![[Plan.excalidraw|240|right-wrap]]", "![[Flow.excalidraw|320x160|left]]",
    ]
    for (index, embed) in embeds.enumerated().reversed() {
      lines.insert(embed, at: 150 + index * 300)
    }
    return lines.joined(separator: "\n")
  }()

  static var drawings: [String: EditorDrawingState] {
    [
      "Plan.excalidraw": .ready(TestDrawings.drawing()),
      "Flow.excalidraw": .ready(
        TestDrawings.drawing(
          "Excalidraw/Flow.excalidraw.md",
          scene: TestDrawings.scene(width: 600, height: 160, seed: 5)
        )),
    ]
  }

  func measureTyping(near needle: String, label: String) throws {
    let editor = DrawingEditorHarness(
      text: Self.note, caret: 0, drawings: Self.drawings, size: NSSize(width: 900, height: 800))
    let controller = editor.controller
    let start = editor.offset(of: needle)
    let line = controller.highlighter.lineIndex.line(containing: start)
    controller.scrollToLine(line)
    let caret = controller.highlighter.lineIndex.contentRange(
      ofLine: line, textLength: (editor.text as NSString).length
    ).end
    controller.setSelection([NSRange(location: caret, length: 0)], adjust: false)
    editor.layout()
    controller.textViewWillDraw(editor.textView)
    #expect(controller.highlighter.embedLines.count == 6)
    #expect(!controller.embeds.floats.isEmpty)
    let updates = controller.embeds.exclusionUpdates
    let clock = ContinuousClock()
    var samples: [Double] = []
    editor.undoManager.beginUndoGrouping()
    for index in 0..<PerformanceTests.samples(300) {
      let character = index % 7 == 6 ? " " : "x"
      let elapsed = clock.measure {
        editor.textView.insertText(
          character, replacementRange: NSRange(location: NSNotFound, length: 0))
        let caret = editor.selection.location
        controller.layoutManager.ensureLayout(
          forCharacterRange: NSRange(location: max(0, caret - 1), length: 1))
        controller.textViewWillDraw(editor.textView)
      }
      samples.append(PerformanceTests.milliseconds(elapsed))
    }
    editor.undoManager.endUndoGrouping()
    let stats = PerformanceTests.Stats(samples: Array(samples.dropFirst(5)))
    print("PERF keystroke with 6 drawings, \(label) (+ line layout + pre-draw): \(stats)")
    print(
      "PERF   exclusion path updates while typing: \(controller.embeds.exclusionUpdates - updates)")
    #expect(stats.average < 12 * Self.multiplier)
    #expect(stats.p95 < 30 * Self.multiplier)
  }

  @Test func typingNextToAFloat() throws {
    // The paragraph right after the first float wraps around it.
    let lines = Self.note.components(separatedBy: "\n")
    let after = try #require(lines.firstIndex { $0.hasSuffix("right-wrap]]") }) + 1
    try measureTyping(near: lines[after], label: "next to a float")
  }

  @Test func typingAboveTheFloats() throws {
    // Every keystroke is above all six drawings: floats are checked (never moved) each time.
    let lines = Self.note.components(separatedBy: "\n")
    try measureTyping(near: lines[40], label: "above every drawing")
  }

  @Test func loadingANoteWithDrawings() {
    var samples: [Double] = []
    for _ in 0..<PerformanceTests.samples(5) {
      let editor = DrawingEditorHarness(
        text: "", drawings: Self.drawings, size: NSSize(width: 900, height: 800))
      let clock = ContinuousClock()
      let elapsed = clock.measure {
        editor.controller.setText(Self.note, resetUndo: true)
        editor.controller.textViewWillDraw(editor.textView)
      }
      samples.append(PerformanceTests.milliseconds(elapsed))
    }
    let stats = PerformanceTests.Stats(samples: samples)
    print("PERF load + style + visible layout, 2000 lines with 6 drawings: \(stats)")
    #expect(stats.median < 400 * Self.multiplier)
  }
}
