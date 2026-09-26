// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `testVim` cases that use the vim API, callbacks or editor internals, translated by hand. Those a
// behavior vector expresses are recorded in vectors.jsonl instead; these check what vectors can't:
// defined options and their values, defined ex commands, the mode and keypress callbacks, `:write`,
// `handleKey`'s result, an edit made inside a vim operation, 'langmap' and the search highlight.

import Testing

@testable import DailyDoListVim

@MainActor
@Suite struct UpstreamManualTests {
  @Test("set_boolean")
  func setBoolean() throws {
    let t = UpstreamVim()
    try t.vim.defineOption("testoption", defaultValue: true, type: .boolean)
    #expect(try t.vim.getOption("testoption") == .bool(true))
    #expect(throws: JSException.self) { try t.vim.setOption("testoption", "5") }
    try t.vim.setOption("testoption", false)
    #expect(try t.vim.getOption("testoption") == .bool(false))
  }

  @Test("ex_set_boolean")
  func exSetBoolean() throws {
    let t = UpstreamVim()
    try t.vim.defineOption("testoption", defaultValue: true, type: .boolean)
    #expect(try t.vim.getOption("testoption") == .bool(true))
    #expect(t.cm.currentNotificationClose == nil)
    t.doEx("set testoption=22")
    #expect(t.cm.currentNotificationClose != nil)
    t.doEx("set notestoption")
    #expect(try t.vim.getOption("testoption") == .bool(false))
    t.doEx("set notestoption!")
    #expect(try t.vim.getOption("testoption") == .bool(true))
    t.doEx("set notestoption!")
    #expect(try t.vim.getOption("testoption") == .bool(false))
    t.doEx("set testoption!")
    #expect(try t.vim.getOption("testoption") == .bool(true))
    t.doEx("set testoption!")
    #expect(try t.vim.getOption("testoption") == .bool(false))
  }

  @Test("set_string")
  func setString() throws {
    let t = UpstreamVim()
    try t.vim.defineOption("testoption", defaultValue: "a", type: .string)
    #expect(try t.vim.getOption("testoption") == "a")
    try t.vim.setOption("testoption", true)
    #expect(throws: JSException.self) { try t.vim.setOption("notestoption", "b") }
    try t.vim.setOption("testoption", "c")
    #expect(try t.vim.getOption("testoption") == "c")
  }

  @Test("ex_set_string")
  func exSetString() throws {
    let t = UpstreamVim()
    try t.vim.defineOption("testopt", defaultValue: "a", type: .string)
    #expect(try t.vim.getOption("testopt") == "a")
    #expect(t.cm.currentNotificationClose == nil)
    t.doEx("set notestopt=b")
    #expect(t.cm.currentNotificationClose != nil)
    t.doEx("set testopt=c")
    try expectScopes(t, local: "c", global: "c")
    t.doEx("setg testopt=d")
    try expectScopes(t, local: "c", global: "d")
    t.doEx("setl testopt=e")
    try expectScopes(t, local: "e", global: "d")
  }

  @Test("ex_set_callback")
  func exSetCallback() throws {
    let t = UpstreamVim()
    var global: VimOptionValue?
    var local: [ObjectIdentifier: VimOptionValue] = [:]
    try t.vim.defineOption("testopt", defaultValue: "a", type: .string) { value, session in
      if let value {
        if let session { local[ObjectIdentifier(session)] = value } else { global = value }
        return nil
      }
      return session.map { local[ObjectIdentifier($0)] } ?? global
    }
    #expect(try t.vim.getOption("testopt") == "a")
    #expect(t.cm.currentNotificationClose == nil)
    t.doEx("set notestopt=b")
    #expect(t.cm.currentNotificationClose != nil)
    t.doEx("set testopt=c")
    try expectScopes(t, local: "c", global: "c")
    t.doEx("setg testopt=d")
    try expectScopes(t, local: "c", global: "d")
    t.doEx("setl testopt=e")
    try expectScopes(t, local: "e", global: "d")
  }

  private func expectScopes(_ t: UpstreamVim, local: VimOptionValue, global: VimOptionValue) throws
  {
    #expect(try t.vim.getOption("testopt", in: t.session) == local)
    #expect(try t.vim.getOption("testopt", in: t.session, scope: .local) == local)
    #expect(try t.vim.getOption("testopt", in: t.session, scope: .global) == global)
    #expect(try t.vim.getOption("testopt") == global)
  }

  @Test("ex_api_test")
  func exApiTest() throws {
    let t = UpstreamVim()
    var result = false
    var value = "from"
    try t.vim.defineEx("extest", "ext") { _, params in
      if let first = params.args.first { value = first } else { result = true }
    }
    t.doEx(":ext to")
    #expect(value == "to")
    try t.vim.map("<C-CR><Space>", ":ext<CR>")
    t.doKeys("<C-CR>", "<Space>")
    #expect(result)
  }

  @Test("ex_special_names")
  func exSpecialNames() throws {
    let t = UpstreamVim()
    var ran: String?
    var value: String?
    for name in ["!", "!!", "#", "&", "<", "=", ">", "@", "@@", "~", "regtest1", "RT2"] {
      try t.vim.defineEx(name, "") { _, params in
        ran = params.commandName
        value = params.argString
      }
      t.doEx(":" + name)
      #expect(ran == name)
      t.doEx(":" + name + " x")
      #expect(value == " x", "\(name)")
      if name.allSatisfy({ !$0.isLetter && !$0.isNumber && $0 != "_" }) {
        t.doEx(":" + name + "y")
        #expect(value == "y", "\(name)")
      } else {
        t.doEx(":" + name + "-y")
        #expect(value == "-y", "\(name)")
      }
      if name != "!" {
        t.doEx(":" + name + "!")
        #expect(ran == name)
        #expect(value == "!", "\(name)")
        t.doEx(":" + name + "!z")
        #expect(ran == name)
        #expect(value == "!z", "\(name)")
      }
    }
  }

