import Foundation

/// Task commands: Obsidian's "Toggle checkbox status" (⌘L / ⌘↩) and single-task toggling (checkbox
/// clicks).
enum TaskCommands {
  /// `[ ]` ↔ `[x]`; any other status becomes done.
  static func nextStatus(_ status: UInt16) -> UInt16 {
    status == UTF16Unit.lowerX || status == UTF16Unit.upperX ? UTF16Unit.space : UTF16Unit.lowerX
  }

  /// Offsets, after `edit`, of the status characters of the tasks a toggle `edit` checks (`x`
  /// replacing one status character).
  static func checkedStatusOffsets(in edit: TextEdit) -> [Int] {
    edit.replacements
      .filter { $0.range.length == 1 && $0.text == "x" }
      .map { edit.map($0.range.location, forward: false) }
  }

  /// Toggles the task on the line containing `offset`, or nil if that line isn't a task.
  static func toggleTask(in text: NSString, lineContaining offset: Int) -> TextEdit.Replacement? {
    let lines = TextLines(text)
    let line = lines.line(containing: offset)
    let prefix = LinePrefix.parse(lines.units(line))
    guard let box = prefix.box, let status = prefix.status else { return nil }
    let range = NSRange(location: line.location + box.location + 1, length: 1)
    return TextEdit.Replacement(range: range, text: String(utf16Units: [nextStatus(status)][...]))
  }

  /// On every selected line: plain text → `- [ ] text`, list item → task, task → toggled. Blank lines
  /// only become tasks when a single line is selected. Carets move past an inserted `- [ ] `;
  /// selections grow to include it.
  static func toggleChecklist(in text: NSString, selection: [NSRange]) -> TextEdit? {
    let lines = TextLines(text)
    let selected = lines.selectedLines(selection)
    let allowBlank = selected.count == 1
    var replacements: [TextEdit.Replacement] = []
    for line in selected {
      let s = lines.units(line)
      let prefix = LinePrefix.parse(s)
      if let box = prefix.box, let status = prefix.status {
        let range = NSRange(location: line.location + box.location + 1, length: 1)
        replacements.append(TextEdit.Replacement(range: range, text: String(utf16Units: [nextStatus(status)][...])))
      } else if let marker = prefix.marker {
        if prefix.markerSpace.length > 0 {
          replacements.append(TextEdit.Replacement(range: NSRange(location: line.location + prefix.markerSpace.end, length: 0), text: "[ ] "))
        } else {
          replacements.append(TextEdit.Replacement(range: NSRange(location: line.location + marker.end, length: 0), text: " [ ] "))
        }
      } else {
        if !allowBlank, prefix.indentEnd == s.count { continue }
        replacements.append(TextEdit.Replacement(range: NSRange(location: line.location + prefix.indentEnd, length: 0), text: "- [ ] "))
      }
    }
    guard !replacements.isEmpty else { return nil }
    var edit = TextEdit(replacements: replacements, selection: [])
    edit.selection = selection.map { range in
      guard range.length > 0 else {
        let caret = edit.map(range.location, forward: true)
        return NSRange(location: caret, length: 0)
      }
      let start = edit.map(range.location, forward: false)
      return NSRange(start, edit.map(range.end, forward: true))
    }
    return edit
  }
}
