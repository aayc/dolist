import DailyDoListDomain
import DailyDoListEditor
import Foundation

/// The editor changes that turn a note's text into a merged version: one replacement per block
/// of changed lines (`TextMerge.diffLines`), in UTF-16 ranges of the current text.
enum MergeEdits {
  static func changes(from current: String, to merged: String) -> [EditorTextChange] {
    let old = TextMerge.lines(current)
    let new = TextMerge.lines(merged)
    var starts: [Int] = []
    starts.reserveCapacity(old.count)
    var offset = 0
    for line in old {
      starts.append(offset)
      offset += line.utf16.count + 1
    }
    let length = current.utf16.count
    return TextMerge.diffLines(old, new).map { hunk in
      let isAtEnd = hunk.end == old.count
      if hunk.start == hunk.end {
        // Whole lines inserted before a line, or after the last one.
        return isAtEnd
          ? EditorTextChange(range: NSRange(location: length, length: 0), text: "\n" + hunk.lines.joined(separator: "\n"))
          : EditorTextChange(range: NSRange(location: starts[hunk.start], length: 0), text: hunk.lines.map { $0 + "\n" }.joined())
      }
      if !isAtEnd {
        let range = NSRange(location: starts[hunk.start], length: starts[hunk.end] - starts[hunk.start])
        return EditorTextChange(range: range, text: hunk.lines.map { $0 + "\n" }.joined())
      }
      // Lines up to the end of the text (no line break after the last one).
      if hunk.lines.isEmpty, hunk.start > 0 {
        let from = starts[hunk.start] - 1
        return EditorTextChange(range: NSRange(location: from, length: length - from), text: "")
      }
      let range = NSRange(location: starts[hunk.start], length: length - starts[hunk.start])
      return EditorTextChange(range: range, text: hunk.lines.joined(separator: "\n"))
    }
  }
}
