import AppKit
import SwiftUI

@MainActor
enum WindowChrome {
  /// The hidden title bar is shorter than the panes' header row, which leaves the traffic lights
  /// above the header's center line. An empty compact toolbar makes the (still transparent) title
  /// bar as tall as the header, and AppKit centers the traffic lights in it.
  static func centerTrafficLights(in window: NSWindow) {
    guard window.toolbar == nil else { return }
    window.toolbar = NSToolbar(identifier: "app.dailydolist.main")
    window.toolbarStyle = .unifiedCompact
    window.titlebarSeparatorStyle = .none
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
  }
}

/// Header background of the title-bar-less window: dragging moves the window and a double-click
/// does what System Settings → Desktop & Dock says a title bar double-click does.
struct WindowDragArea: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { DragView() }
  func updateNSView(_ nsView: NSView, context: Context) {}

  final class DragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
      guard let window else { return }
      if event.clickCount == 2 {
        WindowDragArea.performDoubleClickAction(on: window)
      } else {
        window.performDrag(with: event)
      }
    }
  }

  @MainActor
  static func performDoubleClickAction(on window: NSWindow) {
    switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
    case "Minimize": window.performMiniaturize(nil)
    case "None": break
    default: window.performZoom(nil)
    }
  }
}

/// A vertical strip that resizes a pane: resize cursor on hover, horizontal drag deltas (points,
/// positive = rightward) from the mouse-down location, and a double-click to restore the default.
struct PaneResizeHandle: NSViewRepresentable {
  let onBegin: @MainActor () -> Void
  let onDrag: @MainActor (CGFloat) -> Void
  let onEnd: @MainActor () -> Void
  let onReset: @MainActor () -> Void

  func makeNSView(context: Context) -> HandleView {
    let view = HandleView()
    update(view)
    return view
  }

  func updateNSView(_ nsView: HandleView, context: Context) { update(nsView) }

  private func update(_ view: HandleView) {
    view.onBegin = onBegin
    view.onDrag = onDrag
    view.onEnd = onEnd
    view.onReset = onReset
  }

  final class HandleView: NSView {
    var onBegin: (@MainActor () -> Void)?
    var onDrag: (@MainActor (CGFloat) -> Void)?
    var onEnd: (@MainActor () -> Void)?
    var onReset: (@MainActor () -> Void)?
    private var startX: CGFloat?

    override var mouseDownCanMoveWindow: Bool { false }

    override func resetCursorRects() {
      addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 {
        startX = nil
        onReset?()
        return
      }
      startX = event.locationInWindow.x
      onBegin?()
    }

    override func mouseDragged(with event: NSEvent) {
      guard let startX else { return }
      onDrag?(event.locationInWindow.x - startX)
    }

    override func mouseUp(with event: NSEvent) {
      guard startX != nil else { return }
      startX = nil
      onEnd?()
    }
  }
}

/// Follows the main window in and out of full screen, where its traffic lights are hidden and
/// headers don't need to leave room for them.
@MainActor
final class FullScreenObserver {
  private var tokens: [NSObjectProtocol] = []
  private weak var window: NSWindow?

  func observe(_ window: NSWindow, update: @escaping @MainActor @Sendable (Bool) -> Void) {
    guard window !== self.window else { return }
    stop()
    self.window = window
    update(window.styleMask.contains(.fullScreen))
    let center = NotificationCenter.default
    let changes: [(Notification.Name, Bool)] = [
      (NSWindow.willEnterFullScreenNotification, true),
      (NSWindow.willExitFullScreenNotification, false),
    ]
    tokens = changes.map { name, isFullScreen in
      center.addObserver(forName: name, object: window, queue: .main) { _ in
        MainActor.assumeIsolated { update(isFullScreen) }
      }
    }
  }

  func stop() {
    tokens.forEach(NotificationCenter.default.removeObserver)
    tokens = []
  }
}
