import AppKit
import DailyDoListDrawing

/// A drawing embed alone on its line, as the document has it now.
struct EmbedLine: Equatable {
  /// 0-based.
  var line: Int
  /// The line's content (without its `\n`); its start is the embed's anchor.
  var content: NSRange
  var spec: DrawingEmbed

  var lineStart: Int { content.location }
}

/// A floated drawing (`left-wrap`, `right-wrap`) and the part of the column the text stays out of
/// (text-container coordinates).
struct EmbedFloat: Equatable {
  var line: Int
  var box: CGRect
  var exclusion: CGRect
}

/// The editor's drawing embeds: what the host said about each drawing, parsed embeds, drawing
/// sizes, the floats the text wraps around, and the rendered previews. Selection, dragging and
/// editing in place keep their state here too.
@MainActor
final class EmbedState {
  /// The host's answer for each target, asked once until `drawingsDidChange` (nil: the host
  /// doesn't show drawings).
  var drawings: [String: EditorDrawingState?] = [:]
  /// Floats laid out so far, top to bottom, and how far down the document they were computed.
  var floats: [EmbedFloat] = []
  var floatLimit = -1
  /// Set when an edit, a reveal or a drawing may have moved or resized a float.
  var floatsDirty = true
  /// How many times the exclusion paths changed (tests: typing next to a float never does it).
  var exclusionUpdates = 0
  let previews = DrawingPreviewCache()

  /// The selected embed (its line's start), which doesn't move the caret.
  var selectedLineStart: Int?
  /// The line of the drawn embed under the pointer.
  var hoveredLine: Int?
  var interaction: EmbedInteraction?
  var session: DrawingEditSession?

  private var specs: [String: DrawingEmbed] = [:]
  private var naturalSizes: [UInt64: CGSize?] = [:]

  /// The embed an embed line says (cached by the line's text).
  func spec(forLine text: String) -> DrawingEmbed? {
    if let cached = specs[text] { return cached }
    guard let spec = DrawingEmbed.parse(line: text) else { return nil }
    if specs.count > 512 { specs.removeAll() }
    specs[text] = spec
    return spec
  }

  /// A drawing's size at 100% (nil when it has nothing to show), measured once per version.
  func naturalSize(of drawing: EditorDrawing) -> CGSize? {
    if let cached = naturalSizes[drawing.contentHash] { return cached }
    let size: CGSize? =
      drawing.scene.elements.contains { !$0.isDeleted }
      ? DrawingImage.preferredSize(of: drawing.scene) : nil
    if naturalSizes.count > 256 { naturalSizes.removeAll() }
    naturalSizes[drawing.contentHash] = size
    return size
  }

  /// Forgets everything about the previous document.
  func reset() {
    drawings.removeAll()
    floats.removeAll()
    floatLimit = -1
    floatsDirty = true
    selectedLineStart = nil
    hoveredLine = nil
    interaction = nil
  }

  /// Maps an embed's line start through an edit (nil when the edit removed it).
  static func remap(
    _ start: Int, location: Int, oldLength: Int, newLength: Int, text: NSString
  ) -> Int? {
    let oldEnd = location + oldLength
    if start < location { return start }
    if start == location, oldLength == 0 {
      let insertedLines =
        newLength > 0 && text.character(at: location + newLength - 1) == UTF16Unit.newline
      return insertedLines ? start + newLength : start
    }
    if start >= oldEnd { return start + newLength - oldLength }
    return nil
  }
}