  @Test("on_mode_change")
  func onModeChange() {
    let t = UpstreamVim()
    var history: [String] = []
    t.doKeys("<Esc>", "<Esc>")
    t.session.onModeChange = { mode, subMode in
      history.append(mode + (subMode.map { $0.isEmpty ? "" : ":" + $0 } ?? ""))
    }
    func check(_ key: String, _ modes: String, sourceLocation: SourceLocation = #_sourceLocation) {
      history.removeAll()
      t.doKeys(key)
      #expect(history.joined(separator: ";") == modes, sourceLocation: sourceLocation)
    }
    check("v", "visual")
    check("c", "insert")
    check("<Esc>", "normal")
    check("<C-v>", "visual:blockwise")
    check("I", "insert")
    check("<Esc>", "normal")
    check("R", "replace")
    check("x", "")
    check("<C-[>", "normal")
    check("v", "visual")
    check("V", "visual:linewise")
    check("<C-v>", "visual:blockwise")
    check("v", "visual")
    check("<C-c>", "normal")
    check("a", "insert")
    check("<Esc>", "normal")
    check("v", "visual")
    check(":", "")
    check("y\n", "normal")
    check(":startinsert\n", "insert")
  }

  @Test("updateStatus")
  func updateStatus() {
    let t = UpstreamVim(value: "text match match \n next")
    var keys = ""
    t.session.onKeypress = { keys += $0 }
    t.session.onCommandDone = { keys = "" }
    t.doKeys("d")
    #expect(keys == "d")
    t.doKeys("/", "match", "\n")
    #expect(keys == "")
    t.assertCursorAt(0, 0)
    t.doKeys("d")
    #expect(keys == "d")
    t.doKeys("/", "<Esc>")
    #expect(keys == "")
    t.doKeys("d")
    #expect(keys == "d")
    t.doKeys(":")
    #expect(keys == "d:")
    t.doKeys("<Esc>")
    #expect(keys == "")
  }

  @Test("._normal")
  func repeatNormal() throws {
    let t = UpstreamVim(value: "1 2 3 4 5 6")
    t.setCursor(0, 0)
    t.doKeys("2", "d", "w")
    t.doKeys(".")
    #expect(t.value == "5 6")
    t.doKeys("a")
    try t.cm.operation {
      t.cm.curOp?.isVimOp = true
      t.cm.replaceSelection("()")
      t.cm.setCursor(t.cursor.offsetting(0, -1))
    }
    t.doKeys("x", "y", "<Esc>")
    t.doKeys(".")
    #expect(t.value == "5(xy(xy)) 6")
  }

  @Test("ex_unmap_api")
  func exUnmapApi() throws {
    let t = UpstreamVim()
    try t.vim.map("<Alt-X>", "gg", context: "normal")
    #expect(try t.vim.handleKey(t.cm, "<Alt-X>", "normal"))
    try t.vim.unmap("<Alt-X>", context: "normal")
    #expect(try !t.vim.handleKey(t.cm, "<Alt-X>", "normal"))
  }

  @Test("ex_write")
  func exWrite() {
    let t = UpstreamVim()
    var written = false
    t.buffer.onSave = { written = true }
    for length in 1..<5 {
      written = false
      t.doEx(String("write".prefix(length)))
      #expect(written, "\("write".prefix(length))")
    }
  }

  @Test("ex_map_key2ex")
  func exMapKeyToEx() {
    let t = UpstreamVim()
    t.doEx("map a :w<CR>")
    var written = false
    t.buffer.onSave = { written = true }
    t.doKeys("a")
    #expect(written)
  }

  @Test("ex_map_ex2ex")
  func exMapExToEx() {
    let t = UpstreamVim()
    t.doEx("map :del :w")
    var written = false
    t.buffer.onSave = { written = true }
    t.doEx("del")
    #expect(written)
  }

  @Test("ex_map_key2key_visual_api")
  func exMapKeyToKeyVisualApi() throws {
    let t = UpstreamVim()
    try t.vim.map("b", ":w<CR>", context: "visual")
    var written = false
    t.buffer.onSave = { written = true }
    t.doKeys("b")
    #expect(!written)
    t.doKeys("v", "b")
    #expect(written)
  }

  @Test("langmap_hh")
  func langmapHH() {
    let t = UpstreamVim()
    t.vim.setLangmap(upstreamDvorakLangmap)
    t.setCursor(0, 5)
    t.doKeys("d", "d")
    t.assertCursorAt(0, 3)
  }

  @Test("map_prompt")
  func mapPrompt() {
    let t = UpstreamVim(value: " 0 xyz\n 1 abc \n 2 abc")
    #expect(!t.searchHighlighted)
    t.doKeys("/a\n")
    t.doKeys("i")
    #expect(t.searchHighlighted)
    t.doKeys("<Esc>")
    t.doEx("nohl")
    #expect(!t.searchHighlighted)
    t.assertCursorAt(1, 2)
    t.doEx("nnoremap i :nohl<CR>i<space>xx<lt>")
    t.doEx("map :sayhi ihi<Esc>")
    t.doEx("map j :sayhi<CR>/<up><up>b")
    t.doKeys("/1\n")
    t.assertCursorAt(1, 1)
    t.doKeys("j")
    #expect(t.promptValue == "ab")
    t.doKeys("<CR>")
    #expect(t.searchHighlighted)
    t.doKeys("i")
    #expect(!t.searchHighlighted)
    #expect(t.value == " 0 xyz\n hi1  xx<abc \n 2 abc")
  }
}
