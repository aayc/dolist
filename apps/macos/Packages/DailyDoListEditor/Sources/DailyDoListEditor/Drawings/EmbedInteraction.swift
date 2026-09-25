import AppKit
import DailyDoListDrawing

/// A press on a drawn embed, until the mouse goes up: a click, a move or a resize.
struct EmbedInteraction {
  enum Mode: Equatable {
    /// Down, not yet dragged far enough to move.
    case press
    case move
    /// Dragging the bottom-left corner (the width grows to the left) or the bottom-right one.
    case resizeStart
    case resizeEnd

    var isResize: Bool { self == .resizeStart || self == .resizeEnd }
  }

  /// Movement before a press becomes a drag.
  static let dragThreshold: CGFloat = 4

  var mode: Mode
  var lineStart: Int
  /// Text-view coordinates.
  var start: CGPoint
  var current: CGPoint
  /// The box when the press started.
  var startBox: CGRect
  /// The most the embed can be (the column's width).
  var maxWidth: CGFloat
  /// The width being dragged to while resizing.
  var width: CGFloat
  var target: EmbedDropTarget?
}

/// The handles of a selected embed: a grip to move it and the corners that resize it (only the
/// one that moves: a right float grows to the left, a left one to the right).
enum EmbedHandle: Hashable {
  case grip
  case resizeStart
  case resizeEnd

  static let gripSize: CGFloat = 22
  static let gripInset: CGFloat = 6
  static let dotSize: CGFloat = 12

  static func handles(for placement: DrawingEmbed.Placement) -> [EmbedHandle] {
    switch placement {
    case .rightWrap, .right: [.grip, .resizeStart]
    case .leftWrap, .left, .full: [.grip, .resizeEnd]
    case .center: [.grip, .resizeStart, .resizeEnd]
    }
  }

  /// Where the handle is drawn around a box.
  func rect(in box: CGRect) -> CGRect {
    switch self {
    case .grip:
      CGRect(
        x: box.minX + Self.gripInset, y: box.minY + Self.gripInset, width: Self.gripSize,
        height: Self.gripSize)
    case .resizeStart:
      CGRect(
        x: box.minX - Self.dotSize / 2, y: box.maxY - Self.dotSize / 2, width: Self.dotSize,
        height: Self.dotSize)
    case .resizeEnd:
      CGRect(
        x: box.maxX - Self.dotSize / 2, y: box.maxY - Self.dotSize / 2, width: Self.dotSize,
        height: Self.dotSize)
    }
  }

  /// Where the handle takes the pointer (a bigger target than the dot).
  func hitRect(in box: CGRect) -> CGRect {
    self == .grip ? rect(in: box) : rect(in: box).insetBy(dx: -6, dy: -6)
  }

  var tooltip: String { self == .grip ? "Drag to move" : "Drag to resize" }
}
