import DailyDoListVim
import Testing

/// The public API a host uses, exercised without `@testable` access.
@MainActor
@Suite struct HostAPITests {
  private func make(_ text: String) -> (Vim, VimTextBuffer, VimSession, ManualVimScheduler) {
    let scheduler = ManualVimScheduler()
    let vim = Vim(scheduler: scheduler, isMac: false)
    let buffer = VimTextBuffer(text)
    let session = buffer.attach(to: vim)
    return (vim, buffer, session, scheduler)
  }

  @Test func handleKeyReportsWhatItHandled() {
    // The session doesn't retain its editor: the host keeps both alive.
    let (_, buffer, session, _) = make("abc")
    #expect(session.handleKey("l"))
    #expect(session.cursor == VimPosition(line: 0, ch: 1))
    #expect(session.handleKey("i"))
    #expect(session.mode == .insert)
    // Typing is the host's: without a native edit the key is unhandled…
    #expect(!session.handleKey("x"))
    #expect(buffer.text == "abc")
    // …with one, the host types and vim records the text for `.`.
    #expect(session.handleKey("x", nativeEdit: { buffer.performNativeEdit(for: "x") }))
    #expect(session.handleKey("<Esc>"))
    #expect(buffer.text == "axbc")
    session.handleKey(".")
    #expect(buffer.text == "axxbc")
  }

  @Test func keysGoToTheOpenPrompt() {
    let (_, buffer, session, _) = make("one\ntwo\nthree")
    session.handleKey(":")
    #expect(session.activePrompt?.text == ":")
    #expect(buffer.panel === session.activePrompt)
    for key in ["2", "d", "<BS>", "d"] { session.handleKey(key) }
    #expect(session.activePrompt?.value == "2d")
    session.handleKey("<CR>")
    #expect(session.activePrompt == nil)
    #expect(buffer.text == "one\nthree")
  }

  @Test func promptsWorkWithTheHostsOwnField() {
    let (_, buffer, session, _) = make("a b a")
    session.handleKey("/")
    let prompt = try! #require(session.activePrompt)
    #expect(!prompt.keyDown("a"))
    prompt.setValue("a")
    prompt.keyUp("a")
    #expect(prompt.keyDown("<CR>"))
    #expect(prompt.isClosed)
    #expect(session.cursor == VimPosition(line: 0, ch: 4))
    #expect(buffer.text == "a b a")
  }

  @Test func callbacksReportModesKeysAndCommands() {
    let (_, buffer, session, _) = make("abc")
    defer { withExtendedLifetime(buffer) {} }
    var events: [String] = []
    session.onModeChange = { mode, subMode in
      events.append("mode \(mode)\(subMode.map { " " + $0 } ?? "")")
    }
    session.onKeypress = { events.append("key \($0)") }
    session.onCommandDone = { events.append("done") }
    session.handleKey("V")
    session.handleKey("<Esc>")
    session.handleKey("2")
    session.handleKey("x")
    // The web app's order (recorded in Chromium): an action clears the pending keys before it
    // runs, and leaving visual mode with <Esc> reports "normal" twice.
    #expect(
      events == [
        "done", "mode visual linewise", "key V", "mode normal", "mode normal", "done", "key <Esc>",
        "key 2", "done", "key x",
      ])
    #expect(session.pendingKeys == "")
  }

  @Test func exCommandsCanBeDefined() throws {
    let (vim, buffer, session, _) = make("abc\ndef\nghi")
    var seen: VimExCommand?
    try vim.defineEx("greet", "gr") { _, command in seen = command }
    try session.handleEx("2,3greet world wide")
    #expect(seen?.commandName == "greet")
    #expect(seen?.args == ["world", "wide"])
    #expect(seen?.line == 1 && seen?.lineEnd == 2)
    #expect(throws: JSException.self) { try vim.defineEx("greet", "x") { _, _ in } }
    #expect(buffer.lineCount == 3)
  }

  @Test func writeCallsTheHost() throws {
    let (_, buffer, session, _) = make("abc")
    var saved = 0
    buffer.onSave = { saved += 1 }
    try session.handleEx("w")
    try session.handleEx("write")
    #expect(saved == 2)
  }

  @Test func registersCanBeBackedByTheHost() throws {
    final class Clipboard: VimClipboard {
      var text = "from host"
      func readText() -> String? { text }
      func writeText(_ text: String) { self.text = text }
    }
    let (vim, buffer, session, _) = make("abc")
    let clipboard = Clipboard()
    vim.clipboard = clipboard
    for key in ["\"", "+", "y", "w"] { session.handleKey(key) }
    #expect(clipboard.text == "abc")
    clipboard.text = "XY"
    for key in ["\"", "+", "P"] { session.handleKey(key) }
    #expect(buffer.text == "XYabc")

    final class Constant: VimRegister {
      override var text: VimText { "constant" }
    }
    try vim.defineRegister("*", Constant())
    // vim.js leaves the cursor after text put with P.
    for key in ["\"", "*", "p"] { session.handleKey(key) }
    #expect(buffer.text == "XYaconstantbc")
  }

  @Test func mappingsAndOptions() throws {
    let (vim, buffer, session, _) = make("one two")
    try vim.map("Q", "dw")
    session.handleKey("Q")
    #expect(buffer.text == "two")
    try vim.unmap("Q")
    try vim.noremap("L", "$")
    session.handleKey("L")
    #expect(session.cursor == VimPosition(line: 0, ch: 2))
    vim.mapclear()
    session.handleKey("0")
    session.handleKey("L")
    #expect(session.cursor == VimPosition(line: 0, ch: 0))
    try vim.setOption("textwidth", 40, in: session)
    #expect(try vim.getOption("textwidth", in: session) == 40)
    #expect(throws: JSException.self) { try vim.setOption("nosuchoption", 1) }
  }

  @Test func resetKeepsMappingsButClearsRegisters() throws {
    let (vim, buffer, session, _) = make("abc")
    try vim.map("Q", "x")
    session.handleKey("y")
    session.handleKey("l")
    #expect(vim.register("\"").text == "a")
    vim.resetGlobalState()
    #expect(vim.register("\"").text == "")
    session.handleKey("Q")
    #expect(buffer.text == "bc")
  }

  @Test func insertModeMappingsTypeFirstAndTimeOut() throws {
    let (vim, buffer, session, scheduler) = make("")
    func type(_ key: String) {
      session.handleKey(key, nativeEdit: { buffer.performNativeEdit(for: key) })
    }
    try vim.map("jk", "<Esc>", context: "insert")
    type("i")
    // The first key of the mapping is typed right away…
    type("j")
    #expect(buffer.text == "j")
    // …and taken back when the mapping completes.
    type("k")
    #expect(buffer.text == "")
    #expect(session.mode == .normal)
    // After 'insertModeEscKeysTimeout' (200 ms) the pending key is plain text.
    type("i")
    type("j")
    scheduler.advance(by: 0.25)
    type("k")
    #expect(buffer.text == "jk")
    #expect(session.mode == .insert)
  }

  @Test func searchHighlightAppearsAfterItsDelay() {
    let (_, buffer, session, scheduler) = make("foo bar foo")
    for key in ["/", "f", "o", "o", "<CR>"] { session.handleKey(key) }
    scheduler.advance(by: 0.05)
    #expect(buffer.searchHighlight?.matches(from: 0, to: 11).count == 2)
    try? session.handleEx("nohlsearch")
    #expect(buffer.searchHighlight == nil)
  }

  @Test func errorsAreReportedAndVimRecovers() {
    let (vim, buffer, session, _) = make("abc")
    var errors: [String] = []
    vim.onError = { errors.append($0.description) }
    // `ia<` outside any `<…>` makes vim.js search with /\</, which unicode mode rejects.
    for key in ["d", "i", "<"] { session.handleKey(key) }
    #expect(errors.count == 1)
    session.handleKey("x")
    #expect(buffer.text == "bc")
  }

  @Test func detachedSessionsIgnoreKeys() {
    let (_, buffer, session, _) = make("abc")
    session.detach()
    #expect(!session.handleKey("x"))
    #expect(buffer.text == "abc")
  }

  @Test func keyNotationIsPlatformNeutral() {
    #expect(VimKeyNotation.vimKey(for: VimKeyInput(key: "d", control: true)) == "<C-d>")
    #expect(VimKeyNotation.vimKey(for: VimKeyInput(key: "Escape")) == "<Esc>")
    #expect(VimKeyNotation.vimKey(for: VimKeyInput(key: "Shift", shift: true)) == nil)
  }
}

