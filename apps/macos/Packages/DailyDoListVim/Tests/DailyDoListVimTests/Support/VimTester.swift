import Testing

@testable import DailyDoListVim

/// An editor with vim attached, driven the way the vectors are replayed (README "How a replay
/// applies a token"): keys in vim notation, native edits for keys vim leaves to the editor in
/// insert mode, and a layout pass after every key.
@MainActor
final class VimTester {
  let vim: Vim
  let buffer: VimTextBuffer
  let session: VimSession
  let scheduler = ManualVimScheduler()

  init(_ doc: VimText, cursor: (Int, Int) = (0, 0), tabSize: Int = 4, indentUnit: String = "\t") {
    vim = Vim(scheduler: scheduler, isMac: false)
    buffer = VimTextBuffer(doc, tabSize: tabSize, indentUnit: indentUnit)
    buffer.clock = { 1_700_000_000_000 }
    session = buffer.attach(to: vim)
    buffer.measure()
    buffer.setCursor(line: cursor.0, ch: cursor.1)
    buffer.vimScrollIntoView(nil)
    buffer.measure()
  }

  convenience init(
    _ doc: String, cursor: (Int, Int) = (0, 0), tabSize: Int = 4, indentUnit: String = "\t"
  ) {
    self.init(VimText(doc), cursor: cursor, tabSize: tabSize, indentUnit: indentUnit)
  }

  var cm: EditorAdapter { session.cm }

  func keys(_ keys: String...) {
    for key in keys {
      session.handleKey(key, nativeEdit: { self.buffer.performNativeEdit(for: key) })
      buffer.measure()
    }
  }

  /// Types every character of `text` as a key.
  func type(_ text: String) {
    for scalar in text.unicodeScalars { keys(scalar == "\n" ? "<CR>" : String(scalar)) }
  }

  var doc: VimText { buffer.vimText }
  var text: String { buffer.text }
  var mode: VimSession.Mode { session.mode }

  /// The selections as `[line, ch]` cursors or `[anchorLine, anchorCh, headLine, headCh]` ranges.
  var selection: [[Int]] {
    buffer.selections.map {
      $0.anchor == $0.head
        ? [$0.head.line, $0.head.ch] : [$0.anchor.line, $0.anchor.ch, $0.head.line, $0.head.ch]
    }
  }

  func register(_ name: String) -> VimRegister? {
    vim.globalState.registerController.registers[name]
  }

  func expect(
    doc: VimText, selection: [[Int]], mode: VimSession.Mode = .normal,
    sourceLocation: SourceLocation = #_sourceLocation
  ) {
    #expect(self.doc == doc, sourceLocation: sourceLocation)
    #expect(self.selection == selection, sourceLocation: sourceLocation)
    #expect(self.mode == mode, sourceLocation: sourceLocation)
  }
}

/// A string with JavaScript `\uXXXX` escapes decoded, so tests can spell lone surrogates.
func js(_ text: String) -> VimText {
  var units: [UInt16] = []
  let source = Array(text.utf16)
  var i = 0
  while i < source.count {
    if source[i] == 0x5C, i + 5 < source.count, source[i + 1] == 0x75,
      let value = UInt16(String(decoding: source[(i + 2)..<(i + 6)], as: UTF16.self), radix: 16)
    {
      units.append(value)
      i += 6
    } else {
      units.append(source[i])
      i += 1
    }
  }
  return VimText(units: units)
}
