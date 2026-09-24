// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `testVim` cases that use the vim API, callbacks or editor internals, translated by hand.

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

  @Test("mouse_select")
  func mouseSelect() {
    let t = UpstreamVim(value: "abcdef")
    t.buffer.select([VimRange(anchor: VimPosition(0, 2), head: VimPosition(0, 4))])
    #expect(t.state.visualMode)
    #expect(!t.state.visualLine)
    #expect(!t.state.visualBlock)
    t.doKeys("<Esc>")
    #expect(!t.cm.somethingSelected())
    t.doKeys("g", "v")
    #expect(t.selection == "cd")
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

  @Test("reselect_visual_block")
  func reselectVisualBlock() {
    let t = UpstreamVim(value: "123456\nfoo\nbar")
    t.setCursor(1, 2)
    t.doKeys("<C-v>", "k", "h", "<C-v>")
    t.setCursor(2, 1)
    t.doKeys("v", "l", "g", "v")
    #expect(t.state.sel.anchor == VimPosition(1, 2))
    #expect(t.state.sel.head == VimPosition(0, 1))
    #expect(t.getSelections().joined() == "23oo")
    t.doKeys("g", "v")
    #expect(t.state.sel.anchor == VimPosition(2, 1))
    #expect(t.state.sel.head == VimPosition(2, 2))
    t.doKeys("<Esc>")
    t.setCursor(1, 1)
    t.doKeys("v", "<C-v>", "j", "d", "g", "v")
    #expect(t.getSelections().joined() == "or")
  }

  @Test("o_visual_block")
  func oVisualBlock() {
    let t = UpstreamVim(value: "abcd\nefgh\nijkl\nmnop")
    t.setCursor(0, 1)
    t.doKeys("<C-v>", "3", "j", "l", "l", "o")
    #expect(t.state.sel.anchor == VimPosition(3, 3))
    #expect(t.state.sel.head == VimPosition(0, 1))
    t.doKeys("O")
    #expect(t.state.sel.anchor == VimPosition(3, 1))
    #expect(t.state.sel.head == VimPosition(0, 3))
    t.doKeys("o")
    #expect(t.state.sel.anchor == VimPosition(0, 3))
    #expect(t.state.sel.head == VimPosition(3, 1))
  }

  @Test("._delete_visualBlock")
  func repeatDeleteVisualBlock() {
    let t = UpstreamVim(value: "give\nme\nsome\nsugar")
    t.doKeys("<C-v>", "j", "x")
    #expect(t.value == "ive\ne\nsome\nsugar")
    t.doKeys(".")
    #expect(t.value == "ve\n\nsome\nsugar")
    t.doKeys("j", "j", ".")
    #expect(t.value == "ve\n\nome\nugar")
    t.doKeys("u")
    t.assertCursorAt(2, 0)
    #expect(t.value == "ve\n\nsome\nsugar")
    t.doKeys("<C-r>")
    t.assertCursorAt(2, 0)
    #expect(t.value == "ve\n\nome\nugar")
    t.doKeys(".")
    t.assertCursorAt(2, 0)
    #expect(t.value == "ve\n\nme\ngar")
  }

  @Test("jumpToMark_next_line_action")
  func jumpToMarkNextLineAction() {
    let t = UpstreamVim()
    t.setCursor(2, 2)
    t.doKeys("m", "t")
    t.setCursor(0, 0)
    t.doKeys("d", "]", "'")
    t.assertCursorAt(0, 1)
    #expect(t.getLine(0) == " (a) [b] {c} ")
  }

  @Test("._replace_repeat")
  func repeatReplace() {
    let t = UpstreamVim(value: "abcdef\nabcdefg")
    t.doKeys("R")
    t.replaceRange("123", t.cursor, t.cursor.offsetting(0, 3))
    t.setCursor(0, 3)
    t.doKeys("<Esc>")
    t.doKeys("2", ".")
    #expect(t.value == "12123123\nabcdefg")
    t.assertCursorAt(0, 7)
    t.setCursor(1, 0)
    t.doKeys(".")
    #expect(t.value == "12123123\n123123g")
    t.doKeys("l", "\"", ".", "p")
    #expect(t.value == "12123123\n123123g123")
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

  @Test("ex_imap")
  func exImap() throws {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")
    try t.vim.map("jk", "<Esc>", context: "insert")
    t.doKeys("i")
    #expect(t.state.insertMode)
    t.doKeys("j", "k")
    #expect(!t.state.insertMode)
    t.setCursor(0, 1)
    try t.vim.map("jj", "<Esc>", context: "insert")
    t.doKeys("<C-v>", "2", "j", "l", "c")
    t.doKeys("f", "o")
    #expect(t.value == "1fo4\n5fo8\nafodefg")
    t.doKeys("j", "j")
    t.setCursor(0, 0)
    t.doKeys(".")
    #expect(t.value == "foo4\nfoo8\nfoodefg")
    t.doKeys("R", "x", "j", "j")
    #expect(t.value == "xoo4\nfoo8\nfoodefg")
    t.doKeys("i")
    t.cm.setSelections([
      VimRange(anchor: VimPosition(0, 1), head: VimPosition(0, 0)),
      VimRange(anchor: VimPosition(1, 2), head: VimPosition(1, 0)),
    ])
    t.doKeys("j")
    #expect(t.value == "joo4\njo8\nfoodefg")
    t.doKeys("j")
    #expect(t.value == "xoo4\nfoo8\nfoodefg")
    t.cm.setSelections([
      VimRange(cursor: VimPosition(0, 2)), VimRange(cursor: VimPosition(1, 2)),
      VimRange(cursor: VimPosition(2, 4)),
    ])
    t.doKeys("R", "x")
    #expect(t.value == "xox4\nfox8\nfoodxfg")
    t.doKeys("j")
    #expect(t.value == "xoxj\nfoxj\nfoodxjg")
    t.doKeys("k")
    #expect(t.value == "xox4\nfox8\nfoodxfg")
    #expect(t.selections.count == 3)
    t.setValue("1\n2")
    t.doKeys("gg", "dd")
    t.doEx("imap a <C-c>")
    t.doKeys("i", "x", "a", "p")
    #expect(t.value == "x2\n1")
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

  @Test("ex_map_key2key_to_colon")
  func exMapKeyToColon() {
    let t = UpstreamVim()
    t.doEx("map ; :")
    t.doKeys(";")
    #expect(t.session.activePrompt?.text == ":")
  }

  @Test("<C-x>/<C-a> search forward", arguments: ["<C-x>", "<C-a>"])
  func incrementSearchesForward(_ key: String) {
    let t = UpstreamVim(value: "__jmp1 jmp2 jmp")
    t.setCursor(0, 0)
    t.doKeys(key)
    t.assertCursorAt(0, 5)
    t.doKeys("l")
    t.doKeys(key)
    t.assertCursorAt(0, 10)
    t.setCursor(0, 11)
    t.doKeys(key)
    t.assertCursorAt(0, 11)
  }

  @Test("[*, ]*, [/, ]/", arguments: ["*", "/"])
  func commentMotions(_ key: String) {
    let t = UpstreamVim(
      value:
        "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else"
    )
    t.setCursor(7, 0)
    t.doKeys("2", "[", key)
    t.assertCursorAt(2, 2)
    t.doKeys("2", "]", key)
    t.assertCursorAt(7, 5)
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

  @Test("ex_advanced_range_syntax")
  func exAdvancedRangeSyntax() {
    let t = UpstreamVim(value: "1\n2\n3\n4m\n5\n6\n7m\n8\n9m\n10\n")
    t.doEx("0/m")
    t.assertCursorAt(3, 0)
    t.doKeys("m", "a")
    t.doEx("/m//m/")
    t.assertCursorAt(8, 0)
    t.doEx("'a,.y x")
    t.doEx("10?m??m?put! x")
    #expect(t.value == "1\n2\n3\n4m\n5\n6\n4m\n5\n6\n7m\n8\n9m\n7m\n8\n9m\n10\n")
    t.doEx("1+++2+/m/,1/m//m/+2-/m/+2d")
    #expect(t.value == "1\n2\n3\n4m\n5\n6\n7m\n8\n9m\n10\n")
    t.doKeys("3", ":")
    #expect(t.promptValue == ".,.+2")
    t.doKeys("d", "\n")
    #expect(t.value == "1\n2\n3\n4m\n5\n6\n10\n")
  }
}
