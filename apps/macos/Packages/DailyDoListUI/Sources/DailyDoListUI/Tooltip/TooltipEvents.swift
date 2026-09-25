import AppKit

/// Why a tooltip hides at once, without its exit animation.
public enum TooltipDismissal: Hashable, Sendable {
  case mouseDown, keyDown, scroll
  /// The target's window stopped being key, closed or was minimized.
  case windowChanged
  case appDeactivated
}

/// What hides a tooltip at once. The center only listens while a tooltip is pending or shown, so
/// typing and clicking cost nothing the rest of the time.
@MainActor
public protocol TooltipEventSource: AnyObject {
  func start(_ handler: @escaping @MainActor (TooltipDismissal) -> Void)
  func stop()
}

/// Local event monitors (mouse down, key down, scroll, gestures) and window/app notifications.
@MainActor
public final class LiveTooltipEvents: TooltipEventSource {
  private var monitor: Any?
  private var observers: [NSObjectProtocol] = []

  public init() {}

  public func start(_ handler: @escaping @MainActor (TooltipDismissal) -> Void) {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(
      matching: [
        .leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel, .swipe,
        .magnify,
      ]
    ) { event in
      MainActor.assumeIsolated {
        switch event.type {
        case .keyDown: handler(.keyDown)
        case .scrollWheel, .swipe, .magnify: handler(.scroll)
        default: handler(.mouseDown)
        }
      }
      return event
    }
    let center = NotificationCenter.default
    let windowChanges: [Notification.Name] = [
      NSWindow.didResignKeyNotification, NSWindow.willCloseNotification,
      NSWindow.willMiniaturizeNotification,
    ]
    observers =
      windowChanges.map { name in
        center.addObserver(forName: name, object: nil, queue: .main) { _ in
          MainActor.assumeIsolated { handler(.windowChanged) }
        }
      } + [
        center.addObserver(
          forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { _ in
          MainActor.assumeIsolated { handler(.appDeactivated) }
        }
      ]
  }

  public func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
  }
}
