import Foundation

public struct EditorConfiguration: Hashable, Sendable {
  public var fontSize: Double
  /// Hide markdown syntax away from the cursor (Obsidian live preview); false = dim it.
  public var livePreview: Bool
  /// Center the text in a readable column.
  public var readableLineLength: Bool
  public var spellcheck: Bool
  public var showLineNumbers: Bool
  public var isEditable: Bool

  public init(
    fontSize: Double = 16, livePreview: Bool = true, readableLineLength: Bool = true,
    spellcheck: Bool = false, showLineNumbers: Bool = false, isEditable: Bool = true
  ) {
    self.fontSize = fontSize
    self.livePreview = livePreview
    self.readableLineLength = readableLineLength
    self.spellcheck = spellcheck
    self.showLineNumbers = showLineNumbers
    self.isEditable = isEditable
  }
}