/// A host written against `VimEditor` alone: it keeps its text in a `VimTextBuffer` and handles
/// the keys vim replays through the editor's key bindings itself.
@MainActor
private final class CustomHost: VimEditor {
  let storage = VimTextBuffer("abc")
  var performedKeys: [String] = []

  var vimLineCount: Int { storage.vimLineCount }
  func vimLine(_ line: Int) -> VimText { storage.vimLine(line) }
  func vimLineStart(_ line: Int) -> Int { storage.vimLineStart(line) }
  func vimLineNumber(at offset: Int) -> Int { storage.vimLineNumber(at: offset) }
  var vimLength: Int { storage.vimLength }
  var vimSelection: VimSelection { storage.vimSelection }
  func vimApply(_ transaction: VimTransaction) { storage.vimApply(transaction) }
  func vimUndo() -> VimTransaction? { storage.vimUndo() }
  func vimRedo() -> VimTransaction? { storage.vimRedo() }
  var vimTabSize: Int { 4 }
  var vimIndentUnit: String { "  " }
  var vimIsReadOnly: Bool { false }
  var vimLineHeight: Double { 20 }
  var vimViewport: VimViewport { storage.vimViewport }
  func vimScroll(top: Double?, left: Double?) { storage.vimScroll(top: top, left: left) }
  func vimScrollIntoView(_ offset: Int?) { storage.vimScrollIntoView(offset) }
  func vimCoords(at offset: Int, side: Int) -> VimRect? {
    storage.vimCoords(at: offset, side: side)
  }
  func vimOffset(at point: VimPoint) -> Int { storage.vimOffset(at: point) }
  func vimShowPanel(_ panel: VimPanel?) {}
  func vimShowSearchHighlight(_ highlight: VimSearchHighlight?) {}
  func vimFocus() {}
  func vimPerformKey(_ key: String) -> Bool {
    performedKeys.append(key)
    return true
  }
}

@MainActor
@Suite struct CustomHostTests {
  @Test func vimDrivesAnyVimEditor() throws {
    let host = CustomHost()
    let vim = Vim(scheduler: ManualVimScheduler(), isMac: false)
    let session = vim.attach(to: host)
    session.handleKey("x")
    #expect(host.storage.text == "bc")
    session.handleKey("u")
    #expect(host.storage.text == "abc")
    // An insert-mode mapping to <Left> runs the host's key binding.
    try vim.map("<C-h>", "<Left>", context: "insert")
    session.handleKey("A")
    session.handleKey("<C-h>")
    #expect(host.performedKeys == ["Left"])
  }
}
