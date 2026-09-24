import CoreGraphics
import Foundation

/// Saved per-note editor state for instant tab switches (text, selection, scroll, undo).
public struct EditorSnapshot {
  public var text: String
  public var selectedRange: NSRange
  public var scrollOffset: CGPoint
  /// The note's own undo history; `restore(_:)` swaps it in (nil starts a fresh history).
  public var undoManager: UndoManager?

  public init(
    text: String, selectedRange: NSRange = NSRange(location: 0, length: 0), scrollOffset: CGPoint = .zero,
    undoManager: UndoManager? = nil
  ) {
    self.text = text
    self.selectedRange = selectedRange
    self.scrollOffset = scrollOffset
    self.undoManager = undoManager
  }
}
