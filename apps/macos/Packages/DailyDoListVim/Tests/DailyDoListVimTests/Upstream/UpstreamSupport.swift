// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the `testVim` harness, its helpers and the shared test document.

import Testing

@testable import DailyDoListVim

/// The document most upstream tests start from (`code` in vim_test.js).
let upstreamCode =
  " wOrd1 (#%\n" + " word3] \n" + "aopop pop 0 1 2 3 4\n" + " (a) [b] {c} \n" + "int getchar(void) {\n"
  + "  static char buf[BUFSIZ];\n" + "  static char *bufp = buf;\n" + "  if (n == 0) {  /* buffer is empty */\n"
  + "    n = read(0, buf, sizeof buf);\n" + "    bufp = buf;\n" + "  }\n" + "\n"
  + "  return (--n >= 0) ? (unsigned char) *bufp++ : EOF;\n" + " \n" + "}\n"

/// `jumplistScene` in vim_test.js.
let upstreamJumplistScene = "word\n(word)\n{word\nword.\n\nword search\n}word\nword\nword\n"

/// One upstream `testVim` run: an editor with vim attached, fresh global state, and the helpers
/// the tests use (`cm`, `vim` and `helpers` in vim_test.js).
@MainActor
final class UpstreamVim {
  let vim: Vim
  let buffer: VimTextBuffer
  let session: VimSession
  var cm: EditorAdapter { session.cm }

  /// The options of `testVim(name, run, opts)`; the editor is built like upstream's CodeMirror 6
  /// runner (`tabSize: opts.tabSize || opts.indentUnit || 4`, `indentUnit` spaces or a tab).
  init(value: String = upstreamCode, indentUnit: Int? = nil, tabSize: Int? = nil, indentWithTabs: Bool = false) {
    vim = Vim(scheduler: ManualVimScheduler(), isMac: false)
    buffer = VimTextBuffer(
      value, tabSize: tabSize ?? indentUnit ?? 4, indentUnit: indentWithTabs ? "\t" : String(repeating: " ", count: indentUnit ?? 2))
    buffer.clock = { 1_700_000_000_000 }
    session = buffer.attach(to: vim)
  }

  // MARK: cm

  var value: String { buffer.text }

  func setValue(_ text: String) { cm.setValue(VimText(text)) }

  var cursor: VimPosition { cm.getCursor() }

  func setCursor(_ line: Int, _ ch: Int) { cm.setCursor(line, ch) }

  func setCursor(_ pos: VimPosition) { cm.setCursor(pos) }

  /// `cm.getSelection()`: the text of the main selection.
  var selection: String { cm.getSelection().string }

  var selections: [VimRange] { cm.listSelections() }

  func getLine(_ line: Int) -> String { cm.getLine(line).string }

  var lineCount: Int { cm.lineCount() }

  func getRange(_ from: VimPosition, _ to: VimPosition) -> String { cm.getRange(from, to).string }

  /// `cm.getOption(name)` as a string ("vim", "vim-insert" for `keyMap`).
  func option(_ name: String) -> String { cm.getOption(name)?.description ?? "" }

  /// `cm.state.overwrite`.
  var overwrite: Bool { cm.overwrite }

  var state: VimState { vim.maybeInitVimState(cm) }

  // MARK: helpers

  /// `helpers.doKeys(...)`: each argument is a key in vim notation, or text typed character by
  /// character (`"dialog\n"`, where "\n" is Enter).
  func doKeys(_ keys: String...) {
    doKeys(keys)
  }

  /// Types each key like upstream's `typeKey`: a keyboard event, turned into a vim key by
  /// `vimKeyFromEvent` (so 'langmap' applies), handled like the web app's editor does. Keys vim
  /// leaves alone in insert mode are the editor's: text is typed, Backspace/Delete delete and the
  /// arrows move the cursor (CodeMirror's default keymap).
  func doKeys(_ keys: [String]) {
    for key in keys {
      for token in Self.tokens(key) {
        let event = DOMKeyEvent(vimKey: token)
        let input = VimKeyInput(key: event.key, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey)
        guard let vimKey = session.vimKey(for: input) else { continue }
        session.handleKey(vimKey, nativeEdit: { self.nativeEdit(token) })
        buffer.measure()
      }
    }
  }

