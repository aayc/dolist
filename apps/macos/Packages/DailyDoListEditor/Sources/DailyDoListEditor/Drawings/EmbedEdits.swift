import DailyDoListDrawing
import Foundation

/// Where an embed dragged somewhere lands: before which line, and how it's placed.
struct EmbedDropTarget: Equatable {
  /// 0-based index of the line the embed goes before; the line count puts it after the last one.
  var before: Int
  var placement: DrawingEmbed.Placement
  /// Where to draw the indicator: the boundary between the two lines.
  var y: CGFloat
}

/// The text edits behind inserting, moving, resizing and removing embeds, as the web editor makes
/// them (`embeds/edits.ts`, `embeds/drop.ts`). Pure: text in, `TextEdit` out. They are the user's
/// own edits (undoable like typing).
enum EmbedEdits {
  /// An edit and where the embed's line starts afterwards.
  struct Result: Equatable {
    var edit: TextEdit
    var lineStart: Int
  }

  /// A line as drawn, in any vertical coordinates shared with the pointer.
  struct LineBox: Equatable {
    /// 0-based.
    var index: Int
    var top: CGFloat
    var bottom: CGFloat
  }

  /// Where an embed dragged to `point` lands: between the two lines nearest the pointer, floating
  /// left in the column's left third, right in its right third, full width in between.
  static func dropTarget(
    at point: CGPoint, lineAt: (CGFloat) -> LineBox, lineCount: Int, left: CGFloat, right: CGFloat
  ) -> EmbedDropTarget {
    let line = lineAt(point.y)
    let upper = point.y < (line.top + line.bottom) / 2
    let before = min(max(upper ? line.index : line.index + 1, 0), lineCount)
    let third = (right - left) / 3
    let placement: DrawingEmbed.Placement =
      point.x < left + third ? .leftWrap : point.x > right - third ? .rightWrap : .full
    return EmbedDropTarget(before: before, placement: placement, y: upper ? line.top : line.bottom)
  }

  /// The modifiers a placement implies: full width drops the size (the embed spans the column).
  static func placed(_ spec: DrawingEmbed, _ placement: DrawingEmbed.Placement) -> DrawingEmbed {
    var next = spec
    next.placement = placement
    guard placement == .full else { return next }
    next.width = nil
    next.height = nil
    next.widthPercent = nil
    next.heightPercent = nil
    if spec.placement != .full { next.style = nil }
    return next
  }

  /// The range that removes the embed's line with one line break.
  static func lineRemoval(_ content: NSRange, in text: NSString) -> NSRange {
    if content.end < text.length { return NSRange(content.location, content.end + 1) }
    if content.location > 0 { return NSRange(content.location - 1, content.end) }
    return NSRange(location: 0, length: text.length)
  }

  /// The `![[…]]` of an embed line (without the spaces around it).
  static func markdownRange(of embed: EmbedLine, in text: NSString) -> NSRange {
    var start = embed.content.location
    var end = embed.content.end
    while start < end, CharClass.isSpaceOrTab(text.character(at: start)) { start += 1 }
    while end > start, CharClass.isSpaceOrTab(text.character(at: end - 1)) { end -= 1 }
    return NSRange(start, end)
  }

  /// Moves the embed's line before line `before`, with `placement`. Dropping it next to its own
  /// line only changes the placement. Nil when nothing changes.
  static func move(
    _ embed: EmbedLine, before target: Int, placement: DrawingEmbed.Placement, in text: NSString,
    lineIndex: LineIndex, selection: [NSRange]
  ) -> Result? {
    let lineCount = lineIndex.count
    let before = min(max(target, 0), lineCount)
    let markdown = markdownRange(of: embed, in: text)
    let replacement = placed(embed.spec, placement).markdown
    if before == embed.line || before == embed.line + 1 {
      guard replacement != text.substring(with: markdown) else { return nil }
      let edit = TextEdit(replacements: [.init(range: markdown, text: replacement)], selection: [])
      return Result(edit: mapped(edit, selection), lineStart: embed.lineStart)
    }
    let removal = lineRemoval(embed.content, in: text)
    let atEnd = before == lineCount
    let insertAt = atEnd ? text.length : lineIndex.start(ofLine: before)
    let insertion = TextEdit.Replacement(
      range: NSRange(location: insertAt, length: 0),
      text: atEnd ? "\n\(replacement)" : "\(replacement)\n")
    let removing = TextEdit.Replacement(range: removal, text: "")
    let replacements = insertAt < removal.location ? [insertion, removing] : [removing, insertion]
    let lineStart =
      insertAt < removal.location ? insertAt : insertAt - removal.length + (atEnd ? 1 : 0)
    let edit = TextEdit(replacements: replacements, selection: [])
    return Result(edit: mapped(edit, selection), lineStart: lineStart)
  }

  /// Sets the embed's width (points), scaling a given height with it. Nil when nothing changes.
  static func resize(_ embed: EmbedLine, width: CGFloat, in text: NSString, selection: [NSRange])
    -> Result?
  {
    let next = max(EmbedGeometry.minWidth, width.rounded())
    var spec = embed.spec
    if let height = spec.height, let old = spec.width, old > 0 {
      spec.height = (height * Double(next) / old).rounded()
    }
    spec.width = Double(next)
    spec.widthPercent = nil
    let markdown = markdownRange(of: embed, in: text)
    guard spec.markdown != text.substring(with: markdown) else { return nil }
    let edit = TextEdit(replacements: [.init(range: markdown, text: spec.markdown)], selection: [])
    return Result(edit: mapped(edit, selection), lineStart: embed.lineStart)
  }

  /// Removes the embed's line. The drawing file stays, so undo brings the embed back.
  static func remove(_ embed: EmbedLine, in text: NSString, selection: [NSRange]) -> TextEdit {
    let edit = TextEdit(
      replacements: [.init(range: lineRemoval(embed.content, in: text), text: "")], selection: [])
    return mapped(edit, selection)
  }

  /// Inserts `markdown` (an `![[…]]`) on a line of its own at the caret's line: on that line when
  /// it's blank (with a new line after it for the caret), else above it. The caret stays off the
  /// embed's line, so the drawing shows rather than its syntax.
  static func insert(_ markdown: String, in text: NSString, caret: Int, selection: [NSRange])
    -> Result
  {
    let line = TextLines(text).line(containing: caret)
    let blank = text.substring(with: line).allSatisfy { $0 == " " || $0 == "\t" }
    if blank {
      let inserted = "\(markdown)\n"
      let caretAfter = line.location + (inserted as NSString).length
      return Result(
        edit: TextEdit(
          replacements: [.init(range: line, text: inserted)],
          selection: [NSRange(location: caretAfter, length: 0)]),
        lineStart: line.location)
    }
    let edit = TextEdit(
      replacements: [
        .init(range: NSRange(location: line.location, length: 0), text: "\(markdown)\n")
      ], selection: [])
    let moved = selection.map {
      NSRange(edit.map($0.location, forward: true), edit.map($0.end, forward: true))
    }
    return Result(
      edit: TextEdit(replacements: edit.replacements, selection: moved), lineStart: line.location)
  }

  /// The edit with the selection carried through it.
  private static func mapped(_ edit: TextEdit, _ selection: [NSRange]) -> TextEdit {
    var result = edit
    result.selection = selection.map {
      let start = edit.map($0.location, forward: false)
      return NSRange(start, max(start, edit.map($0.end, forward: false)))
    }
    return result
  }
}
