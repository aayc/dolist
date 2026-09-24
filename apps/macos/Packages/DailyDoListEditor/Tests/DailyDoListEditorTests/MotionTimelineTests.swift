import Foundation
import Testing

@testable import DailyDoListEditor

@Suite("Motion timeline")
struct MotionTimelineTests {
  /// The curve's y at the parameter whose x is closest to `x`, by dense sampling.
  private func bruteForce(_ curve: CubicBezier, _ x: Double) -> Double {
    func coordinate(_ s: Double, _ p1: Double, _ p2: Double) -> Double {
      3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s
    }
    var best = (distance: Double.infinity, y: 0.0)
    for step in 0...20_000 {
      let s = Double(step) / 20_000
      let distance = abs(coordinate(s, curve.x1, curve.x2) - x)
      if distance < best.distance { best = (distance, coordinate(s, curve.y1, curve.y2)) }
    }
    return best.y
  }

  @Test(arguments: [CubicBezier.easeOut, .easeInOut])
  func cubicBezierFollowsTheCurveItDescribes(curve: CubicBezier) {
    #expect(curve(0) == 0)
    #expect(curve(1) == 1)
    #expect(curve(-0.5) == 0, "clamped")
    #expect(curve(1.5) == 1, "clamped")
    var previous = 0.0
    for step in 1..<100 {
      let t = Double(step) / 100
      let y = curve(t)
      #expect(y >= previous, "monotonic at \(t)")
      #expect(abs(y - bruteForce(curve, t)) < 1e-3, "at \(t)")
      previous = y
    }
  }

  @Test func easingsHaveTheirCSSShapes() {
    #expect(abs(CubicBezier.easeInOut(0.5) - 0.5) < 1e-9, "ease-in-out is symmetric")
    #expect(abs(CubicBezier.easeInOut(0.25) + CubicBezier.easeInOut(0.75) - 1) < 1e-9)
    #expect(CubicBezier.easeInOut(0.1) < 0.1, "starts slow")
    #expect(CubicBezier.easeOut(0.5) > 0.6, "ease-out is ahead of linear")
    #expect(CubicBezier.easeOut(0.9) > 0.97, "and lands softly")
  }

  @Test func aBadgeFadesInWhileSettling2ptUpwardsIn160ms() {
    let start = MotionTimeline.appear(after: 0)
    #expect(start.opacity == 0)
    #expect(start.offsetY == 2)
    let middle = MotionTimeline.appear(after: 0.08)
    #expect(middle.opacity > 0.5 && middle.opacity < 1)
    #expect(abs(middle.offsetY - 2 * (1 - middle.opacity)) < 1e-9, "moves as it fades")
    let end = MotionTimeline.appear(after: 0.16)
    #expect(end.opacity == 1)
    #expect(end.offsetY == 0)
    #expect(MotionTimeline.appear(after: 5).opacity == 1)
    #expect(MotionTimeline.appear(after: -1).opacity == 0, "a clock that went backwards")
  }

  @Test func aCrossfadeTakes160ms() {
    #expect(MotionTimeline.crossfade(after: 0) == 0)
    #expect(MotionTimeline.crossfade(after: 0.08) > 0.5)
    #expect(MotionTimeline.crossfade(after: 0.16) == 1)
  }

  @Test func theTriagingDotBreathesDownTo35PercentAndBackEvery1_2s() {
    #expect(MotionTimeline.pulse(after: 0) == 1)
    #expect(abs(MotionTimeline.pulse(after: 0.6) - 0.35) < 1e-9)
    #expect(abs(MotionTimeline.pulse(after: 1.2) - 1) < 1e-9)
    // Ease-in-out on each half: halfway down at a quarter period, halfway up at three quarters.
    #expect(abs(MotionTimeline.pulse(after: 0.3) - 0.675) < 1e-9)
    #expect(abs(MotionTimeline.pulse(after: 0.9) - 0.675) < 1e-9)
    #expect(MotionTimeline.pulse(after: 0.1) > 0.95, "eases out of full opacity")
    #expect(MotionTimeline.pulse(after: 0.2) > MotionTimeline.pulse(after: 0.4), "going down")
    #expect(MotionTimeline.pulse(after: 0.8) < MotionTimeline.pulse(after: 1.0), "coming back")
    #expect(abs(MotionTimeline.pulse(after: 12 * 1.2 + 0.6) - 0.35) < 1e-6, "repeats")
  }

