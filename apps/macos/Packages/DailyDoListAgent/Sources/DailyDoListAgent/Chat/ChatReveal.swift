import AppKit
import DailyDoListModels
import Observation
import SwiftUI

/// What the reveal depends on: the Reduce Motion setting and a frame ticker. Tests use fakes.
@MainActor
struct RevealEnvironment {
  /// System Settings → Accessibility → Display → Reduce motion.
  var reduceMotion: () -> Bool
  /// A ticker for frames of `view` (the chat), calling back with each frame's timestamp.
  var makeTicker:
    (_ view: NSView?, _ onFrame: @escaping @MainActor (TimeInterval) -> Void) ->
      FrameTicker

  static var live: RevealEnvironment {
    RevealEnvironment(
      reduceMotion: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion },
      makeTicker: { view, onFrame in DisplayLinkTicker(view: view, onFrame: onFrame) })
  }
}

/// Types out the agent's text in one open chat.
///
/// Messages that were there when the chat opened (history) render at once. Agent text that arrives
/// while it's open, a new message or more of one that streams, is revealed a little every frame
/// (`RevealPacing`). Frames only run while some text is behind, and never with Reduce Motion (the
/// text then appears as it arrives). The user's own messages never animate.
@MainActor
@Observable
final class ChatReveal {
  /// How a text message shows right now.
  enum Presentation: Equatable {
    /// All of its text as it arrives (history, the user's words, Reduce Motion).
    case whole
    /// New agent text whose reveal starts with the next update: nothing shows yet.
    case pending
    case revealing(RevealedText)

    static func == (a: Presentation, b: Presentation) -> Bool {
      switch (a, b) {
      case (.whole, .whole), (.pending, .pending): true
      case (.revealing(let x), .revealing(let y)): x === y
      default: false
      }
    }
  }

  /// Reveals by message id (only agent text that arrived live, or streamed on after opening).
  private(set) var entries: [String: RevealedText] = [:]
  /// Some agent text is typing out or still streaming.
  private(set) var isRevealing = false

  /// The chat's view, whose display link drives the frames.
  @ObservationIgnored weak var hostView: NSView? {
    didSet {
      guard hostView !== oldValue else { return }
      stopTicker()
      ticker = nil
      startIfBehind()
    }
  }

  @ObservationIgnored private let environment: RevealEnvironment
  /// Message ids present when the chat opened (nil until then).
  @ObservationIgnored private var history: Set<String>?
  /// Entries typing or streaming.
  @ObservationIgnored private var active: Set<String> = []
  /// New messages whose arrival was already announced (an approval card's attention animation).
  @ObservationIgnored private var announced: Set<String> = []
  @ObservationIgnored private var ticker: FrameTicker?
  @ObservationIgnored private var lastFrame: TimeInterval?

  /// The first frame after a pause counts as one 60 Hz frame.
  static let firstFrameDuration: TimeInterval = 1.0 / 60

  init(environment: RevealEnvironment = .live) {
    self.environment = environment
  }

  var isTicking: Bool { ticker?.isRunning ?? false }

  /// Whether a message arrived after the chat opened.
  func isNew(_ id: String) -> Bool {
    guard let history else { return false }
    return !history.contains(id)
  }

  /// How a text message shows (reads `entries`, so a view calling it updates when a reveal starts).
  func presentation(of message: TextMessage) -> Presentation {
    guard message.role == .agent else { return .whole }
    if let entry = entries[message.id] { return .revealing(entry) }
    guard isNew(message.id), !environment.reduceMotion() else { return .whole }
    return .pending
  }

  /// The chat opened showing `messages`: they are history. Text that is still streaming types on
  /// from what's already there.
  func open(with messages: [ThreadMessage]) {
    guard history == nil else { return }
    history = Set(messages.map(\.id))
    for case .text(let text) in messages where text.role == .agent && text.streaming == true {
      entries[text.id] = RevealedText(text: text.text, streaming: true, revealed: true)
      active.insert(text.id)
    }
    refreshRevealing()
  }

  /// The thread's messages changed.
  func sync(_ messages: [ThreadMessage]) {
    guard history != nil else {
      open(with: messages)
      return
    }
    let reduceMotion = environment.reduceMotion()
    for case .text(let text) in messages where text.role == .agent {
      let streaming = text.streaming == true
      if let entry = entries[text.id] {
        entry.update(text: text.text, streaming: streaming)
        if reduceMotion { entry.finish() }
        if entry.isActive { active.insert(text.id) }
      } else if isNew(text.id), !reduceMotion {
        let entry = RevealedText(text: text.text, streaming: streaming, revealed: false)
        entries[text.id] = entry
        if entry.isActive { active.insert(text.id) }
      }
    }
    active = active.filter { entries[$0]?.isActive == true }
    refreshRevealing()
    startIfBehind()
  }

  /// A new message that hasn't announced itself yet (each announces once).
  func needsAnnouncement(_ id: String) -> Bool {
    isNew(id) && !announced.contains(id)
  }

  func markAnnounced(_ id: String) {
    announced.insert(id)
  }

  /// The chat closed: no more frames.
  func close() {
    stopTicker()
    ticker = nil
  }

  // MARK: Frames

  private func startIfBehind() {
    let behind = active.contains { entries[$0]?.isCaughtUp == false }
    guard behind else {
      stopTicker()
      return
    }
    if ticker == nil {
      ticker = environment.makeTicker(hostView) { [weak self] timestamp in
        self?.frame(at: timestamp)
      }
    }
    if ticker?.isRunning == false { ticker?.start() }
  }

  private func frame(at timestamp: TimeInterval) {
    let elapsed = lastFrame.map { timestamp - $0 } ?? Self.firstFrameDuration
    lastFrame = timestamp
    let reduceMotion = environment.reduceMotion()
    var behind = false
    for id in active {
      guard let entry = entries[id] else { continue }
      if reduceMotion {
        entry.finish()
      } else if entry.advance(by: elapsed) {
        behind = true
      }
    }
    active = active.filter { entries[$0]?.isActive == true }
    refreshRevealing()
    if !behind { stopTicker() }
  }

  private func stopTicker() {
    ticker?.stop()
    lastFrame = nil
  }

  private func refreshRevealing() {
    let revealing = !active.isEmpty
    if revealing != isRevealing { isRevealing = revealing }
  }
}

/// An empty view in the chat that lends it a display link (frames follow its window's screen and
/// stop with its window).
struct RevealHost: NSViewRepresentable {
  let reveal: ChatReveal

  func makeNSView(context: Context) -> HostView {
    let view = HostView()
    view.reveal = reveal
    return view
  }

  func updateNSView(_ view: HostView, context: Context) {
    if view.reveal !== reveal {
      view.reveal = reveal
      view.attach()
    }
  }

  final class HostView: NSView {
    weak var reveal: ChatReveal?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      attach()
    }

    func attach() {
      reveal?.hostView = window == nil ? nil : self
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
  }
}
