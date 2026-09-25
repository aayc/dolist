import Testing

@testable import DailyDoListUI

/// The tooltip timing, on virtual time (nothing sleeps).
@MainActor
@Suite("Tooltip timing")
struct TooltipCenterTests {
  let h = CenterHarness()

  @Test func opensAfterHalfASecondOnTheSameTarget() {
    let newNote = FakeTarget("New note")
    h.center.pointerEntered(newNote)
    h.clock.advance(by: 0.49)
    #expect(h.presenter.calls.isEmpty)
    #expect(h.center.pendingTarget === newNote)
    h.clock.advance(by: 0.01)
    #expect(h.presenter.calls == [.show("New note", .enter, reduced: false, duration: 0.14)])
    #expect(h.center.shownTarget === newNote)
  }

  @Test func leavingBeforeTheDelayShowsNothing() {
    let target = FakeTarget("Back")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.3)
    h.center.pointerExited(target)
    h.clock.advance(by: 1)
    #expect(h.presenter.calls.isEmpty)
    #expect(!h.center.isListening, "nothing pending: no event monitors")
  }

  @Test func movingToAnotherTargetBeforeTheDelayRestartsIt() {
    let back = FakeTarget("Back")
    let forward = FakeTarget("Forward")
    h.center.pointerEntered(back)
    h.clock.advance(by: 0.4)
    h.center.pointerExited(back)
    h.center.pointerEntered(forward)
    h.clock.advance(by: 0.4)
    #expect(h.presenter.calls.isEmpty, "the delay starts over on the new target")
    h.clock.advance(by: 0.1)
    #expect(h.presenter.calls == [.show("Forward", .enter, reduced: false, duration: 0.14)])
  }

  @Test func leavingFadesItOut() {
    let target = FakeTarget("New note")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    h.center.pointerExited(target)
    #expect(h.presenter.calls == [.hide(.exit, duration: 0.09)])
    #expect(h.center.shownTarget == nil)
  }

  @Test func warmModeShowsTheNextOneAtOnceAndGlides() {
    let back = FakeTarget("Back")
    let forward = FakeTarget("Forward")
    let newNote = FakeTarget("New note")
    h.center.pointerEntered(back)
    h.clock.advance(by: 0.5)
    // Straight from one target onto the next: no fade, the tooltip glides.
    h.center.pointerExited(back)
    h.clock.advance(by: 0.05)
    h.center.pointerEntered(forward)
    #expect(h.presenter.calls.last == .show("Forward", .glide, reduced: false, duration: 0.12))
    // Across a gap shorter than the warm window.
    h.center.pointerExited(forward)
    h.clock.advance(by: 0.29)
    h.center.pointerEntered(newNote)
    #expect(h.presenter.calls.last == .show("New note", .glide, reduced: false, duration: 0.12))
  }

  @Test func switchingWhileShownGlidesWithoutHiding() {
    let outer = FakeTarget("Tab")
    let inner = FakeTarget("Close tab")
    h.center.pointerEntered(outer)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    h.center.pointerEntered(inner)
    #expect(h.presenter.calls == [.show("Close tab", .glide, reduced: false, duration: 0.12)])
  }

  @Test func afterTheWarmWindowTheDelayIsBack() {
    let back = FakeTarget("Back")
    let forward = FakeTarget("Forward")
    h.center.pointerEntered(back)
    h.clock.advance(by: 0.5)
    h.center.pointerExited(back)
    h.clock.advance(by: 0.3)
    #expect(!h.center.isListening, "the warm window ended: monitors are off again")
    h.presenter.reset()
    h.center.pointerEntered(forward)
    #expect(h.presenter.calls.isEmpty)
    h.clock.advance(by: 0.5)
    #expect(h.presenter.calls == [.show("Forward", .enter, reduced: false, duration: 0.14)])
  }

  @Test(arguments: [
    TooltipDismissal.mouseDown, .keyDown, .scroll, .windowChanged, .appDeactivated,
  ])
  func hidesAtOnceAndStaysQuietUntilThePointerLeaves(reason: TooltipDismissal) {
    let target = FakeTarget("New note")
    let other = FakeTarget("Back")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    h.events.fire(reason)
    #expect(h.presenter.calls == [.hide(.none, duration: 0)], "no exit animation")
    #expect(h.center.shownTarget == nil)
    // Resting on it again doesn't bring it back…
    h.clock.advance(by: 2)
    #expect(h.presenter.calls.count == 1)
    // …and the next target is cold again: no warm glide right after a click.
    h.center.pointerExited(target)
    h.center.pointerEntered(other)
    #expect(h.presenter.calls.count == 1)
    h.clock.advance(by: 0.5)
    #expect(h.presenter.calls.last == .show("Back", .enter, reduced: false, duration: 0.14))
  }

  @Test func aKeyPressWhileWaitingCancelsIt() {
    let target = FakeTarget("Badge")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.2)
    h.events.fire(.keyDown)
    h.clock.advance(by: 1)
    #expect(h.presenter.calls.isEmpty)
    #expect(!h.center.isListening)
    // Leaving and coming back arms it again.
    h.center.pointerExited(target)
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    #expect(h.presenter.calls == [.show("Badge", .enter, reduced: false, duration: 0.14)])
  }

  @Test func aClickDuringTheFadeCutsItShort() {
    let target = FakeTarget("Back")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    h.center.pointerExited(target)
    h.presenter.reset()
    h.events.fire(.mouseDown)
    #expect(h.presenter.calls == [.hide(.none, duration: 0)])
  }

  @Test func neverWhileAMouseButtonIsHeld() {
    let target = FakeTarget("Tab")
    h.flags.mouseDown = true
    h.center.pointerEntered(target)
    h.clock.advance(by: 1)
    #expect(h.presenter.calls.isEmpty, "entered during a drag")
    h.flags.mouseDown = false
    h.center.pointerExited(target)
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.3)
    h.flags.mouseDown = true
    h.clock.advance(by: 0.2)
    #expect(h.presenter.calls.isEmpty, "the button went down while waiting")
  }

  @Test func reduceMotionOnlyFades() {
    h.flags.reduceMotion = true
    let back = FakeTarget("Back")
    let forward = FakeTarget("Forward")
    h.center.pointerEntered(back)
    h.clock.advance(by: 0.5)
    h.center.pointerEntered(forward)
    h.center.pointerExited(forward)
    #expect(
      h.presenter.calls == [
        .show("Back", .enter, reduced: true, duration: 0.08),
        .show("Forward", .glide, reduced: true, duration: 0.08),
        .hide(.exit, duration: 0.08),
      ])
  }

  @Test func aTargetWithNothingToSayShowsNothing() {
    let silent = FakeTarget("Untruncated")
    silent.content = nil
    let row = FakeTarget("Row")
    h.center.pointerEntered(row)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    // Nested inside the row: the row's tooltip stays.
    h.center.pointerEntered(silent)
    h.center.pointerExited(silent)
    #expect(h.presenter.calls.isEmpty)
    #expect(h.center.shownTarget === row)
    // On its own, within the warm window: still nothing.
    h.center.pointerExited(row)
    h.center.pointerEntered(silent)
    h.clock.advance(by: 1)
    #expect(h.presenter.calls == [.hide(.exit, duration: 0.09)])
  }

  @Test func aTargetThatGoesAwayTakesItsTooltipAtOnce() {
    let target = FakeTarget("Stop")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    h.center.targetRemoved(target)
    #expect(h.presenter.calls == [.hide(.none, duration: 0)])
    let pending = FakeTarget("Retry")
    h.center.pointerEntered(pending)
    h.center.targetRemoved(pending)
    h.clock.advance(by: 1)
    #expect(h.presenter.calls.count == 1, "a removed pending target never opens")
  }

  @Test func contentChangesUpdateTheShownTooltipInPlace() {
    let target = FakeTarget("3 to approve")
    h.center.pointerEntered(target)
    h.clock.advance(by: 0.5)
    h.presenter.reset()
    target.content = TooltipContent("4 to approve")
    h.center.targetChanged(target)
    #expect(h.presenter.calls == [.show("4 to approve", .none, reduced: false, duration: 0)])
    target.content = nil
    h.center.targetChanged(target)
    #expect(h.presenter.calls.last == .hide(.exit, duration: 0.09))
  }

  @Test func contentIsReadWhenItShows() {
    let target = FakeTarget("Loading…")
    h.center.pointerEntered(target)
    target.content = TooltipContent("Ideas", detail: "A weekly review template")
    h.clock.advance(by: 0.5)
    #expect(h.presenter.shown == TooltipContent("Ideas", detail: "A weekly review template"))
  }

  @Test func listensForHideTriggersOnlyWhileNeeded() {
    let target = FakeTarget("New note")
    #expect(!h.events.isListening)
    h.center.pointerEntered(target)
    #expect(h.events.isListening, "pending")
    h.clock.advance(by: 0.5)
    #expect(h.events.isListening, "shown")
    h.center.pointerExited(target)
    #expect(h.events.isListening, "warm")
    h.clock.advance(by: 0.3)
    #expect(!h.events.isListening, "idle: typing and clicking cost nothing")
    #expect(h.events.startCount == 1 && h.events.stopCount == 1)
  }
}
