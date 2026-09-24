import AppKit
import Testing

@testable import DailyDoListEditor

/// Motion driven through the controller with a manual clock and ticker: what starts it, what it
/// redraws, and that frames stop as soon as nothing on screen moves.
@Suite("Motion in the editor")
@MainActor
struct EditorMotionTests {
  private let doc = "- [ ] one\n- [ ] two\n- [ ] three"

  private func badge(_ id: String, line: Int, _ status: String = "working", label: String? = nil) -> EditorBadge {
    EditorBadge(id: id, line: line, status: status, label: label ?? "Label \(id)")
  }

  /// An editor whose document has been drawn, with hand-driven motion.
  private func shownEditor(_ text: String? = nil) -> (EditorHarness, ManualMotion) {
    let editor = EditorHarness(text: text ?? doc)
    let motion = ManualMotion(editor)
    editor.layout()
    editor.willDraw()
    return (editor, motion)
  }

  private func paint(_ editor: EditorHarness, _ motion: ManualMotion, id: String) throws -> BadgePaint {
    let layout = try #require(editor.controller.currentBadgeLayouts().first { $0.badge.id == id })
    return editor.controller.motion.paint(for: layout.badge, now: motion.now)
  }

  private func click(_ editor: EditorHarness, checkboxOnLine line: Int) throws -> NSRect {
    let checkbox = try #require(editor.controller.checkboxRects().first { $0.line == line })
    #expect(editor.controller.handleClick(at: NSPoint(x: checkbox.rect.midX, y: checkbox.rect.midY), modifiers: []))
    return checkbox.rect
  }

  @Test func anIdleEditorNeverStartsFrames() {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.controller.setBadges([badge("a", line: 0), badge("b", line: 1, "done")])
    editor.layout()
    editor.willDraw()
    editor.select(NSRange(location: 9, length: 0))
    editor.type(" more\nfour")
    editor.controller.setBadges(editor.controller.badges)
    editor.select(NSRange(location: 0, length: 0))
    editor.willDraw()
    #expect(motion.tickers.isEmpty, "no display link while nothing moves")
    #expect(motion.invalidated.isEmpty)
    #expect(!editor.controller.motion.state.hasTransitions)
  }

  @Test func aNewBadgeFadesInOnceThenFramesStop() throws {
    let (editor, motion) = shownEditor()
    editor.controller.setBadges([badge("a", line: 0)])
    #expect(motion.isTicking)
    let start = try paint(editor, motion, id: "a")
    #expect(start.opacity == 0)
    #expect(start.offsetY == MotionTimeline.appearDistance)

    motion.frame(after: 0.08)
    let middle = try paint(editor, motion, id: "a")
    #expect(middle.opacity > 0.3 && middle.opacity < 1)
    let rect = try #require(editor.controller.currentBadgeLayouts().first).rect
    let area = rect.insetBy(dx: -2, dy: -2).union(rect.offsetBy(dx: 0, dy: MotionTimeline.appearDistance + 1))
    #expect(!motion.invalidated.isEmpty)
    #expect(motion.invalidated.allSatisfy { area.contains($0) }, "only the badge is redrawn")

    motion.frame(after: 0.1)
    #expect(!motion.isTicking, "over after 160 ms")
    #expect(try paint(editor, motion, id: "a") == .rest)

    editor.controller.setBadges([badge("a", line: 0)])
    #expect(!motion.isTicking, "the same badge set again doesn't move")
  }

  @Test func typingRemapsBadgesWithoutAnimatingThem() {
    let (editor, motion) = shownEditor()
    editor.controller.setBadges([badge("a", line: 1)])
    motion.run(for: 0.3)
    #expect(!motion.isTicking)
    editor.select(NSRange(location: 0, length: 0))
    editor.type("# Title\n")
    #expect(editor.controller.badges.first?.line == 2)
    editor.controller.setBadges(editor.controller.badges)
    #expect(!motion.isTicking)
    #expect(!editor.controller.motion.state.hasTransitions)
  }