  @Test func aCheckmarkScalesFrom80PercentWhileFadingInIn120ms() {
    let start = MotionTimeline.check(after: 0)
    #expect(start.scale == 0.8)
    #expect(start.opacity == 0)
    let middle = MotionTimeline.check(after: 0.06)
    #expect(middle.scale > 0.9 && middle.scale < 1)
    #expect(middle.opacity > 0.5 && middle.opacity < 1)
    let end = MotionTimeline.check(after: 0.12)
    #expect(end.scale == 1)
    #expect(end.opacity == 1)
  }
}

@Suite("Motion state")
struct MotionStateTests {
  private func badge(
    _ id: String, _ status: String = "working", label: String = "Working…", unread: Int = 0, line: Int = 0
  ) -> EditorBadge {
    EditorBadge(id: id, line: line, status: status, label: label, unread: unread)
  }

  @Test func aDocumentsFirstBadgesJustAppear() {
    var state = MotionState()
    state.setBadges([badge("a"), badge("b", "done", label: "Done")], now: 0, animated: false)
    #expect(!state.hasTransitions)
    #expect(state.paint(for: badge("a"), now: 0, pulses: true) == .rest)
  }

  @Test func onlyBadgesWithANewIdFadeIn() {
    var state = MotionState()
    state.setBadges([badge("a", line: 1)], now: 0, animated: false)
    // "a" was remapped to another line by typing; "b" is new.
    state.setBadges([badge("a", line: 4), badge("b", "queued", label: "Queued")], now: 1, animated: true)
    #expect(state.isTransitioning("b"))
    #expect(!state.isTransitioning("a"), "moving to another line isn't appearing")
    let paint = state.paint(for: badge("b", "queued", label: "Queued"), now: 1)
    #expect(paint.opacity == 0)
    #expect(paint.offsetY == MotionTimeline.appearDistance)
    // Set again with the same id and look: nothing new starts.
    state.prune(now: 2)
    state.setBadges([badge("a", line: 4), badge("b", "queued", label: "Queued")], now: 2, animated: true)
    #expect(!state.hasTransitions)
  }

  @Test func aChangedLookCrossfadesFromTheOldOne() {
    var state = MotionState()
    let working = badge("a")
    let done = badge("a", "done", label: "Done · 3 options")
    state.setBadges([working], now: 0, animated: false)
    state.setBadges([done], now: 1, animated: true)
    let paint = state.paint(for: done, now: 1.04)
    #expect(paint.previous == working)
    #expect(paint.previousOpacity > 0 && paint.previousOpacity < 1)
    #expect(paint.opacity == 1, "a crossfade isn't a fade-in")
    #expect(state.paint(for: done, now: 1.2) == .rest)
  }

  @Test func onlyVisibleChangesCrossfade() {
    var state = MotionState()
    state.setBadges([badge("a", unread: 2)], now: 0, animated: false)
    state.setBadges([badge("a", unread: 3)], now: 1, animated: true)
    #expect(!state.hasTransitions, "the unread dot looks the same for 2 and 3")
    state.setBadges([badge("a", unread: 0)], now: 2, animated: true)
    #expect(state.isTransitioning("a"), "the dot went away")
    state.setBadges([badge("a", label: "Comparing fares")], now: 3, animated: true)
    #expect(state.crossfading["a"]?.previous.unread == 0)
  }

