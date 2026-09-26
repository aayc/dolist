import AppKit
import DailyDoListUITestSupport
import Testing

@testable import DailyDoListEditor

/// Robustness: random (and adversarial) input must never crash, and every range must stay inside
/// its line or document.
@Suite("Fuzzing")
@MainActor
struct FuzzTests {
  private static let alphabet: [UInt16] =
    Array(
      "*_`~=[]()<>!#|\\-+>. \t:/xyzhtpsw1234567890aé\u{00A0}".utf16)
    + [0xD83D, 0xDE00, 0xD800, 0xDC00, 0x0000, 0x000D, 0x2028, 0x301C]

  private func randomLine(_ rng: inout SeededGenerator, maxLength: Int) -> [UInt16] {
    let length = Int.random(in: 0...maxLength, using: &rng)
    return (0..<length).map { _ in Self.alphabet.randomElement(using: &rng)! }
  }

  private func check(_ tokens: LineTokens, length: Int, _ context: @autoclosure () -> String) {
    var ranges =
      tokens.spans.map(\.range) + tokens.markers.map(\.range) + tokens.links.map(\.range)
      + tokens.tags.map(\.range)
    if let task = tokens.task { ranges += [task.markerRange, task.boxRange, task.textRange] }
    if let marker = tokens.listMarker { ranges.append(marker) }
    for range in ranges where range.location < 0 || range.length < 0 || range.end > length {
      Issue.record("range \(range) outside 0..<\(length): \(context())")
    }
    let markers = tokens.markers.map(\.range).sorted { $0.location < $1.location }
    for (a, b) in zip(markers, markers.dropFirst()) where a.end > b.location {
      Issue.record("overlapping markers \(a) \(b): \(context())")
    }
  }

  @Test func tokenizerNeverTrapsOnRandomLines() {
    var rng = SeededGenerator(seed: 42)
    let states: [BlockState] = [.normal, .fence(marker: UTF16Unit.backtick, length: 3)]
    for _ in 0..<5000 {
      let line = randomLine(&rng, maxLength: 120)
      for state in states {
        let (tokens, _) = MarkdownTokenizer.tokenizeLine(line, state: state)
        check(tokens, length: line.count, String(decoding: line, as: UTF16.self).debugDescription)
      }
    }
  }

  @Test func pathologicalLinesStayFast() {
    let patterns: [String] = [
      String(repeating: "*a", count: 5000), String(repeating: "_", count: 10000),
      String(repeating: "`", count: 10000),
      String(repeating: "` ", count: 5000), String(repeating: "[", count: 10000),
      String(repeating: "[[a", count: 3000),
      String(repeating: "](", count: 5000), "https://x.com/" + String(repeating: ")", count: 10000),
      String(repeating: "**_~~==", count: 1500), String(repeating: "<a", count: 5000),
      String(repeating: "#a ", count: 3000),
      String(repeating: "[a](b", count: 2000), String(repeating: "\\*", count: 5000),
    ]
    let clock = ContinuousClock()
    for pattern in patterns {
      let units = Array(pattern.utf16)
      var tokens: LineTokens?
      let elapsed = clock.measure {
        tokens = MarkdownTokenizer.tokenizeLine(units, state: .normal).tokens
      }
      check(tokens!, length: units.count, String(pattern.prefix(20)))
      #expect(
        PerformanceTests.milliseconds(elapsed) < 1000, "\(pattern.prefix(12))… took \(elapsed)")
    }
  }

  /// Legacy scrollers (a mouse, or "show scroll bars: always") show and hide as the document
  /// outgrows the view, which changes the clip view's width while edits are processed.
  @Test(arguments: [NSScroller.Style.overlay, .legacy])
  func editorSurvivesRandomEditsSelectionsAndDrawing(scrollers: NSScroller.Style) throws {
    var rng = SeededGenerator(seed: 9)
    let editor = EditorHarness(text: SampleNote.text, size: NSSize(width: 700, height: 500))
    let controller = editor.controller
    controller.scrollView.scrollerStyle = scrollers
    controller.setBadges(SampleNote.badges(for: editor.text))
    let storage = controller.storage
    for step in 0..<400 {
      let length = storage.length
      let location = Int.random(in: 0...length, using: &rng)
      let range = NSRange(location: location, length: Int.random(in: 0...8, using: &rng)).clamped(
        to: length)
      let units =
        randomLine(&rng, maxLength: 6) + (Bool.random(using: &rng) ? [UTF16Unit.newline] : [])
      let replacement = NSString(characters: units, length: units.count) as String
      editor.act { storage.replaceCharacters(in: range, with: replacement) }
      let selection = NSRange(location: Int.random(in: 0...storage.length, using: &rng), length: 0)
      editor.textView.setSelectedRange(
        Bool.random(using: &rng)
          ? selection
          : NSRange(
            location: selection.location, length: min(5, storage.length - selection.location)))
      if step % 20 == 0 {
        var configuration = controller.configuration
        configuration.livePreview.toggle()
        controller.configure(configuration)
      }
      if step % 25 == 0 {
        editor.layout()
        _ = editor.textView.bitmap(in: editor.textView.visibleRect)
        _ = controller.checkboxRects()
        _ = controller.currentBadgeLayouts()
      }
      #expect(controller.highlighter.lineIndex == LineIndex(storage.mutableString))
    }
    // Commands on arbitrary text must not trap either.
    for _ in 0..<200 {
      let offset = Int.random(in: 0...storage.length, using: &rng)
      editor.select(NSRange(location: offset, length: 0))
      switch Int.random(in: 0..<6, using: &rng) {
      case 0: editor.enter()
      case 1: editor.tab()
      case 2: editor.backtab()
      case 3: editor.backspace()
      case 4: editor.command { $0.toggleChecklist() }
      default: editor.command { $0.toggleBold() }
      }
    }
    #expect(controller.highlighter.lineIndex == LineIndex(storage.mutableString))
  }
}
