import AppKit
import Testing

@testable import DailyDoListEditor

/// The orchestrator's chips: badges with a chip status, an `anchorText` that must stay
/// recognizable, their own tooltip, and a fade-out when their outcome has been shown.
@Suite("Orchestrator chips")
@MainActor
struct OrchestratorChipTests {
  typealias Chip = EditorBadge.OrchestratorStatus

  private let doc = "Groceries are done\nfind a quiet dishwasher\n- [ ] Renew the passport\nend"

  private func chip(
    _ id: String, line: Int, _ status: String = Chip.looking,
    label: String = "Orchestrator is looking…", anchorText: String = "find a quiet dishwasher",
    isFading: Bool = false
  ) -> EditorBadge {
    EditorBadge(
      id: id, line: line, status: status, label: label,
      tooltip: "The orchestrator is reading your note", anchorText: anchorText,
      isFading: isFading)
  }

  /// Badge lines after one edit applied to a store (pure remapping).
  private func remap(
    _ text: String, badges: [EditorBadge], edit range: NSRange, with replacement: String
  ) -> [String: Int] {
    let storage = NSMutableString(string: text)
    var index = LineIndex(storage)
    var store = BadgeStore()
    store.set(badges, lineIndex: index, text: storage)
    storage.replaceCharacters(in: range, with: replacement)
    let inserted = (replacement as NSString).length
    index.applyEdit(
      location: range.location, oldLength: range.length, newLength: inserted, text: storage)
    store.applyEdit(
      location: range.location, oldLength: range.length, newLength: inserted, lineIndex: index,
      text: storage)
    return Dictionary(
      uniqueKeysWithValues: store.currentBadges(lineIndex: index).map { ($0.id, $0.line) })
  }

  // MARK: Recognizing a line

