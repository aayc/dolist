// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the `testVim` harness, its helpers and the shared test document.

import Testing

@testable import DailyDoListVim

/// The document most upstream tests start from (`code` in vim_test.js).
let upstreamCode =
  " wOrd1 (#%\n" + " word3] \n" + "aopop pop 0 1 2 3 4\n" + " (a) [b] {c} \n"
  + "int getchar(void) {\n"
  + "  static char buf[BUFSIZ];\n" + "  static char *bufp = buf;\n"
  + "  if (n == 0) {  /* buffer is empty */\n"
  + "    n = read(0, buf, sizeof buf);\n" + "    bufp = buf;\n" + "  }\n" + "\n"
  + "  return (--n >= 0) ? (unsigned char) *bufp++ : EOF;\n" + " \n" + "}\n"

/// One upstream `testVim` run: an editor with vim attached, fresh global state, and the helpers
/// the tests use (`cm`, `vim` and `helpers` in vim_test.js).
@MainActor
final class UpstreamVim {
  let vim: Vim
  let buffer: VimTextBuffer
  let session: VimSession
  var cm: EditorAdapter { session.cm }

  /// `testVim(name, run, {value})`: the editor upstream's CodeMirror 6 runner builds when no indent
  /// options are given (tab size 4, a two-space indent unit).
  init(value: String = upstreamCode) {
    vim = Vim(scheduler: ManualVimScheduler(), isMac: false)
    buffer = VimTextBuffer(value, tabSize: 4, indentUnit: "  ")
    buffer.clock = { 1_700_000_000_000 }
    session = buffer.attach(to: vim)
  }

  // MARK: cm

  var value: String { buffer.text }

  var cursor: VimPosition { cm.getCursor() }

  func setCursor(_ line: Int, _ ch: Int) { cm.setCursor(line, ch) }

  var lineCount: Int { cm.lineCount() }

  func getRange(_ from: VimPosition, _ to: VimPosition) -> String { cm.getRange(from, to).string }

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
        let input = VimKeyInput(
          key: event.key, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
          shift: event.shiftKey)
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
  static let keyNames = [
    "Space": "<Space>", "Backspace": "<BS>", "Delete": "<Del>", "Up": "<Up>", "Down": "<Down>",
  ]

  static func tokens(_ key: String) -> [String] {
    if let named = keyNames[key] { return [named] }
    if DOMKeyEvent.isNamed(key) || key.unicodeScalars.count <= 1 {
      return [key == "\n" ? "<CR>" : key]
    }
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

  var registerController: RegisterController { vim.globalState.registerController }

  /// `helpers.getNotificationText()`: the message on display (a notification, or the
  /// "recording @q" status).
  var notificationText: String? {
    guard let panel = buffer.panel, panel.kind != .prompt else { return nil }
    return panel.text
  }

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
}

/// `dvorakLangmap` in vim_test.js.
let upstreamDvorakLangmap =
  "'q,\\,w,.e,pr,yt,fy,gu,ci,ro,lp,/[,=],aa,os,ed,uf,ig,dh,hj,tk,nl,s\\;,-',\\;z,qx,jc,kv,xb,bn,mm,w\\,,v.,z/,[-,]=,\"Q,<W,>E,PR,YT,FY,GU,CI,RO,LP,?{,+},AA,OS,ED,UF,IG,DH,HJ,TK,NL,S:,_\",:Z,QX,JC,KV,XB,BN,MM,W<,V>,Z?"

extension VimPosition {
  init(_ line: Int, _ ch: Int) {
    self.init(line: line, ch: ch)
  }
}
