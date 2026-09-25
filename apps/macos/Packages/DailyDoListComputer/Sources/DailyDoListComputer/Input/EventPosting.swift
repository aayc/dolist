import Foundation

public enum MouseButton: String, Sendable, CaseIterable {
  case left, right, middle
}

/// A synthesized input event.
public enum InputEvent: Equatable, Sendable {
  case key(code: UInt16, down: Bool, flags: UInt64)
  /// A key event carrying text (keycode 0, no modifiers).
  case text(String, down: Bool)
  case mouse(button: MouseButton, down: Bool, at: Point, clickCount: Int, windowID: UInt32?)
  /// Wheel deltas in lines (positive = up / left).
  case scroll(dx: Int32, dy: Int32, at: Point, windowID: UInt32?)
}

/// CoreGraphics event posting.
public protocol EventPosting: Sendable {
  /// Posts to one process's event queue (`CGEventPostToPid`): the app isn't activated and the
  /// real cursor doesn't move.
  func post(_ event: InputEvent, to pid: Int32) throws
}

/// An on-screen window from the window server's list.
public struct WindowInfo: Equatable, Sendable {
  public var id: UInt32
  public var pid: Int32
  public var frame: Rect
  /// 0 for normal windows; menus, popovers and panels sit on higher layers.
  public var layer: Int
  public var alpha: Double

  public init(id: UInt32, pid: Int32, frame: Rect, layer: Int = 0, alpha: Double = 1) {
    self.id = id
    self.pid = pid
    self.frame = frame
    self.layer = layer
    self.alpha = alpha
  }
}

/// The window server's window list (`CGWindowListCopyWindowInfo`).
public protocol WindowListing: Sendable {
  /// On-screen windows, front to back. Titles aren't read (they'd need Screen Recording).
  func onScreenWindows() -> [WindowInfo]
}