  @Test func aLineIsRecognizedWhileItStaysTheSameLine() {
    let line = "find a quiet dishwasher"
    #expect(EditorLineMatch.recognizes(line, line))
    #expect(EditorLineMatch.recognizes(line, "  Find a  quiet dishwasher "), "case and blanks")
    #expect(EditorLineMatch.recognizes(line, "find a quiet dishwasher for the flat"), "extended")
    #expect(EditorLineMatch.recognizes(line, "find a qui"), "trimmed back")
    #expect(EditorLineMatch.recognizes(line, "find a quiet dish washer!"), "similar")
    #expect(EditorLineMatch.recognizes(line, "- [ ] find a quiet dishwasher"), "made a task")
    #expect(
      EditorLineMatch.recognizes(line, "find a quiet dishwasher %%agent:thr_1%%"),
      "the agent's marker doesn't count")
  }

  @Test func aRewrittenLineIsNotRecognized() {
    let line = "find a quiet dishwasher"
    #expect(!EditorLineMatch.recognizes(line, "call mom about Sunday"))
    #expect(!EditorLineMatch.recognizes(line, ""))
    #expect(!EditorLineMatch.recognizes(line, "fi"), "too short to extend it")
    #expect(!EditorLineMatch.recognizes("", "anything"))
    #expect(EditorLineMatch.similarity(line, line) == 1)
    #expect(EditorLineMatch.similarity(line, "call mom about Sunday") < EditorLineMatch.threshold)
  }

  // MARK: Mapping through edits

  @Test func aChipFollowsItsLineThroughEditsAroundAndInsideIt() {
    let badges = [chip("c", line: 1)]
    #expect(
      remap(doc, badges: badges, edit: NSRange(location: 0, length: 0), with: "# Today\n")
        == ["c": 2])
    // Typing at the end of the line (still the same request).
    let end = (doc as NSString).range(of: "dishwasher").upperBound
    #expect(
      remap(doc, badges: badges, edit: NSRange(location: end, length: 0), with: " for the flat")
        == ["c": 1])
    // Enter at the start of its line moves it down with the text.
    #expect(
      remap(doc, badges: badges, edit: NSRange(location: 19, length: 0), with: "\n") == ["c": 2])
  }

  @Test func aLineEditedBeyondRecognitionDropsItsChipButNotATaskBadge() {
    let words = (doc as NSString).range(of: "quiet dishwasher")
    let task = EditorBadge(id: "t", line: 1, status: "working", label: "Working…")
    let result = remap(
      doc, badges: [chip("c", line: 1), task], edit: words, with: "new pair of running shoes")
    #expect(result == ["t": 1], "the chip goes; a task badge stays with edits inside its line")
  }

  @Test func typingOverAChipsLineDropsItOnceItIsNoLongerTheSameLine() {
    let editor = EditorHarness(text: doc)
    editor.controller.setBadges([chip("c", line: 1)])
    let start = editor.offset(of: "find a quiet")
    editor.select(NSRange(location: start + 7, length: 16))
    editor.type("q")
    #expect(editor.controller.badges.map(\.id) == ["c"], "“find a q” still extends it")
    editor.select(NSRange(location: start, length: 8))
    editor.type("call mom about Sunday")
    #expect(editor.controller.badges.isEmpty, "rewritten")
  }

  // MARK: Look

  @Test func chipsAreStyledLikeTheTaskBadges() {
    #expect(BadgeTier(status: Chip.noticed) == .quiet)
    #expect(BadgeTier(status: Chip.looking) == .working)
    #expect(BadgeTier(status: Chip.acting) == .working)
    #expect(BadgeTier(status: Chip.done) == .quiet)
    #expect(BadgeTier(status: Chip.nothing) == .quiet)
    #expect(BadgeTier(status: Chip.needsYou) == .needsYou)
    #expect(BadgeStyle.dotColor(Chip.noticed) == BadgeStyle.dotColor("triaging"))
    #expect(BadgeStyle.dotColor(Chip.looking) == BadgeStyle.dotColor("triaging"))
    #expect(BadgeStyle.dotColor(Chip.acting) == BadgeStyle.dotColor("working"))
    #expect(BadgeStyle.dotColor(Chip.done) == BadgeStyle.dotColor("done"))
    #expect(BadgeStyle.dotColor(Chip.needsYou) == BadgeStyle.dotColor("waiting_approval"))
    #expect(BadgeStyle.dotColor(Chip.nothing) == EditorColors.tertiaryText)
    #expect(Set(EditorBadge.pulsingStatuses) == ["triaging", Chip.noticed, Chip.looking])
  }

  @Test func aNoticedChipIsJustAQuietDot() throws {
    let renderer = EditorHarness(text: "").controller.badgeRenderer
    let dot = chip("c", line: 0, Chip.noticed, label: "")
    let pill = chip("c", line: 0)
    #expect(renderer.width(of: dot) < renderer.width(of: pill) / 3)
    #expect(renderer.fitted(dot, maxWidth: 1).label.isEmpty)
    #expect(renderer.fitted(dot, maxWidth: 1).width == renderer.width(of: dot))

    let editor = EditorHarness(text: doc)
    editor.controller.setBadges([dot])
    editor.layout()
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    #expect(layout.rect.width == renderer.width(of: dot))
  }

  @Test func clickingAChipReportsItAndItsTooltipSaysWhatHappened() throws {
    let editor = EditorHarness(text: doc)
    let tooltips = TooltipRecorder()
    editor.controller.tooltipCenter = tooltips.center
    editor.controller.setBadges([
      chip("orchestrator:1", line: 1, Chip.done, label: "Added a task ↗")
    ])
    editor.layout()
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    let point = NSPoint(x: layout.rect.midX, y: layout.rect.midY)
    #expect(
      editor.controller.textView(editor.textView, toolTipAt: point)
        == "The orchestrator is reading your note")
    #expect(editor.controller.handleClick(at: point, modifiers: []))
    #expect(editor.delegate.badgeClicks.map(\.id) == ["orchestrator:1"])
    #expect(editor.delegate.badgeClicks.first?.line == 1)
  }

  // MARK: Motion

  @Test func noticingAndLookingPulseButActingDoesNot() throws {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.layout()
    editor.willDraw()
    editor.controller.setBadges([chip("c", line: 1, Chip.noticed, label: "")])
    #expect(editor.controller.motion.state.isPulsing("c"))
    motion.run(for: 0.3)
    editor.controller.setBadges([chip("c", line: 1)])
    #expect(editor.controller.motion.state.isPulsing("c"), "the pulse carries on as it looks")
    #expect(editor.controller.motion.state.crossfading["c"]?.previous.status == Chip.noticed)
    editor.controller.setBadges([chip("c", line: 1, Chip.acting, label: "Working…")])
    #expect(!editor.controller.motion.state.isPulsing("c"))
  }

  @Test func reduceMotionMeansNoPulsing() throws {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    motion.reduceMotion = true
    editor.layout()
    editor.willDraw()
    editor.controller.setBadges([chip("c", line: 1, Chip.noticed, label: "")])
    editor.willDraw()
    motion.frame(after: 0.6)
    #expect(motion.tickers.isEmpty, "no frames at all")
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    #expect(editor.controller.motion.paint(for: layout.badge, now: motion.now).dotOpacity == 1)
  }

  @Test func aFadingChipFadesOutThenIsGoneButKeepsItsRoom() throws {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.layout()
    editor.willDraw()
    let done = chip("c", line: 1, Chip.done, label: "Added a task ↗")
    editor.controller.setBadges([done])
    motion.run(for: 0.3)
    let column = editor.controller.textContainer.size.width
    var fading = done
    fading.isFading = true
    editor.controller.setBadges([fading])
    #expect(motion.isTicking)
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    let point = NSPoint(x: layout.rect.midX, y: layout.rect.midY)
    #expect(editor.controller.badgeLayout(at: point) == nil, "no clicks while it fades")
    #expect(editor.controller.textView(editor.textView, toolTipAt: point) == nil)

    motion.frame(after: 0.2)
    let middle = editor.controller.motion.paint(for: fading, now: motion.now)
    #expect(middle.opacity > 0 && middle.opacity < 1)
    #expect(editor.controller.motion.state.isVisible(fading))
    motion.run(for: 0.3)
    #expect(!motion.isTicking, "over after 400 ms")
    #expect(!editor.controller.motion.state.isVisible(fading))
    #expect(editor.controller.textContainer.size.width == column, "nothing moves until removed")
    editor.controller.setBadges([])
    #expect(editor.controller.badges.isEmpty)
  }

  @Test func withReduceMotionAFadingChipIsGoneAtOnce() {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.layout()
    editor.willDraw()
    let done = chip("c", line: 1, Chip.nothing, label: "Nothing to do")
    editor.controller.setBadges([done])
    motion.reduceMotion = true
    var fading = done
    fading.isFading = true
    editor.controller.setBadges([fading])
    #expect(!editor.controller.motion.state.hasTransitions)
    #expect(!editor.controller.motion.state.isVisible(fading))
  }

  @Test func aChipThatArrivesFadingNeverShows() {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.layout()
    editor.willDraw()
    let fading = chip("c", line: 1, Chip.done, label: "Replied ↗", isFading: true)
    editor.controller.setBadges([fading])
    #expect(!motion.isTicking)
    #expect(!editor.controller.motion.state.isVisible(fading))
  }
}