  @Test func triagingBadgesPulseFromWhenTheyStartedTriaging() {
    var state = MotionState()
    let triaging = badge("a", "triaging", label: "Triaging…")
    state.setBadges([triaging], now: 5, animated: false)
    #expect(state.isPulsing("a"))
    state.setBadges([triaging], now: 7, animated: true)
    #expect(abs(state.paint(for: triaging, now: 5.6, pulses: true).dotOpacity - 0.35) < 1e-9, "phase kept from 5 s")
    #expect(state.paint(for: triaging, now: 5.6, pulses: false).dotOpacity == 1, "a stopped pulse is solid")
    state.setBadges([badge("a")], now: 8, animated: true)
    #expect(!state.isPulsing("a"))
    #expect(!state.hasPulses)
  }

  @Test func badgesThatGoAwayStopMoving() {
    var state = MotionState()
    state.setBadges([badge("a", "triaging")], now: 0, animated: false)
    state.setBadges([badge("a", "triaging"), badge("b")], now: 1, animated: true)
    state.setBadges([], now: 1.05, animated: true)
    #expect(state.isIdle)
    #expect(state.known.isEmpty)
  }

  @Test func hiddenStatusesNeverMoveAndShowingUpLaterIsAppearing() {
    var state = MotionState()
    state.setBadges([badge("a", "idle"), badge("b", "ignored")], now: 0, animated: true)
    #expect(state.isIdle)
    state.setBadges([badge("a", "triaging")], now: 1, animated: true)
    #expect(state.isTransitioning("a"))
    #expect(state.isPulsing("a"))
  }

  @Test func transitionsEndAfterTheirDurations() {
    var state = MotionState()
    state.setBadges([badge("a")], now: 0, animated: false)
    state.setBadges([badge("a", "done"), badge("b")], now: 1, animated: true)
    state.checked(statusOffset: 3, now: 1)
    state.prune(now: 1.13)
    #expect(state.checkOffsets.isEmpty, "a checkmark takes 120 ms")
    #expect(state.isTransitioning("a") && state.isTransitioning("b"), "badges take 160 ms")
    state.prune(now: 1.17)
    #expect(!state.hasTransitions)
    state.checked(statusOffset: 3, now: 2)
    state.finishTransitions()
    #expect(!state.hasTransitions)
  }

  @Test func checkmarksFollowEditsAndStopWhenTheirCharacterIsReplaced() {
    var state = MotionState()
    state.checked(statusOffset: 20, now: 0)
    state.checked(statusOffset: 40, now: 0)
    state.applyEdit(location: 25, oldLength: 2, newLength: 5)
    #expect(Set(state.checkOffsets) == [20, 43])
    state.applyEdit(location: 0, oldLength: 0, newLength: 1)
    #expect(Set(state.checkOffsets) == [21, 44])
    state.applyEdit(location: 44, oldLength: 1, newLength: 1)
    #expect(state.checkOffsets == [21])
    let paint = state.checkPaint(statusOffset: 21, now: 0.06)
    #expect(paint.map { $0.opacity > 0 && $0.opacity < 1 } == true)
    #expect(state.checkPaint(statusOffset: 21, now: 0.2) == nil)
  }

  @Test func checkedOffsetsAreThoseOfTasksToggledToDoneAfterTheEdit() throws {
    let text = "plain\n- [ ] open\n- [x] done" as NSString
    let edit = try #require(TaskCommands.toggleChecklist(in: text, selection: [NSRange(location: 0, length: text.length)]))
    let after = edit.applied(to: text as String) as NSString
    #expect(after as String == "- [ ] plain\n- [x] open\n- [ ] done")
    let offsets = TaskCommands.checkedStatusOffsets(in: edit)
    #expect(offsets == [after.range(of: "[x] open").location + 1])
    let single = try #require(TaskCommands.toggleTask(in: text, lineContaining: 7))
    #expect(TaskCommands.checkedStatusOffsets(in: TextEdit(replacements: [single], selection: [])) == [9])
    let reopen = try #require(TaskCommands.toggleTask(in: text, lineContaining: 20))
    #expect(TaskCommands.checkedStatusOffsets(in: TextEdit(replacements: [reopen], selection: [])).isEmpty)
  }
}
