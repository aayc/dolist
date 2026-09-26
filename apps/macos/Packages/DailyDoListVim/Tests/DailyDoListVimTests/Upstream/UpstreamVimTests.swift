// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `testVim` cases translated statement by statement from the upstream source. The rest of the
// suite is recorded in the behavior vectors (`origin: "upstream:<test>"` in
// packages/editor/test/vim/vectors.jsonl), which `VectorReplayTests` replays; these cases check
// what a vector can't express:
//   macro_insert: the "recording @a" status line
//   ._insert: an arrow key moving the cursor in insert mode (vectors ignore unhandled arrows)
//   ex_noh_clearSearchHighlight: the search highlight
//   set_langmap, langmap_*: 'langmap' translating typed keys (vectors hold the translated keys)
// Tests whose behavior depends on a language mode, soft wrapping or CodeMirror 5 metrics aren't
// ported at all; these translated ones are left out:
//   %_seek_skip: needs a language mode: % skips brackets in strings and comments by syntax token
//   %_skip_string: needs a language mode: % skips brackets in strings and comments by syntax token
//   %_skip_comment: needs a language mode: % skips brackets in strings and comments by syntax token
//   ._insert_o_indent: upstream's runner replaces newlineAndIndent to indent after an open bracket
//   =: indentAuto needs a language mode
//   s_visual_block: S indents the new line by the language mode
//   ci" for two strings: upstream's basicSetup editor gives a different result; the no-language oracle editor gives what this port gives
//   ex_substitute_highlight: passes upstream only through a timer id left by earlier tests (vim.js stores the previous highlight timer in searchState.highlightTimeout)

import Testing

@testable import DailyDoListVim

@MainActor
@Suite struct UpstreamVimTests {
  @Test("macro_insert")
  func u227_macro_insert() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "0", "i")
    t.doKeys("foo")
    t.doKeys("<Esc>")
    #expect(t.notificationText == ("recording @a"))
    t.doKeys("q", "@", "a")
    #expect(t.notificationText == nil)
    #expect("foofoo" == t.value)
  }

  @Test("._insert")
  func u259_insert() {
    let t = UpstreamVim(value: "")

    t.doKeys("i")
    t.doKeys("test")
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("testestt" == t.value)
    t.assertCursorAt(0, 6)
    t.doKeys("O")
    t.doKeys("xyz")
    t.doKeys("Backspace")
    t.doKeys("Down")
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("xy\nxy\ntestestt" == t.value)
    t.assertCursorAt(1, 1)
  }

  @Test("ex_noh_clearSearchHighlight")
  func u358_ex_noh_clearSearchHighlight() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    #expect(!t.searchHighlighted)
    t.doKeys("?", "match", "\n")
    #expect(t.searchHighlighted)
    t.doEx("noh")
    #expect(!t.searchHighlighted)
    t.doKeys("n")
    t.assertCursorAt(0, 11)
  }

  @Test("set_langmap")
  func u360_set_langmap() {
    let t = UpstreamVim()

    t.doEx("set langmap==j")
    t.setCursor(0, 0)
    t.doKeys("=")
    t.assertCursorAt(1, 0)
  }

  @Test("langmap_dd")
  func u384_langmap_dd() {
    let t = UpstreamVim()

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: nil)
    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(1, 0))
    let expectedLineCount = t.lineCount - 1
    t.doKeys("e", "e")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("langmap_qqddq@q")
  func u385_langmap_qqddq_q() {
    let t = UpstreamVim()

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: nil)
    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(1, 0), VimPosition(2, 0))
    let expectedLineCount = t.lineCount - 2
    t.doKeys("''", "e", "e", "'", "@'")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("langmap_fd")
  func u386_langmap_fd() {
    let t = UpstreamVim()

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: nil)
    t.setCursor(0, 0)
    t.doKeys("u", "d")
    t.assertCursorAt(0, 4)
  }

  @Test("langmap_mark")
  func u387_langmap_mark() {
    let t = UpstreamVim()

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: nil)
    t.setCursor(2, 2)
    t.doKeys("m", "'")
    t.setCursor(0, 0)
    t.doKeys("`", "'")
    t.assertCursorAt(2, 2)
    t.setCursor(2, 0)
    t.replaceRange("   h", t.cursor)
    t.setCursor(0, 0)
    t.doKeys("-", "'")
    t.assertCursorAt(2, 3)
  }

  @Test("langmap_visual_block")
  func u388_langmap_visual_block() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: nil)
    t.setCursor(0, 1)
    t.doKeys("<C-k>", "2", "h", "n", "n", "n", "j")
    t.doKeys("hello")
    #expect("1hello\n5hello\nahellofg" == t.value)
    t.doKeys("<Esc>")
    t.setCursor(2, 3)
    t.doKeys("<C-k>", "2", "t", "d", "J")
    t.doKeys("world")
    #expect("1hworld\n5hworld\nahworld" == t.value)
  }

  @Test("langmap_visual_block_no_ctrl_remap")
  func u389_langmap_visual_block_no_ctrl_remap() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.vim.setLangmap(upstreamDvorakLangmap, remapCtrl: false)
    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "h", "n", "n", "n", "j")
    t.doKeys("hello")
    #expect("1hello\n5hello\nahellofg" == t.value)
    t.doKeys("<Esc>")
    t.setCursor(2, 3)
    t.doKeys("<C-v>", "2", "t", "d", "J")
    t.doKeys("world")
    #expect("1hworld\n5hworld\nahworld" == t.value)
  }
}