  private func nativeEdit(_ token: String) -> Bool {
    if buffer.performNativeEdit(for: token) { return true }
    switch token {
    case "<Left>": cm.cursorCharLeft()
    case "<Right>": cm.cursorCharRight()
    case "<Up>": cm.cursorLine(forward: false)
    case "<Down>": cm.cursorLine(forward: true)
    default: return false
    }
    return true
  }

  /// CodeMirror key names upstream types directly (`typeKey('Backspace')`).
  static let keyNames = ["Space": "<Space>", "Backspace": "<BS>", "Delete": "<Del>", "Up": "<Up>", "Down": "<Down>"]

  static func tokens(_ key: String) -> [String] {
    if let named = keyNames[key] { return [named] }
    if DOMKeyEvent.isNamed(key) || key.unicodeScalars.count <= 1 { return [key == "\n" ? "<CR>" : key] }
    return key.unicodeScalars.map { $0 == "\n" ? "<CR>" : String($0) }
  }

  /// `helpers.doEx(command)`: `:` + the command + Enter.
  func doEx(_ command: String) {
    doKeys(":", command, "\n")
  }

  /// `helpers.assertCursorAt(line, ch)`.
  func assertCursorAt(_ line: Int, _ ch: Int, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(cursor == VimPosition(line: line, ch: ch), sourceLocation: sourceLocation)
  }

  func assertCursorAt(_ pos: VimPosition, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(cursor == pos, sourceLocation: sourceLocation)
  }

  var registerController: RegisterController { vim.globalState.registerController }

  /// A register's text (`getRegister(name).toString()`).
  func register(_ name: String) -> String { registerController.getRegister(name).text.string }

  /// `helpers.getNotificationText()`: the message on display (a notification, or the
  /// "recording @q" status).
  var notificationText: String? {
    guard let panel = buffer.panel, panel.kind != .prompt else { return nil }
    return panel.text
  }

  var mode: VimSession.Mode { session.mode }

  /// `cm.getSelections()`: the text of every selection.
  func getSelections() -> [String] { cm.getSelections().map(\.string) }

  /// `cm.replaceRange(text, from, to)`.
  func replaceRange(_ text: String, _ from: VimPosition, _ to: VimPosition? = nil) {
    try? cm.replaceRange(VimText(text), from, to)
  }

  /// The text of the open prompt's input (`document.activeElement.value`).
  var promptValue: String { session.activePrompt?.value.string ?? "" }

  /// `searchHighlighted(vim)`: a search highlight is shown or scheduled.
  var searchHighlighted: Bool {
    guard let searchState = state.searchState else { return false }
    return searchState.overlay != nil || searchState.highlightTimeout != nil
  }

  /// `/pattern/flags.test(text)` (JavaScript's `test` coerces nil to "null").
  func matches(_ pattern: String, _ flags: String, _ text: String?) -> Bool {
    guard let regex = try? JSRegExp(VimText(pattern), flags: flags) else { return false }
    return regex.test(VimText(text ?? "null"))
  }
}

/// `dvorakLangmap` in vim_test.js.
let upstreamDvorakLangmap =
  "'q,\\,w,.e,pr,yt,fy,gu,ci,ro,lp,/[,=],aa,os,ed,uf,ig,dh,hj,tk,nl,s\\;,-',\\;z,qx,jc,kv,xb,bn,mm,w\\,,v.,z/,[-,]=,\"Q,<W,>E,PR,YT,FY,GU,CI,RO,LP,?{,+},AA,OS,ED,UF,IG,DH,HJ,TK,NL,S:,_\",:Z,QX,JC,KV,XB,BN,MM,W<,V>,Z?"

extension String {
  /// JavaScript's `indexOf` (UTF-16 index, -1 when absent).
  func jsIndexOf(_ search: String) -> Int { VimText(self).indexOf(VimText(search)) }

  func jsRepeat(_ count: Int) -> String { String(repeating: self, count: count) }
}

extension VimPosition {
  init(_ line: Int, _ ch: Int) {
    self.init(line: line, ch: ch)
  }
}
