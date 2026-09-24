import AppKit
import Foundation
import Testing

@testable import DailyDoListEditor

/// Offscreen timings on a 2,000-line note with mixed markdown and 30 badges. Targets (release):
/// load + style < 60 ms, keystroke avg < 3 ms / p95 < 8 ms, selection change < 2 ms. Assertions use
/// generous budgets (debug builds are several times slower), scaled by
/// `EDITOR_PERF_BUDGET_MULTIPLIER`; the measured numbers are printed (`PERF …`).
@Suite("Performance", .serialized)
@MainActor
struct PerformanceTests {
  static let multiplier = Double(ProcessInfo.processInfo.environment["EDITOR_PERF_BUDGET_MULTIPLIER"] ?? "") ?? 1
  static let note = SampleNote.long(lines: 2000)

  struct Stats: CustomStringConvertible {
    var samples: [Double]
    var average: Double { samples.reduce(0, +) / Double(Swift.max(samples.count, 1)) }
    var p95: Double { percentile(0.95) }
    var median: Double { percentile(0.5) }
    var max: Double { samples.max() ?? 0 }
    func percentile(_ p: Double) -> Double {
      let sorted = samples.sorted()
      guard !sorted.isEmpty else { return 0 }
      return sorted[Swift.min(sorted.count - 1, Int((Double(sorted.count) * p).rounded(.up)) - 1)]
    }
    var description: String {
      String(format: "avg %.3f ms, p50 %.3f ms, p95 %.3f ms, max %.3f ms (n=%d)", average, median, p95, max, samples.count)
    }
  }

  static func milliseconds(_ duration: Duration) -> Double {
    let (seconds, attoseconds) = duration.components
    return Double(seconds) * 1000 + Double(attoseconds) / 1e15
  }

  private func makeEditor() -> EditorHarness {
    let editor = EditorHarness(text: "", size: NSSize(width: 900, height: 800))
    return editor
  }

  private func badges(for editor: EditorHarness) -> [EditorBadge] {
    let lines = editor.text.components(separatedBy: "\n")
    let taskLines = lines.indices.filter { lines[$0].hasPrefix("- [") }
    let statuses = ["working", "done", "waiting_approval", "queued", "triaging", "failed"]
    return taskLines.prefix(30).enumerated().map { index, line in
      EditorBadge(id: "t\(index)", line: line, status: statuses[index % statuses.count], label: "Agent status \(index)", unread: index % 3)
    }
  }

  @Test func initialLoadAndStyle() {
    var samples: [Double] = []
    for _ in 0..<5 {
      let editor = makeEditor()
      let clock = ContinuousClock()
      let elapsed = clock.measure {
        editor.controller.setText(Self.note, resetUndo: true)
        let origin = editor.textView.textContainerOrigin
        editor.controller.layoutManager.ensureLayout(
          forBoundingRect: editor.textView.visibleRect.offsetBy(dx: -origin.x, dy: -origin.y),
          in: editor.controller.textContainer)
      }
      samples.append(Self.milliseconds(elapsed))
    }
    let stats = Stats(samples: samples)
    print("PERF initial load + style (2000 lines): \(stats)")
    #expect(stats.median < 400 * Self.multiplier)
  }

  @Test func keystrokes() {
    let editor = makeEditor()
    editor.controller.setText(Self.note, resetUndo: true)
    editor.controller.noteUndoManager.groupsByEvent = false
    editor.controller.setBadges(badges(for: editor))
    let start = editor.offset(of: "Research flights") + (Self.note as NSString).length / 2
    let line = editor.controller.highlighter.lineIndex.line(containing: start)
    let caret = editor.controller.highlighter.lineIndex.contentRange(ofLine: line, textLength: (editor.text as NSString).length).end
    editor.select(NSRange(location: caret, length: 0))
    editor.controller.scrollToLine(line)
    editor.layout()
    let clock = ContinuousClock()
    var samples: [Double] = []
    editor.act {
      for index in 0..<300 {
        let character = index % 7 == 6 ? " " : "x"
        let elapsed = clock.measure {
          editor.textView.insertText(character, replacementRange: NSRange(location: NSNotFound, length: 0))
          let caret = editor.selection.location
          editor.controller.layoutManager.ensureLayout(forCharacterRange: NSRange(location: max(0, caret - 1), length: 1))
        }
        samples.append(Self.milliseconds(elapsed))
      }
    }
    let stats = Stats(samples: Array(samples.dropFirst(5)))
    print("PERF keystroke (insertText + restyle + badge remap + line layout, 30 badges): \(stats)")
    #expect(editor.controller.badges.count == 30)
    #expect(stats.average < 12 * Self.multiplier)
    #expect(stats.p95 < 30 * Self.multiplier)
  }

  @Test func selectionChangesWithLivePreview() {
    let editor = makeEditor()
    editor.controller.setText(Self.note, resetUndo: true)
    editor.controller.setBadges(badges(for: editor))
    editor.controller.scrollToLine(1000)
    editor.layout()
    let index = editor.controller.highlighter.lineIndex
    let clock = ContinuousClock()
    var handling: [Double] = []
    var withLayout: [Double] = []
    for step in 0..<200 {
      let target = index.start(ofLine: 1000 + step % 40) + 1
      let elapsed = clock.measure {
        editor.textView.setSelectedRange(NSRange(location: target, length: 0))
      }
      handling.append(Self.milliseconds(elapsed))
      let relayout = clock.measure {
        editor.controller.layoutManager.ensureLayout(forCharacterRange: NSRange(location: target, length: 0))
      }
      withLayout.append(Self.milliseconds(elapsed) + Self.milliseconds(relayout))
    }
    let stats = Stats(samples: handling)
    let total = Stats(samples: withLayout)
    print("PERF selection change (live preview state + glyph invalidation): \(stats)")
    print("PERF selection change + relayout of the revealed lines: \(total)")
    #expect(stats.average < 6 * Self.multiplier)
    #expect(total.p95 < 20 * Self.multiplier)
  }

  /// Before each draw: badge layouts, sparkles and link tooltip areas of the visible lines (every
  /// tenth line is the agent's).
  @Test func preDrawBookkeeping() {
    let editor = makeEditor()
    let note = Self.note.components(separatedBy: "\n").enumerated().map { index, line in
      index % 10 == 3 && !line.isEmpty ? "\(line) %%agent:thr_\(index)%%" : line
    }.joined(separator: "\n")
    editor.controller.setText(note, resetUndo: true)
    editor.controller.setBadges(badges(for: editor))
    editor.controller.scrollToLine(1000)
    editor.layout()
    let clock = ContinuousClock()
    var samples: [Double] = []
    for _ in 0..<100 {
      let elapsed = clock.measure { editor.controller.textViewWillDraw(editor.textView) }
      samples.append(Self.milliseconds(elapsed))
    }
    let stats = Stats(samples: Array(samples.dropFirst(2)))
    print("PERF pre-draw (badge layouts, sparkles, link tooltip areas): \(stats)")
    #expect(!editor.controller.agentSparkles().isEmpty)
    #expect(stats.average < 4 * Self.multiplier)
  }

  @Test func tokenizerThroughput() {
    let clock = ContinuousClock()
    var lines = 0
    let elapsed = clock.measure {
      lines = MarkdownTokenizer.tokenize(Self.note).count
    }
    print("PERF tokenize 2000-line note (pure): \(String(format: "%.3f", Self.milliseconds(elapsed))) ms")
    #expect(lines == 2000)
    #expect(Self.milliseconds(elapsed) < 300 * Self.multiplier)
  }
}