  @Test func aStatusChangeCrossfadesFromTheOldLook() throws {
    let (editor, motion) = shownEditor()
    editor.controller.setBadges([badge("a", line: 0, "working", label: "Working…")])
    motion.run(for: 0.3)
    editor.controller.setBadges([badge("a", line: 0, "done", label: "Done · a much longer summary")])
    #expect(motion.isTicking)
    motion.clearInvalidated()
    motion.frame(after: 0.05)
    let paint = try paint(editor, motion, id: "a")
    #expect(paint.previous?.status == "working")
    #expect(paint.previousOpacity > 0 && paint.previousOpacity < 1)
    #expect(paint.opacity == 1, "a crossfade isn't a fade-in")
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    let old = editor.controller.badgeRenderer.fitted(try #require(paint.previous), maxWidth: layout.available)
    #expect(motion.invalidated.contains { $0.width >= max(layout.rect.width, old.width) }, "old and new pills are redrawn")
    motion.run(for: 0.2)
    #expect(!motion.isTicking)
    #expect(try self.paint(editor, motion, id: "a") == .rest)
  }

  @Test func triagingPulsesOnlyWhileItIsOnScreen() throws {
    let text = (["- [ ] triage me"] + (1..<200).map { "line \($0)" }).joined(separator: "\n")
    let editor = EditorHarness(text: text, size: NSSize(width: 900, height: 300))
    let motion = ManualMotion(editor)
    editor.controller.setBadges([badge("a", line: 0, "triaging", label: "Triaging…")])
    #expect(!motion.isTicking, "a document's first badges don't fade in")
    editor.layout()
    editor.willDraw()
    #expect(motion.isTicking, "the pulse runs once the badge is drawn")

    motion.clearInvalidated()
    motion.frame(after: 0.6)
    #expect(abs(try paint(editor, motion, id: "a").dotOpacity - MotionTimeline.pulseLowOpacity) < 0.01)
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    let dot = editor.controller.badgeRenderer.dotRect(in: layout.rect).insetBy(dx: -1, dy: -1)
    #expect(!motion.invalidated.isEmpty)
    #expect(motion.invalidated.allSatisfy { $0 == dot }, "only the dot is redrawn")

    editor.controller.scrollToLine(199)
    motion.frame()
    #expect(!motion.isTicking, "scrolled out of view")
    editor.controller.scrollToLine(0)
    editor.willDraw()
    #expect(motion.isTicking, "back in view")

    editor.controller.setBadges([badge("a", line: 0, "working", label: "Working…")])
    motion.run(for: 0.3)
    #expect(!motion.isTicking, "no pulse once it stops triaging")
    #expect(try paint(editor, motion, id: "a") == .rest)
  }

  @Test func reduceMotionTurnsEverythingOff() throws {
    let (editor, motion) = shownEditor()
    motion.reduceMotion = true
    editor.controller.setBadges([badge("a", line: 0), badge("t", line: 1, "triaging")])
    editor.willDraw()
    _ = try click(editor, checkboxOnLine: 2)
    #expect(editor.text.hasSuffix("- [x] three"))
    #expect(motion.tickers.isEmpty)
    #expect(editor.controller.motion.state.checkOffsets.isEmpty)
    #expect(try paint(editor, motion, id: "a") == .rest)
    #expect(try paint(editor, motion, id: "t").dotOpacity == 1)
  }

  @Test func turningOnReduceMotionStopsAPulseAtTheNextFrame() throws {
    let editor = EditorHarness(text: doc)
    let motion = ManualMotion(editor)
    editor.controller.setBadges([badge("t", line: 1, "triaging")])
    editor.layout()
    editor.willDraw()
    motion.frame(after: 0.3)
    #expect(try paint(editor, motion, id: "t").dotOpacity < 1)
    motion.reduceMotion = true
    motion.frame()
    #expect(!motion.isTicking)
    #expect(try paint(editor, motion, id: "t").dotOpacity == 1, "the dot is solid again")
  }

  @Test func hiddenWindowsDoNotAnimate() {
    let (editor, motion) = shownEditor()
    motion.isOnScreen = false
    editor.controller.setBadges([badge("a", line: 0)])
    #expect(motion.tickers.isEmpty)
    #expect(!editor.controller.motion.state.hasTransitions)

    motion.isOnScreen = true
    editor.controller.setBadges([badge("a", line: 0), badge("t", line: 1, "triaging")])
    #expect(motion.isTicking)
    motion.isOnScreen = false
    motion.frame()
    #expect(!motion.isTicking, "minimized or covered: frames stop")
    #expect(!editor.controller.motion.state.hasTransitions)
  }

  @Test func checkingATaskPopsItsCheckmarkIn() throws {
    let (editor, motion) = shownEditor()
    let checkbox = try click(editor, checkboxOnLine: 1)
    #expect(editor.text == "- [ ] one\n- [x] two\n- [ ] three")
    let status = editor.offset(of: "[x] two") + 1
    #expect(editor.controller.motion.state.checkOffsets == [status])
    #expect(motion.isTicking)
    let start = try #require(editor.controller.motion.checkPaint(statusOffset: status))
    #expect(start.scale == MotionTimeline.checkStartScale)
    #expect(start.opacity == 0)

    motion.clearInvalidated()
    motion.frame(after: 0.06)
    let middle = try #require(editor.controller.motion.checkPaint(statusOffset: status))
    #expect(middle.scale > start.scale && middle.opacity > 0)
    #expect(!motion.invalidated.isEmpty)
    #expect(motion.invalidated.allSatisfy { checkbox.insetBy(dx: -1.5, dy: -1.5).contains($0) }, "only the checkbox is redrawn")

    motion.frame(after: 0.07)
    #expect(!motion.isTicking, "over after 120 ms")
    #expect(editor.controller.motion.checkPaint(statusOffset: status) == nil)

    _ = try click(editor, checkboxOnLine: 1)
    #expect(editor.text == doc)
    #expect(!motion.isTicking, "unchecking doesn't animate")
  }

  @Test func theChecklistShortcutPopsOnlyTheTasksItChecks() {
    let (editor, motion) = shownEditor("plain\n- [ ] open\n- [x] done")
    editor.select(NSRange(location: 0, length: (editor.text as NSString).length))
    #expect(editor.controller.toggleChecklist())
    #expect(editor.text == "- [ ] plain\n- [x] open\n- [ ] done")
    #expect(editor.controller.motion.state.checkOffsets == [editor.offset(of: "[x] open") + 1])
    #expect(motion.isTicking)
    editor.type("typing moves it along")
    #expect(editor.controller.motion.state.checkOffsets.isEmpty, "its character was replaced")
  }

  @Test func aNoteSwitchStartsOverAndItsBadgesJustAppear() {
    let (editor, motion) = shownEditor()
    editor.controller.setBadges([badge("a", line: 0)])
    #expect(motion.isTicking)
    editor.controller.restore(EditorSnapshot(text: "- [ ] elsewhere\n- [ ] more"))
    #expect(!motion.isTicking)
    #expect(editor.controller.motion.state.isIdle)
    editor.controller.setBadges([badge("b", line: 1)])
    #expect(!editor.controller.motion.state.hasTransitions, "the note's badges show with it")
    editor.layout()
    editor.willDraw()
    editor.controller.setBadges([badge("b", line: 1), badge("c", line: 0)])
    #expect(editor.controller.motion.state.isTransitioning("c"), "badges that come later animate in")
    #expect(!editor.controller.motion.state.isTransitioning("b"))
  }

  @Test func windowlessEditorsNeverCreateADisplayLink() {
    let editor = EditorHarness(text: doc)
    editor.layout()
    editor.willDraw()
    editor.controller.setBadges([badge("a", line: 0), badge("t", line: 1, "triaging")])
    editor.willDraw()
    #expect(!editor.controller.motion.isTicking, "the live environment: no window, no frames")
    #expect(!editor.controller.motion.state.hasTransitions)
  }

  @Test func theDisplayLinkTickerExistsOnlyWhileRunning() {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
    let ticker = DisplayLinkTicker(view: view) {}
    #expect(!ticker.isRunning)
    ticker.start()
    #expect(ticker.isRunning)
    ticker.stop()
    #expect(!ticker.isRunning)
    let orphan = DisplayLinkTicker(view: nil) {}
    orphan.start()
    #expect(!orphan.isRunning, "no view, no link")
  }
}
