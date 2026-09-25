import CoreGraphics
import Foundation

/// `CGEventPostToPid`: events go straight to one app's event queue, so the app stays in the
/// background and the real cursor doesn't move. Some apps ignore input that doesn't come from the
/// HID system, or hit-test with the real cursor position; those need `activate` or `press`.
public struct LiveEventPoster: EventPosting {
  public init() {}

  public func post(_ event: InputEvent, to pid: Int32) throws {
    // A private source, so the user's physically held modifiers don't leak into the events.
    let source = CGEventSource(stateID: .privateState)
    guard let cgEvent = Self.makeEvent(event, source: source) else {
      throw ComputerError.failed("Couldn't create an input event.")
    }
    cgEvent.postToPid(pid)
  }

  private static func makeEvent(_ event: InputEvent, source: CGEventSource?) -> CGEvent? {
    switch event {
    case .key(let code, let down, let flags):
      let cgEvent = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      cgEvent?.flags = CGEventFlags(rawValue: flags)
      return cgEvent
    case .text(let text, let down):
      guard let cgEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        return nil
      }
      cgEvent.flags = []
      Array(text.utf16).withUnsafeBufferPointer { units in
        cgEvent.keyboardSetUnicodeString(
          stringLength: units.count, unicodeString: units.baseAddress)
      }
      return cgEvent
    case .mouse(let button, let down, let point, let clickCount, let windowID):
      let (type, cgButton): (CGEventType, CGMouseButton) =
        switch (button, down) {
        case (.left, true): (.leftMouseDown, .left)
        case (.left, false): (.leftMouseUp, .left)
        case (.right, true): (.rightMouseDown, .right)
        case (.right, false): (.rightMouseUp, .right)
        case (.middle, true): (.otherMouseDown, .center)
        case (.middle, false): (.otherMouseUp, .center)
        }
      let cgEvent = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: point.cgPoint,
        mouseButton: cgButton)
      cgEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
      if let cgEvent, let windowID { target(cgEvent, window: windowID) }
      return cgEvent
    case .scroll(let dx, let dy, let point, let windowID):
      let cgEvent = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx,
        wheel3: 0)
      cgEvent?.location = point.cgPoint
      if let cgEvent, let windowID { target(cgEvent, window: windowID) }
      return cgEvent
    }
  }

  /// Names the window under the point, which apps use to route mouse events that don't come with
  /// the real cursor.
  private static func target(_ event: CGEvent, window: UInt32) {
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
  }
}
