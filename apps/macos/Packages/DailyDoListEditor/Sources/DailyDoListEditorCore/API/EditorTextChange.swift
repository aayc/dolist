import Foundation

/// Replaces `range` (UTF-16 code units of the current text) with `text`.
public struct EditorTextChange: Hashable, Sendable {
  public var range: NSRange
  public var text: String

  public init(range: NSRange, text: String) {
    self.range = range
    self.text = text
  }
}
