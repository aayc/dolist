import AppKit

@testable import DailyDoListUI

/// A target with a fixed frame and content.
@MainActor
final class FakeTarget: TooltipTarget {
  var name: String
  var content: TooltipContent?
  var tooltipScreenRect: NSRect?
  var tooltipWindow: NSWindow?
  var tooltipPlacement: TooltipPlacement = .automatic
  private(set) var contentRequests = 0

  init(
    _ name: String, content: TooltipContent? = nil,
    rect: NSRect = NSRect(x: 100, y: 500, width: 28, height: 28)
  ) {
    self.name = name
    self.content = content ?? TooltipContent(name)
    self.tooltipScreenRect = rect
  }

  func tooltipContent() -> TooltipContent? {
    contentRequests += 1
    return content
  }
}

/// Records what the center asks for.
@MainActor
final class RecordingPresenter: TooltipPresenting {
  enum Call: Equatable {
    case show(String, TooltipAnimation.Kind, reduced: Bool, duration: TimeInterval)
    case hide(TooltipAnimation.Kind, duration: TimeInterval)
  }

  private(set) var calls: [Call] = []
  private(set) var shown: TooltipContent?

  func show(_ presentation: TooltipPresentation, animation: TooltipAnimation) {
    shown = presentation.content
    calls.append(
      .show(
        presentation.content.plainText, animation.kind, reduced: animation.reduced,
        duration: animation.duration))
  }

  func hide(animation: TooltipAnimation) {
    shown = nil
    calls.append(.hide(animation.kind, duration: animation.duration))
  }

  func reset() { calls = [] }
}

/// Hide triggers fired by hand.
@MainActor
final class FakeEvents: TooltipEventSource {
  private var handler: (@MainActor (TooltipDismissal) -> Void)?
  private(set) var startCount = 0
  private(set) var stopCount = 0
  var isListening: Bool { handler != nil }

  func start(_ handler: @escaping @MainActor (TooltipDismissal) -> Void) {
    startCount += 1
    self.handler = handler
  }

  func stop() {
    stopCount += 1
    handler = nil
  }

  func fire(_ reason: TooltipDismissal) { handler?(reason) }
}

/// A center wired to fakes.
@MainActor
struct CenterHarness {
  let clock = ManualScheduler()
  let events = FakeEvents()
  let presenter = RecordingPresenter()
  let flags = Flags()
  let center: TooltipCenter

  @MainActor
  final class Flags {
    var reduceMotion = false
    var mouseDown = false
  }

  init() {
    let presenter = presenter
    let flags = flags
    center = TooltipCenter(
      clock: clock, events: events, presenter: { presenter },
      reduceMotion: { flags.reduceMotion }, mouseButtonsDown: { flags.mouseDown })
  }
}
