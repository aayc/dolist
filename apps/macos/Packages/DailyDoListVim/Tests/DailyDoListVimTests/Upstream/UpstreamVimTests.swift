// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `testVim` cases translated statement by statement from the upstream source. Tests whose
// behavior depends on a language mode, soft wrapping or CodeMirror 5 metrics aren't ported;
// these translated ones are left out:
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
  @Test("qq@q")
  func u000_qq_q() {
    let t = UpstreamVim(value: "            ")

    t.setCursor(0, 0)
    t.doKeys("q", "q", "l", "l", "q")
    t.assertCursorAt(0, 2)
    t.doKeys("@", "q")
    t.assertCursorAt(0, 4)
  }

  @Test("@@")
  func u001_x() {
    let t = UpstreamVim(value: "            ")

    t.setCursor(0, 0)
    t.doKeys("q", "q", "l", "l", "q")
    t.assertCursorAt(0, 2)
    t.doKeys("@", "q")
    t.assertCursorAt(0, 4)
    t.doKeys("@", "@")
    t.assertCursorAt(0, 6)
  }

  @Test("Changing lines after Eol operation")
  func u005_Changing_lines_after_Eol_operation() {
    let t = UpstreamVim()

    t.setCursor(0, 0)
    t.doKeys("$")
    t.doKeys("j")
    t.assertCursorAt(VimPosition(1, 8 - 1))
    t.doKeys("j")
    t.assertCursorAt(VimPosition(2, 19 - 1))
    t.doKeys("h")
    t.doKeys("j")
    t.assertCursorAt(VimPosition(3, 13 - 1))
    t.doKeys("j")
    t.doKeys("j")
    t.assertCursorAt(VimPosition(5, 19 - 2))
  }

  @Test("gj_gk_clipping")
  func u006_gj_gk_clipping() {
    let t = UpstreamVim(value: "line 1\n\nline 2")

    t.setCursor(0, 1)
    t.doKeys("g", "j", "g", "j")
    t.assertCursorAt(2, 1)
    t.doKeys("g", "j")
    t.assertCursorAt(2, 1)
    t.doKeys("g", "k", "g", "k")
    t.assertCursorAt(0, 1)
    t.doKeys("9", "g", "j")
    t.assertCursorAt(2, 1)
  }

  @Test("}")
  func u007_x() {
    let t = UpstreamVim(value: "a\n\nb\nc\n\nd")

    t.setCursor(0, 0)
    t.doKeys("}")
    t.assertCursorAt(1, 0)
    t.setCursor(0, 0)
    t.doKeys("2", "}")
    t.assertCursorAt(4, 0)
    t.setCursor(0, 0)
    t.doKeys("6", "}")
    t.assertCursorAt(5, 0)
  }

  @Test("{")
  func u008_x() {
    let t = UpstreamVim(value: "a\n\nb\nc\n\nd")

    t.setCursor(5, 0)
    t.doKeys("{")
    t.assertCursorAt(4, 0)
    t.setCursor(5, 0)
    t.doKeys("2", "{")
    t.assertCursorAt(1, 0)
    t.setCursor(5, 0)
    t.doKeys("6", "{")
    t.assertCursorAt(0, 0)
  }

  @Test("(")
  func u009_x() {
    let t = UpstreamVim(value: "sentence1.\n\n\nsentence2\n\nsentence3. sentence4\n   sentence5? sentence6!")

    t.setCursor(6, 23)
    t.doKeys("(")
    t.assertCursorAt(6, 14)
    t.doKeys("2", "(")
    t.assertCursorAt(5, 0)
    t.doKeys("(")
    t.assertCursorAt(4, 0)
    t.doKeys("(")
    t.assertCursorAt(3, 0)
    t.doKeys("(")
    t.assertCursorAt(2, 0)
    t.doKeys("(")
    t.assertCursorAt(0, 0)
    t.doKeys("(")
    t.assertCursorAt(0, 0)
  }

  @Test(")")
  func u010_x() {
    let t = UpstreamVim(value: "sentence1.\n\n\nsentence2\n\nsentence3. sentence4\n   sentence5? sentence6!")

    t.setCursor(0, 0)
    t.doKeys("2", ")")
    t.assertCursorAt(3, 0)
    t.doKeys(")")
    t.assertCursorAt(4, 0)
    t.doKeys(")")
    t.assertCursorAt(5, 0)
    t.doKeys(")")
    t.assertCursorAt(5, 11)
    t.doKeys(")")
    t.assertCursorAt(6, 14)
    t.doKeys(")")
    t.assertCursorAt(6, 23)
    t.doKeys(")")
    t.assertCursorAt(6, 23)
  }

  @Test("paragraph_motions")
  func u011_paragraph_motions() {
    let t = UpstreamVim(value: "a\na\n\n\n\nb\nc\n\n\n\n\n\n\nd\n\ne\nf")

    t.setCursor(10, 0)
    t.doKeys("{")
    t.assertCursorAt(4, 0)
    t.doKeys("{")
    t.assertCursorAt(0, 0)
    t.doKeys("2", "}")
    t.assertCursorAt(7, 0)
    t.doKeys("2", "}")
    t.assertCursorAt(16, 0)
    t.setCursor(9, 0)
    t.doKeys("}")
    t.assertCursorAt(14, 0)
    t.setCursor(6, 0)
    t.doKeys("}")
    t.assertCursorAt(7, 0)
    t.setCursor(10, 0)
    t.doKeys("v", "i", "p")
    #expect(VimPosition(7, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(12, 0) == t.cm.getCursor(.head))
    t.doKeys("i", "p")
    #expect(VimPosition(7, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(13, 1) == t.cm.getCursor(.head))
    t.doKeys("2", "i", "p")
    #expect(VimPosition(7, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(16, 1) == t.cm.getCursor(.head))
    t.setCursor(14, 0)
    t.doKeys("<Esc>", "v", "i", "p")
    t.assertCursorAt(14, 0)
    t.setCursor(14, 0)
    t.doKeys("<Esc>", "V", "i", "p")
    #expect(VimPosition(16, 1) == t.cm.getCursor(.head))
    t.setCursor(10, 0)
    t.doKeys("<Esc>", "v", "a", "p")
    #expect(VimPosition(7, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(13, 1) == t.cm.getCursor(.head))
    t.doKeys("a", "p")
    #expect(VimPosition(7, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(16, 1) == t.cm.getCursor(.head))
    t.setCursor(13, 0)
    t.doKeys("v", "a", "p")
    #expect(VimPosition(13, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(14, 0) == t.cm.getCursor(.head))
    t.setCursor(16, 0)
    t.doKeys("v", "a", "p")
    #expect(VimPosition(14, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(16, 1) == t.cm.getCursor(.head))
    t.setCursor(0, 0)
    t.doKeys("v", "a", "p")
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(4, 0) == t.cm.getCursor(.head))
    t.setCursor(0, 0)
    t.doKeys("d", "i", "p")
    let register = t.registerController.getRegister(nil)
    #expect("a\na\n" == register.text.string)
    #expect(register.linewise)
    t.doKeys("3", "j", "p")
    t.doKeys("y", "i", "p")
    #expect(register.linewise)
    #expect("b\na\na\nc\n" == register.text.string)
  }

  @Test("sentence_selections")
  func u012_sentence_selections() {
    let t = UpstreamVim(value: "Test sentence. Test question?\nAgain.Never. Again.Test.\n\nHello. This is more text. No end of sentence symbol\n")

    // vis at beginning of line
    t.setCursor(0, 0)
    t.doKeys("v", "i", "s")
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(0, 14) == t.cm.getCursor(.head))
    t.setCursor(0, 0)
    t.doKeys("v", "a", "s")
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(0, 15) == t.cm.getCursor(.head))
    t.setCursor(0, 13)
    t.doKeys("v", "i", "s")
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(0, 14) == t.cm.getCursor(.head))
    t.setCursor(0, 13)
    t.doKeys("v", "a", "s")
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    #expect(VimPosition(0, 15) == t.cm.getCursor(.head))
    t.setCursor(1, 18)
    t.doKeys("v", "i", "s")
    #expect(VimPosition(1, 13) == t.cm.getCursor(.anchor))
    #expect(VimPosition(1, 19) == t.cm.getCursor(.head))
    t.setCursor(1, 18)
    t.doKeys("v", "a", "s")
    #expect(VimPosition(1, 12) == t.cm.getCursor(.anchor))
    #expect(VimPosition(1, 19) == t.cm.getCursor(.head))
    t.setCursor(0, 14)
    t.doKeys("v", "i", "s")
    #expect(VimPosition(0, 14) == t.cm.getCursor(.anchor))
    #expect(VimPosition(0, 29) == t.cm.getCursor(.head))
    t.setCursor(0, 0)
    t.doKeys("d", "i", "s")
    var register = t.registerController.getRegister(nil)
    #expect("Test sentence." == register.text.string)
    t.doKeys("u")

    t.setCursor(0, 0)
    t.doKeys("d", "a", "s")
    register = t.registerController.getRegister(nil)
    #expect("Test sentence. " == register.text.string)
    t.doKeys("u")

    t.setCursor(1, 20)
    t.doKeys("c", "a", "s", "<Esc>")
    register = t.registerController.getRegister(nil)
    #expect("Test." == register.text.string)
    t.doKeys("u")

    t.setCursor(3, 11)
    t.doKeys("y", "a", "s")
    register = t.registerController.getRegister(nil)
    #expect("This is more text. " == register.text.string)
    t.setCursor(3, 31)
    t.doKeys("y", "a", "s")
    register = t.registerController.getRegister(nil)
    #expect(" No end of sentence symbol" == register.text.string)
  }

  @Test("w_text_object_repeat")
  func u013_w_text_object_repeat() {
    let t = UpstreamVim(value: " w1  ++  w_2   \n w3   xx \n\nw4\nword5\nword6")

    t.setCursor(0, 2)
    t.doKeys("v", "3", "a", "w")
    #expect(("w1  ++  w_2   ") == t.selection)
    t.doKeys("<Esc>", "v", "a", "w")
    #expect("   \n w3" == t.selection)
    t.doKeys("2", "a", "w")
    #expect("   \n w3   xx \n" == t.selection)
    t.doKeys("a", "w")
    #expect("   \n w3   xx \n\nw4" == t.selection)
    t.setValue("  w0 word1  word2  word3    word4")
    t.setCursor(0, 8)
    t.doKeys("c", "3", "a", "w")
    #expect("  w0 word4" == t.value)
  }

  @Test("dl")
  func u014_dl() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 0)
    t.setCursor(curStart)
    t.doKeys("d", "l")
    #expect("word1 " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" " == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("dl_eol")
  func u015_dl_eol() {
    let t = UpstreamVim(value: " word1 ")

    t.setCursor(0, 6)
    t.doKeys("d", "l")
    #expect(" word1" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" " == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 5)
  }

  @Test("dl_repeat")
  func u016_dl_repeat() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 0)
    t.setCursor(curStart)
    t.doKeys("2", "d", "l")
    #expect("ord1 " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" w" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("dh")
  func u017_dh() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("d", "h")
    #expect(" wrd1 " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("o" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart.offsetting(0 , -1) == t.cursor)
  }

  @Test("dj")
  func u018_dj() {
    let t = UpstreamVim(value: " word1\nword2\n word3")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("d", "j")
    #expect(" word3" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" word1\nword2\n" == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("dj_end_of_document")
  func u019_dj_end_of_document() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("d", "j")
    #expect("" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" word1 \n" == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dk")
  func u020_dk() {
    let t = UpstreamVim(value: " word1\nword2\n word3")

    let curStart = VimPosition(1, 3)
    t.setCursor(curStart)
    t.doKeys("d", "k")
    #expect(" word3" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" word1\nword2\n" == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("dk_start_of_document")
  func u021_dk_start_of_document() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("d", "k")
    #expect("" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" word1 \n" == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dw_space")
  func u022_dw_space() {
    let t = UpstreamVim(value: " word1 ")

    let curStart = VimPosition(0, 0)
    t.setCursor(curStart)
    t.doKeys("d", "w")
    #expect("word1 " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" " == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("dw_word")
  func u023_dw_word() {
    let t = UpstreamVim(value: " word1 word2")

    let curStart = VimPosition(0, 1)
    t.setCursor(curStart)
    t.doKeys("d", "w")
    #expect(" word2" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1 " == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("dw_unicode_word")
  func u024_dw_unicode_word() {
    let t = UpstreamVim(value: "  բարև»eµg  ")

    t.doKeys("d", "w")
    #expect(t.value.utf16.count == 10)
    t.doKeys("d", "w")
    #expect(t.value.utf16.count == 6)
    t.doKeys("d", "w")
    #expect(t.value.utf16.count == 5)
    t.doKeys("d", "e")
    #expect(t.value.utf16.count == 2)
  }

  @Test("dw_only_word")
  func u025_dw_only_word() {
    let t = UpstreamVim(value: " word1 ")

    // Test that if there is only 1 word left, dw deletes till the end of the
    // line.
    t.setCursor(0, 1)
    t.doKeys("d", "w")
    #expect(" " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1 " == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dw_eol")
  func u026_dw_eol() {
    let t = UpstreamVim(value: " word1\nword2")

    // Assert that dw does not delete the newline if last word to delete is at end
    // of line.
    t.setCursor(0, 1)
    t.doKeys("d", "w")
    #expect(" \nword2" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dw_eol_with_multiple_newlines")
  func u027_dw_eol_with_multiple_newlines() {
    let t = UpstreamVim(value: " word1\n\nword2")

    // Assert that dw does not delete the newline if last word to delete is at end
    // of line and it is followed by multiple newlines.
    t.setCursor(0, 1)
    t.doKeys("d", "w")
    #expect(" \n\nword2" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dw_empty_line_followed_by_whitespace")
  func u028_dw_empty_line_followed_by_whitespace() {
    let t = UpstreamVim(value: "\n  \nword")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("  \nword" == t.value)
  }

  @Test("dw_empty_line_followed_by_word")
  func u029_dw_empty_line_followed_by_word() {
    let t = UpstreamVim(value: "\nword")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("word" == t.value)
  }

  @Test("dw_empty_line_followed_by_empty_line")
  func u030_dw_empty_line_followed_by_empty_line() {
    let t = UpstreamVim(value: "\n\n")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("\n" == t.value)
  }

  @Test("dw_whitespace_followed_by_whitespace")
  func u031_dw_whitespace_followed_by_whitespace() {
    let t = UpstreamVim(value: "  \n   \n")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("\n   \n" == t.value)
  }

  @Test("dw_whitespace_followed_by_empty_line")
  func u032_dw_whitespace_followed_by_empty_line() {
    let t = UpstreamVim(value: "  \n\n")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("\n\n" == t.value)
  }

  @Test("dw_word_whitespace_word")
  func u033_dw_word_whitespace_word() {
    let t = UpstreamVim(value: "word1\n   \nword2")

    t.setCursor(0, 0)
    t.doKeys("d", "w")
    #expect("\n   \nword2" == t.value)
  }

  @Test("dw_end_of_document")
  func u034_dw_end_of_document() {
    let t = UpstreamVim(value: "\nabc")

    t.setCursor(1, 2)
    t.doKeys("d", "w")
    #expect("\nab" == t.value)
  }

  @Test("dw_repeat")
  func u035_dw_repeat() {
    let t = UpstreamVim(value: " word1\nword2")

    // Assert that dw does delete newline if it should go to the next line, and
    // that repeat works properly.
    t.setCursor(0, 1)
    t.doKeys("d", "2", "w")
    #expect(" " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1\nword2" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("de_word_start_and_empty_lines")
  func u036_de_word_start_and_empty_lines() {
    let t = UpstreamVim(value: "word\n\n")

    t.setCursor(0, 0)
    t.doKeys("d", "e")
    #expect("\n\n" == t.value)
  }

  @Test("de_word_end_and_empty_lines")
  func u037_de_word_end_and_empty_lines() {
    let t = UpstreamVim(value: "word\n\n\n")

    t.setCursor(0, 3)
    t.doKeys("d", "e")
    #expect("wor" == t.value)
  }

  @Test("de_whitespace_and_empty_lines")
  func u038_de_whitespace_and_empty_lines() {
    let t = UpstreamVim(value: "   \n\n\n")

    t.setCursor(0, 0)
    t.doKeys("d", "e")
    #expect("" == t.value)
  }

  @Test("de_end_of_document")
  func u039_de_end_of_document() {
    let t = UpstreamVim(value: "\nabc")

    t.setCursor(1, 2)
    t.doKeys("d", "e")
    #expect("\nab" == t.value)
  }

  @Test("db_empty_lines")
  func u040_db_empty_lines() {
    let t = UpstreamVim(value: "\n\n\n")

    t.setCursor(2, 0)
    t.doKeys("d", "b")
    #expect("\n\n" == t.value)
  }

  @Test("db_word_start_and_empty_lines")
  func u041_db_word_start_and_empty_lines() {
    let t = UpstreamVim(value: "\n\nword")

    t.setCursor(2, 0)
    t.doKeys("d", "b")
    #expect("\nword" == t.value)
  }

  @Test("db_word_end_and_empty_lines")
  func u042_db_word_end_and_empty_lines() {
    let t = UpstreamVim(value: "\n\nword")

    t.setCursor(2, 3)
    t.doKeys("d", "b")
    #expect("\n\nd" == t.value)
  }

  @Test("db_whitespace_and_empty_lines")
  func u043_db_whitespace_and_empty_lines() {
    let t = UpstreamVim(value: "\n   \n")

    t.setCursor(2, 0)
    t.doKeys("d", "b")
    #expect("" == t.value)
  }

  @Test("db_start_of_document")
  func u044_db_start_of_document() {
    let t = UpstreamVim(value: "abc\n")

    t.setCursor(0, 0)
    t.doKeys("d", "b")
    #expect("abc\n" == t.value)
  }

  @Test("dge_empty_lines")
  func u045_dge_empty_lines() {
    let t = UpstreamVim(value: "\n\n")

    t.setCursor(1, 0)
    t.doKeys("d", "g", "e")
    #expect("\n" == t.value)
  }

  @Test("dge_word_and_empty_lines")
  func u046_dge_word_and_empty_lines() {
    let t = UpstreamVim(value: "word\n\n")

    t.setCursor(1, 0)
    t.doKeys("d", "g", "e")
    #expect("wor\n" == t.value)
  }

  @Test("dge_whitespace_and_empty_lines")
  func u047_dge_whitespace_and_empty_lines() {
    let t = UpstreamVim(value: "\n  \n")

    t.setCursor(2, 0)
    t.doKeys("d", "g", "e")
    #expect("" == t.value)
  }

  @Test("dge_start_of_document")
  func u048_dge_start_of_document() {
    let t = UpstreamVim(value: "abc\n")

    t.setCursor(0, 0)
    t.doKeys("d", "g", "e")
    #expect("bc\n" == t.value)
  }

  @Test("d_inclusive")
  func u049_d_inclusive() {
    let t = UpstreamVim(value: " word1 ")

    // Assert that when inclusive is set, the character the cursor is on gets
    // deleted too.
    let curStart = VimPosition(0, 1)
    t.setCursor(curStart)
    t.doKeys("d", "e")
    #expect("  " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("d_reverse")
  func u050_d_reverse() {
    let t = UpstreamVim(value: " word1\nword2 ")

    // Test that deleting in reverse works.
    t.setCursor(1, 0)
    t.doKeys("d", "b")
    #expect(" word2 " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1\n" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("dd")
  func u051_dd() {
    let t = UpstreamVim()

    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(1, 0))
    let expectedLineCount = t.lineCount - 1
    t.doKeys("d", "d")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("dd_prefix_repeat")
  func u052_dd_prefix_repeat() {
    let t = UpstreamVim()

    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(2, 0))
    let expectedLineCount = t.lineCount - 2
    t.doKeys("2", "d", "d")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dd_motion_repeat")
  func u053_dd_motion_repeat() {
    let t = UpstreamVim()

    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(2, 0))
    let expectedLineCount = t.lineCount - 2
    t.doKeys("d", "2", "d")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 0)
  }

  @Test("dd_multiply_repeat")
  func u054_dd_multiply_repeat() {
    let t = UpstreamVim()

    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(6, 0))
    let expectedLineCount = t.lineCount - 6
    t.doKeys("2", "d", "3", "d")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 2)
  }

  @Test("dd_lastline")
  func u055_dd_lastline() {
    let t = UpstreamVim()

    t.setCursor(t.lineCount, 0)
    let expectedLineCount = t.lineCount - 1
    t.doKeys("d", "d")
    #expect(expectedLineCount == t.lineCount)
    t.assertCursorAt(t.lineCount - 1, 0)
  }

  @Test("dd_only_line")
  func u056_dd_only_line() {
    let t = UpstreamVim(value: "thisistheonlyline")

    t.setCursor(0, 0)
    let expectedRegister = t.value + "\n"
    t.doKeys("d", "d")
    #expect(1 == t.lineCount)
    #expect("" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(expectedRegister == register.text.string)
  }

  @Test("cG")
  func u057_cG() {
    let t = UpstreamVim(value: "line1\nline2\n")

    t.setCursor(0, 0)
    t.doKeys("c", "G", "inserted")
    #expect("inserted" == t.value)
    t.assertCursorAt(0, 8)
    t.setValue("    indented\nlines")
    t.doKeys("<Esc>", "c", "G", "inserted")
    #expect("    inserted" == t.value)
  }

  @Test("yw_repeat")
  func u058_yw_repeat() {
    let t = UpstreamVim(value: " word1\nword2")

    // Assert that yw does yank newline if it should go to the next line, and
    // that repeat works properly.
    let curStart = VimPosition(0, 1)
    t.setCursor(curStart)
    t.doKeys("y", "2", "w")
    #expect(" word1\nword2" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1\nword2" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("yy_multiply_repeat")
  func u059_yy_multiply_repeat() {
    let t = UpstreamVim()

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(6, 0))
    let expectedLineCount = t.lineCount
    t.doKeys("2", "y", "3", "y")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("2dd_blank_P")
  func u060_2dd_blank_P() {
    let t = UpstreamVim(value: "\na\n\n")

    t.doKeys("2", "d", "d", "P")
    #expect("\na\n\n" == t.value)
  }

  @Test("cw")
  func u061_cw() {
    let t = UpstreamVim(value: "word1 word2 word3")

    t.setCursor(0, 0)
    t.doKeys("c", "2", "w")
    #expect(" word3" == t.value)
    t.assertCursorAt(0, 0)
  }

  @Test("cw_repeat")
  func u062_cw_repeat() {
    let t = UpstreamVim(value: " word1\nword2")

    // Assert that cw does delete newline if it should go to the next line, and
    // that repeat works properly.
    let curStart = VimPosition(0, 1)
    t.setCursor(curStart)
    t.doKeys("c", "2", "w")
    #expect(" " == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word1\nword2" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("cc_multiply_repeat")
  func u063_cc_multiply_repeat() {
    let t = UpstreamVim()

    t.setCursor(0, 3)
    let expectedBuffer = t.getRange(VimPosition(0, 0), VimPosition(6, 0))
    let expectedLineCount = t.lineCount - 5
    t.doKeys("2", "c", "3", "c")
    #expect(expectedLineCount == t.lineCount)
    let register = t.registerController.getRegister(nil)
    #expect(expectedBuffer == register.text.string)
    #expect(register.linewise)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("ct")
  func u064_ct() {
    let t = UpstreamVim(value: "  word1  word2  word3")

    t.setCursor(0, 9)
    t.doKeys("c", "t", "w")
    #expect("  word1  word3" == t.value)
    t.doKeys("<Esc>", "c", "|")
    #expect(" word3" == t.value)
    t.assertCursorAt(0, 0)
    t.doKeys("<Esc>", "2", "u", "w", "h")
    t.doKeys("c", "2", "g", "e")
    #expect("  wordword3" == t.value)
  }

  @Test("cc_should_not_append_to_document")
  func u065_cc_should_not_append_to_document() {
    let t = UpstreamVim()

    let expectedLineCount = t.lineCount
    t.setCursor((t.lineCount - 1), 0)
    t.doKeys("c", "c")
    #expect(expectedLineCount == t.lineCount)
  }

  @Test("c_visual_block")
  func u066_c_visual_block() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "j", "l", "l", "l", "c")
    t.doKeys("hello")
    #expect("1hello\n5hello\nahellofg" == t.value)
    t.doKeys("<Esc>")
    t.setCursor(2, 3)
    t.doKeys("<C-v>", "2", "k", "h", "C")
    t.doKeys("world")
    #expect("1hworld\n5hworld\nahworld" == t.value)
  }

  @Test("c_visual_block_replay")
  func u067_c_visual_block_replay() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "j", "l", "c")
    t.doKeys("fo")
    #expect("1fo4\n5fo8\nafodefg" == t.value)
    t.doKeys("<Esc>")
    t.setCursor(0, 0)
    t.doKeys(".")
    #expect("foo4\nfoo8\nfoodefg" == t.value)
  }

  @Test("I_visual_block_replay")
  func u068_I_visual_block_replay() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg\nxyz")

    t.setCursor(0, 2)
    t.doKeys("<C-v>", "2", "j", "l", "I")
    t.doKeys("+-")
    #expect(("12+-34\n56+-78\nab+-cdefg\nxyz") == t.value)
    t.doKeys("<Esc>")
    t.setCursor(3, 2)
    t.doKeys("g", "v")
    #expect(("+-34\n+-78\n+-cd") == t.selection)
    t.setCursor(0, 3)
    t.doKeys("<C-v>", "1", "j", "2", "l")
    #expect("-34\n-78" == t.selection)
    t.setCursor(0, 0)
    #expect("" == t.selection)
    t.doKeys("g", "v")
    #expect("-34\n-78" == t.selection)
    t.setCursor(1, 1)
    t.doKeys(".")
    #expect(("12+-34\n5+-6+-78\na+-b+-cdefg\nx+-yz") == t.value)
  }

  @Test("visual_block_backwards")
  func u069_visual_block_backwards() {
    let t = UpstreamVim(value: "01234 line 1\n56789 line 2\nabcdefg line 3\nline 4")

    t.setCursor(0, 0)
    t.doKeys("3", "l")
    t.doKeys("<C-v>", "2", "j", "2", "<Left>")
    #expect("123\n678\nbcd" == t.selection)
    t.doKeys("A")
    t.assertCursorAt(0, 4)
    t.doKeys("A", "<Esc>")
    t.assertCursorAt(0, 4)
    t.doKeys("g", "v")
    #expect("123\n678\nbcd" == t.selection)
    t.doKeys("x")
    t.assertCursorAt(0, 1)
    t.doKeys("g", "v")
    #expect("A4 \nA9 \nAef" == t.selection)
  }

  @Test("d_visual_block")
  func u070_d_visual_block() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "j", "l", "l", "l", "d")
    #expect("1\n5\nafg" == t.value)
  }

  @Test("D_visual_block")
  func u071_D_visual_block() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "j", "l", "D")
    #expect("1\n5\na" == t.value)
  }

  @Test("g~w_repeat")
  func u073_g_w_repeat() {
    let t = UpstreamVim(value: " word1\nword2")

    // Assert that dw does delete newline if it should go to the next line, and
    // that repeat works properly.
    let curStart = VimPosition(0, 1)
    t.setCursor(curStart)
    t.doKeys("g", "~", "2", "w")
    #expect(" WORD1\nWORD2" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("g~g~")
  func u074_g_g() {
    let t = UpstreamVim(value: " word1\nword2\nword3\nword4\nword5\nword6")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    _ = t.lineCount
    let expectedValue = t.value.uppercased()
    t.doKeys("2", "g", "~", "3", "g", "~")
    #expect(expectedValue == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
  }

  @Test("gu_and_gU")
  func u075_gu_and_gU() {
    let t = UpstreamVim(value: "wa wb xx wc wd")

    let curStart = VimPosition(0, 7)
    let value = t.value
    t.setCursor(curStart)
    t.doKeys("2", "g", "U", "w")
    #expect(t.value == "wa wb xX WC wd")
    #expect(curStart == t.cursor)
    t.doKeys("2", "g", "u", "w")
    #expect(t.value == value)
    t.doKeys("2", "g", "U", "B")
    #expect(t.value == "wa WB Xx wc wd")
    #expect(VimPosition(0, 3) == t.cursor)
    t.setCursor(VimPosition(0, 4))
    t.doKeys("g", "u", "i", "w")
    #expect(t.value == "wa wb Xx wc wd")
    #expect(VimPosition(0, 3) == t.cursor)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.setCursor(curStart)
    t.setValue("abc efg\nxyz")
    t.doKeys("g", "U", "g", "U")
    #expect(t.value == "ABC EFG\nxyz")
    t.doKeys("g", "u", "u")
    #expect(t.value == "abc efg\nxyz")
    #expect(VimPosition(0, 0) == t.cursor)
    t.doKeys("g", "U", "2", "U")
    #expect(t.value == "ABC EFG\nXYZ")
  }

  @Test("g?")
  func u076_g() {
    let t = UpstreamVim(value: "wa wb xx wc wd")

    let curStart = VimPosition(0, 7)
    let value = t.value
    t.setCursor(curStart)
    t.doKeys("2", "g", "?", "w")
    #expect(t.value == "wa wb xk jp wd")
    #expect(curStart == t.cursor)
    t.doKeys("2", "g", "?", "w")
    #expect(t.value == value)
    t.doKeys("2", "g", "?", "B")
    #expect(t.value == "wa jo kx wc wd")
    #expect(VimPosition(0, 3) == t.cursor)
    t.setCursor(VimPosition(0, 4))
    t.doKeys("g", "?", "i", "w")
    #expect(t.value == "wa wb kx wc wd")
    #expect(VimPosition(0, 3) == t.cursor)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.setCursor(curStart)
    t.setValue("abc efg();\nxyz")
    t.doKeys("g", "?", "g", "?")
    #expect(t.value == ("nop rst();\nxyz"))
    t.doKeys("g", "?", "?")
    #expect(t.value == ("abc efg();\nxyz"))
    #expect(VimPosition(0, 0) == t.cursor)
    t.doKeys("g", "?", "2", "?")
    #expect(t.value == ("nop rst();\nklm"))
    t.setCursor(curStart)
    t.setValue("hello\nworld")
    t.doKeys("l", "<C-v>", "l", "j", "g", "?")
    #expect(t.value == "hrylo\nwbeld")
  }

  @Test("visual_block_~")
  func u077_visual_block() {
    let t = UpstreamVim(value: "hello\nwOrld\nabcde")

    t.setCursor(1, 1)
    t.doKeys("<C-v>", "l", "l", "j", "~")
    t.assertCursorAt(1, 1)
    #expect("hello\nwoRLd\naBCDe" == t.value)
    t.setCursor(2, 0)
    t.doKeys("v", "l", "l", "~")
    t.assertCursorAt(2, 0)
    #expect("hello\nwoRLd\nAbcDe" == t.value)
  }

  @Test("._swapCase_visualBlock")
  func u078_swapCase_visualBlock() {
    let t = UpstreamVim(value: "hEllo\nwOrlD\naBcDe")

    t.doKeys("<C-v>", "j", "j", "l", "~")
    t.setCursor(0, 3)
    t.doKeys(".")
    #expect("HelLO\nWorLd\nAbcdE" == t.value)
  }

  @Test(">{motion}")
  func u079_motion() {
    let t = UpstreamVim(value: " word1\nword2\nword3 ", indentUnit: 2)

    t.setCursor(1, 3)
    _ = t.lineCount
    let expectedValue = "   word1\n  word2\nword3 "
    t.doKeys(">", "k")
    #expect(expectedValue == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 3)
  }

  @Test(">>")
  func u080_x() {
    let t = UpstreamVim(value: " word1\nword2\nword3 ", indentUnit: 2)

    t.setCursor(0, 3)
    _ = t.lineCount
    let expectedValue = "   word1\n  word2\nword3 "
    t.doKeys("2", ">", ">")
    #expect(expectedValue == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 3)
  }

  @Test("<{motion}")
  func u081_motion() {
    let t = UpstreamVim(value: "   word1\n  word2\nword3 ", indentUnit: 2)

    t.setCursor(1, 3)
    _ = t.lineCount
    let expectedValue = " word1\nword2\nword3 "
    t.doKeys("<", "k")
    #expect(expectedValue == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("<<")
  func u082_x() {
    let t = UpstreamVim(value: "   word1\n  word2\nword3 ", indentUnit: 2)

    t.setCursor(0, 3)
    _ = t.lineCount
    let expectedValue = " word1\nword2\nword3 "
    t.doKeys("2", "<", "<")
    #expect(expectedValue == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 1)
  }

  @Test("><visualblock")
  func u084_visualblock() {
    let t = UpstreamVim(value: "  word1\n  word2\n  word3", indentUnit: 2)

    t.setCursor(0, 6)
    t.doKeys("<C-v>", "j", "j")
    t.doKeys("4", ">")
    #expect("  word        1\n  word        2\n  word        3" == t.value)
    t.doKeys("g", "v", "14", "<")
    #expect("  word1\n  word2\n  word3" == t.value)
  }

  @Test("D")
  func u086_D() {
    let t = UpstreamVim(value: " word1\nword2\n word3")

    t.setCursor(0, 3)
    t.doKeys("D")
    #expect(" wo\nword2\n word3" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("rd1" == register.text.string)
    #expect(!register.linewise)
    t.assertCursorAt(0, 2)
  }

  @Test("C")
  func u087_C() {
    let t = UpstreamVim(value: " word1\nword2\n word3")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("C")
    #expect(" wo\nword2\n word3" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("rd1" == register.text.string)
    #expect(!register.linewise)
    #expect(curStart == t.cursor)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("Y")
  func u088_Y() {
    let t = UpstreamVim(value: " word1\nword2\n word3")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("Y")
    #expect(" word1\nword2\n word3" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(" word1\n" == register.text.string)
    #expect(register.linewise)
    t.assertCursorAt(0, 3)
  }

  @Test("Yy_blockwise")
  func u089_Yy_blockwise() {
    let t = UpstreamVim(value: "123456\n123456\n")

    t.doKeys("<C-v>", "j", "2", "l", "Y")
    t.doKeys("G", "p", "g", "g")
    t.doKeys("<C-v>", "j", "2", "l", "y")
    t.assertCursorAt(0, 0)
    t.doKeys("$", "p")
    #expect("123456123\n123456123\n123456\n123456" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("123\n123" == register.text.string)
    #expect(register.blockwise)
    t.assertCursorAt(0, 6)
    t.doKeys("$", "j", "p")
    t.doKeys("$", "j", "P")
    #expect("123456123\n123456123123\n123456   121233\n123456     123" == t.value)
  }

  @Test("~")
  func u090_x() {
    let t = UpstreamVim(value: "abcdefg")

    t.doKeys("3", "~")
    #expect("ABCdefg" == t.value)
    t.assertCursorAt(0, 3)
  }

  @Test("ctrl-a")
  func u091_ctrl_a() {
    let t = UpstreamVim(value: "-10")

    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("-9" == t.value)
    t.assertCursorAt(0, 1)
    t.doKeys("2", "<C-a>")
    #expect("-7" == t.value)
  }

  @Test("ctrl-x")
  func u092_ctrl_x() {
    let t = UpstreamVim(value: "0")

    t.setCursor(0, 0)
    t.doKeys("<C-x>")
    #expect("-1" == t.value)
    t.assertCursorAt(0, 1)
    t.doKeys("2", "<C-x>")
    #expect("-3" == t.value)
  }

  @Test("insert_ctrl_o")
  func u093_insert_ctrl_o() {
    let t = UpstreamVim(value: "one two three here")

    t.doKeys("i")
    #expect(t.state.insertMode)
    t.doKeys("<C-o>")
    #expect(!t.state.insertMode)
    t.doKeys("3", "w")
    #expect(t.state.insertMode)
    #expect(VimPosition(0, 14) == t.cursor)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("insert_ctrl_u")
  func u094_insert_ctrl_u() {
    let t = UpstreamVim(value: "word1/word2")

    let curStart = VimPosition(0, 10)
    t.setCursor(curStart)
    t.doKeys("a")
    t.doKeys("<C-u>")
    #expect("" == t.value)
    let register = t.registerController.getRegister(nil)
    #expect(("word1/word2") == register.text.string)
    #expect(!register.linewise)
    let curEnd = VimPosition(0, 0)
    #expect(curEnd == t.cursor)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("insert_ctrl_w")
  func u095_insert_ctrl_w() {
    let t = UpstreamVim(value: "word1/word2")

    let curStart = VimPosition(0, 10)
    t.setCursor(curStart)
    t.doKeys("a")
    t.doKeys("<C-w>")
    #expect(("word1/") == t.value)
    let register = t.registerController.getRegister(nil)
    #expect("word2" == register.text.string)
    #expect(!register.linewise)
    let curEnd = VimPosition(0, 6)
    #expect(curEnd == t.cursor)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("normal_ctrl_w")
  func u096_normal_ctrl_w() {
    let t = UpstreamVim(value: "word")

    let curStart = VimPosition(0, 3)
    t.setCursor(curStart)
    t.doKeys("<C-w>")
    #expect("word" == t.value)
    let curEnd = VimPosition(0, 3)
    t.assertCursorAt(0, 3)
    #expect(curEnd == t.cursor)
    #expect("vim" == t.option("keyMap"))
  }

  @Test("a")
  func u097_a() {
    let t = UpstreamVim()

    t.setCursor(0, 1)
    t.doKeys("a")
    t.assertCursorAt(0, 2)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("a_eol")
  func u098_a_eol() {
    let t = UpstreamVim()

    t.setCursor(0, 10 - 1)
    t.doKeys("a")
    t.assertCursorAt(0, 10)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("a with surrogate characters")
  func u099_a_with_surrogate_characters() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("a")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect(("😀test") == t.value)
  }

  @Test("A_endOfSelectedArea")
  func u100_A_endOfSelectedArea() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("v", "j", "l")
    t.doKeys("A")
    t.assertCursorAt(1, 2)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("i")
  func u101_i() {
    let t = UpstreamVim()

    t.setCursor(0, 1)
    t.doKeys("i")
    t.assertCursorAt(0, 1)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("i with surrogate characters")
  func u102_i_with_surrogate_characters() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("i")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect(("test😀") == t.value)
  }

  @Test("i_repeat")
  func u103_i_repeat() {
    let t = UpstreamVim(value: "")

    t.doKeys("3", "i")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect("testtesttest" == t.value)
    t.assertCursorAt(0, 11)
  }

  @Test("i_repeat_delete")
  func u104_i_repeat_delete() {
    let t = UpstreamVim(value: "abcde")

    t.setCursor(0, 4)
    t.doKeys("2", "i")
    t.doKeys("z")
    t.doKeys("Backspace", "Backspace")
    t.doKeys("<Esc>")
    #expect("abe" == t.value)
    t.assertCursorAt(0, 1)
  }

  @Test("insert")
  func u105_insert() {
    let t = UpstreamVim()

    t.doKeys("i")
    #expect("vim-insert" == t.option("keyMap"))
    #expect(false == t.overwrite)
    t.doKeys("<Ins>")
    #expect("vim-replace" == t.option("keyMap"))
    #expect(true == t.overwrite)
    t.doKeys("<Ins>")
    #expect("vim-insert" == t.option("keyMap"))
    #expect(false == t.overwrite)
  }

  @Test("i_backspace")
  func u106_i_backspace() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 10)
    t.doKeys("i")
    t.doKeys("Backspace")
    t.assertCursorAt(0, 9)
    #expect("012345678" == t.value)
  }

  @Test("i_overwrite_backspace")
  func u107_i_overwrite_backspace() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 10)
    t.doKeys("i")
    t.doKeys("<Ins>")
    t.doKeys("Backspace")
    t.assertCursorAt(VimPosition(0, 9))
    #expect("0123456789" == t.value)
  }

  @Test("i_forward_delete")
  func u108_i_forward_delete() {
    let t = UpstreamVim(value: "A1234\nBCD")

    t.setCursor(0, 3)
    t.doKeys("i")
    t.doKeys("Delete")
    t.assertCursorAt(0, 3)
    #expect("A124\nBCD" == t.value)
    t.doKeys("Delete")
    t.assertCursorAt(0, 3)
    #expect("A12\nBCD" == t.value)
    t.doKeys("Delete")
    t.assertCursorAt(0, 3)
    #expect("A12BCD" == t.value)
  }

  @Test("forward_delete")
  func u109_forward_delete() {
    let t = UpstreamVim(value: "A1234\nBCD")

    t.setCursor(0, 3)
    t.doKeys("<Del>")
    t.assertCursorAt(0, 3)
    #expect("A124\nBCD" == t.value)
    t.doKeys("<Del>")
    t.assertCursorAt(0, 2)
    #expect("A12\nBCD" == t.value)
    t.doKeys("<Del>")
    t.assertCursorAt(0, 1)
    #expect("A1\nBCD" == t.value)
  }

  @Test("A")
  func u110_A() {
    let t = UpstreamVim()

    t.doKeys("A")
    t.assertCursorAt(0, 10)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("A_visual_block")
  func u111_A_visual_block() {
    let t = UpstreamVim(value: "test\nme\nplease")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "2", "j", "l", "l", "A")
    t.doKeys("hello")
    #expect("testhello\nmehello\npleahellose" == t.value)
    t.doKeys("<Esc>")
    t.setCursor(0, 0)
    t.doKeys(".")
  }

  @Test("I")
  func u112_I() {
    let t = UpstreamVim()

    t.setCursor(0, 4)
    t.doKeys("I")
    t.assertCursorAt(0, 1)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("I_repeat")
  func u113_I_repeat() {
    let t = UpstreamVim(value: "blah")

    t.setCursor(0, 1)
    t.doKeys("3", "I")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect("testtesttestblah" == t.value)
    t.assertCursorAt(0, 11)
  }

  @Test("I_visual_block")
  func u114_I_visual_block() {
    let t = UpstreamVim(value: "test\nme\nplease")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "2", "j", "l", "l", "I")
    t.doKeys("hello")
    #expect("hellotest\nhellome\nhelloplease" == t.value)
  }

  @Test("o")
  func u115_o() {
    let t = UpstreamVim(value: "word1\nword2")

    t.setCursor(0, 4)
    t.doKeys("o")
    #expect("word1\n\nword2" == t.value)
    t.assertCursorAt(1, 0)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("o_repeat")
  func u116_o_repeat() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("3", "o")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect("\ntest\ntest\ntest" == t.value)
    t.assertCursorAt(3, 3)
  }

  @Test("O")
  func u117_O() {
    let t = UpstreamVim(value: "word1\nword2")

    t.setCursor(0, 4)
    t.doKeys("O")
    #expect("\nword1\nword2" == t.value)
    t.assertCursorAt(0, 0)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("J")
  func u118_J() {
    let t = UpstreamVim(value: "word1 \n    word2\nword3\n word4")

    t.setCursor(0, 4)
    t.doKeys("J")
    let expectedValue = "word1  word2\nword3\n word4"
    #expect(expectedValue == t.value)
    t.assertCursorAt(0, expectedValue.jsIndexOf("word2") - 1)
  }

  @Test("J_repeat")
  func u119_J_repeat() {
    let t = UpstreamVim(value: "word1 \n    word2\nword3\n word4")

    t.setCursor(0, 4)
    t.doKeys("3", "J")
    let expectedValue = "word1  word2 word3\n word4"
    #expect(expectedValue == t.value)
    t.assertCursorAt(0, expectedValue.jsIndexOf("word3") - 1)
  }

  @Test("gJ")
  func u120_gJ() {
    let t = UpstreamVim(value: "word1\nword2 \n word3")

    t.setCursor(0, 4)
    t.doKeys("g", "J")
    #expect("word1word2 \n word3" == t.value)
    t.assertCursorAt(0, 5)
    t.doKeys("g", "J")
    #expect("word1word2  word3" == t.value)
    t.assertCursorAt(0, 11)
  }

  @Test("gi")
  func u121_gi() {
    let t = UpstreamVim(value: "12\n  xxxx")

    t.setCursor(1, 5)
    t.doKeys("g", "I")
    t.doKeys("a", "a", "<Esc>", "k")
    #expect("12\naa  xxxx" == t.value)
    t.assertCursorAt(0, 1)
    t.doKeys("g", "i")
    t.assertCursorAt(1, 2)
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("p")
  func u122_p() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.pushText("\"", "yank", VimText("abc\ndef"), linewise: false, blockwise: false)
    t.doKeys("p")
    #expect("__abc\ndef_" == t.value)
    t.assertCursorAt(0, 2)
    t.doKeys("y", "e", "p")
    #expect("__aabcbc\ndef_" == t.value)
    t.assertCursorAt(0, 5)
    t.doKeys("u")
  }

  @Test("p_register")
  func u123_p_register() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.getRegister("a").setText(VimText("abc\ndef"), linewise: false, blockwise: false)
    t.doKeys("\"", "a", "p")
    #expect("__abc\ndef_" == t.value)
    t.assertCursorAt(0, 2)
  }

  @Test("p_wrong_register")
  func u124_p_wrong_register() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.getRegister("a").setText(VimText("abc\ndef"), linewise: false, blockwise: false)
    t.doKeys("p")
    #expect("___" == t.value)
    t.assertCursorAt(0, 1)
  }

  @Test("p_line")
  func u125_p_line() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.pushText("\"", "yank", VimText("  a\nd\n"), linewise: true, blockwise: false)
    t.doKeys("2", "p")
    #expect("___\n  a\nd\n  a\nd" == t.value)
    t.assertCursorAt(1, 2)
  }

  @Test("p_lastline")
  func u126_p_lastline() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.pushText("\"", "yank", VimText("  a\nd"), linewise: true, blockwise: false)
    t.doKeys("2", "p")
    #expect("___\n  a\nd\n  a\nd" == t.value)
    t.assertCursorAt(1, 2)
  }

  @Test("]p_first_indent_is_smaller")
  func u127_p_first_indent_is_smaller() {
    let t = UpstreamVim(value: "  ___")

    t.registerController.pushText("\"", "yank", VimText("  abc\n    def\n"), linewise: true, blockwise: false)
    t.doKeys("]", "p")
    #expect("  ___\n  abc\n    def" == t.value)
  }

  @Test("]p_first_indent_is_larger")
  func u128_p_first_indent_is_larger() {
    let t = UpstreamVim(value: "  ___")

    t.registerController.pushText("\"", "yank", VimText("    abc\n  def\n"), linewise: true, blockwise: false)
    t.doKeys("]", "p")
    #expect("  ___\n  abc\ndef" == t.value)
  }

  @Test("]p_with_tab_indents")
  func u129_p_with_tab_indents() {
    let t = UpstreamVim(value: "\t___", indentWithTabs: true)

    t.registerController.pushText("\"", "yank", VimText("\t\tabc\n\t\t\tdef\n"), linewise: true, blockwise: false)
    t.doKeys("]", "p")
    #expect("\t___\n\tabc\n\t\tdef" == t.value)
  }

  @Test("]p_with_spaces_translated_to_tabs")
  func u130_p_with_spaces_translated_to_tabs() {
    let t = UpstreamVim(value: "\t___", tabSize: 2, indentWithTabs: true)

    t.registerController.pushText("\"", "yank", VimText("  abc\n    def\n"), linewise: true, blockwise: false)
    t.doKeys("]", "p")
    #expect("\t___\n\tabc\n\t\tdef" == t.value)
  }

  @Test("[p")
  func u131_p() {
    let t = UpstreamVim(value: "  ___")

    t.registerController.pushText("\"", "yank", VimText("  abc\n    def\n"), linewise: true, blockwise: false)
    t.doKeys("[", "p")
    #expect("  abc\n    def\n  ___" == t.value)
  }

  @Test("P")
  func u132_P() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.pushText("\"", "yank", VimText("abc\ndef"), linewise: false, blockwise: false)
    t.doKeys("P")
    #expect("_abc\ndef__" == t.value)
    t.assertCursorAt(0, 1)
    t.doKeys("y", "e", "P")
    #expect("_abcabc\ndef__" == t.value)
    t.assertCursorAt(0, 4)
    t.doKeys("u")
  }

  @Test("P_line")
  func u133_P_line() {
    let t = UpstreamVim(value: "___")

    t.setCursor(0, 1)
    t.registerController.pushText("\"", "yank", VimText("  a\nd\n"), linewise: true, blockwise: false)
    t.doKeys("2", "P")
    #expect("  a\nd\n  a\nd\n___" == t.value)
    t.assertCursorAt(0, 2)
  }

  @Test("r")
  func u134_r() {
    let t = UpstreamVim(value: "wordet\nanother")

    t.setCursor(0, 1)
    t.doKeys("3", "r", "u")
    #expect("wuuuet\nanother" == t.value)
    t.assertCursorAt(0, 3)
    t.setCursor(0, 4)
    t.doKeys("v", "j", "h", "r", "<Space>")
    #expect("wuuu  \n    her" == t.value)
    t.setValue("ox")
    t.doKeys("r", "<C-c>")
    #expect("ox" == t.value)
    t.doKeys("r", "<Del>")
    #expect("ox" == t.value)
    t.doKeys("r", "<CR>")
    #expect("\nx" == t.value)
  }

  @Test("r with surrogate characters")
  func u135_r_with_surrogate_characters() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("r", "u")
    #expect("u" == t.value)
  }

  @Test("r_visual_block")
  func u136_r_visual_block() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg", indentWithTabs: true)

    t.setCursor(2, 3)
    t.doKeys("<C-v>", "k", "k", "h", "h", "r", "l")
    #expect("1lll\n5lll\nalllefg" == t.value)
    t.doKeys("<C-v>", "l", "j", "r", "<Space>")
    #expect("1  l\n5  l\nalllefg" == t.value)
    t.setCursor(2, 0)
    t.doKeys("o")
    t.doKeys("\t\t")
    t.doKeys("<Esc>")
    t.doKeys("<C-v>", "h", "h", "r", "r")
    #expect("1  l\n5  l\nalllefg\nrrrrrrrr" == t.value)
  }

  @Test("r_visual with surrogate characters")
  func u137_r_visual_with_surrogate_characters() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("v", "r", "u")
    #expect("u" == t.value)
  }

  @Test("r_visual_block with surrogate characters")
  func u138_r_visual_block_with_surrogate_characters() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "r", "u")
    #expect("u" == t.value)
  }

  @Test("R")
  func u139_R() {
    let t = UpstreamVim()

    t.setCursor(0, 1)
    t.doKeys("R")
    t.assertCursorAt(0, 1)
    #expect("vim-replace" == t.option("keyMap"))
    #expect(t.overwrite)
  }

  @Test("R_visual")
  func u140_R_visual() {
    let t = UpstreamVim(value: "a11\na22\nb33\nc44\nc55")

    t.doKeys("<C-v>", "j", "R", "0", "<Esc>")
    #expect("0\nb33\nc44\nc55" == t.value)
    t.doKeys("2", "j", ".")
    #expect("0\nb33\n0" == t.value)
    t.doKeys("k", "v", "R", "1", "<Esc>")
    #expect("0\n1\n0" == t.value)
    t.doKeys("k", ".")
    #expect("1\n1\n0" == t.value)
    t.doKeys("p")
    #expect("1\n0\n1\n0" == t.value)
  }

  @Test("mark")
  func u141_mark() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "t")
    t.setCursor(0, 0)
    t.doKeys("`", "t")
    t.assertCursorAt(2, 2)
    t.setCursor(2, 0)
    t.replaceRange("   h", t.cursor)
    t.setCursor(0, 0)
    t.doKeys("'", "t")
    t.assertCursorAt(2, 3)
  }

  @Test("mark'")
  func u142_mark() {
    let t = UpstreamVim()

    // motions that do not update jumplist
    t.setCursor(2, 2)
    t.doKeys("`", "'")
    t.assertCursorAt(0, 0)
    t.doKeys("j", "3", "l")
    t.doKeys("`", "`")
    t.assertCursorAt(2, 2)
    t.doKeys("`", "`")
    t.assertCursorAt(1, 3)
    t.doKeys("/", "=", "\n")
    t.assertCursorAt(6, 20)
    t.doKeys("`", "`")
    t.assertCursorAt(1, 3)
    t.doKeys("'", "'")
    t.assertCursorAt(6, 2)
    t.doKeys("'", "`")
    t.assertCursorAt(1, 1)
    t.doKeys("g", "I", "\n", "<Esc>", "l")
    let ch = t.cursor.ch
    t.doKeys("`", "`")
    t.assertCursorAt(7, 2)
    t.doKeys("`", "`")
    t.assertCursorAt(2, ch)
  }

  @Test("mark.")
  func u143_mark() {
    let t = UpstreamVim()

    t.setCursor(0, 0)
    t.doKeys("O", "testing", "<Esc>")
    t.setCursor(3, 3)
    t.doKeys("'", ".")
    t.assertCursorAt(0, 0)
    t.setCursor(4, 4)
    t.doKeys("`", ".")
    t.assertCursorAt(0, 6)
  }

  @Test("jumpToMark_next")
  func u144_jumpToMark_next() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "t")
    t.setCursor(0, 0)
    t.doKeys("]", "`")
    t.assertCursorAt(2, 2)
    t.setCursor(0, 0)
    t.doKeys("]", "'")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_next_repeat")
  func u145_jumpToMark_next_repeat() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "a")
    t.setCursor(3, 2)
    t.doKeys("m", "b")
    t.setCursor(4, 2)
    t.doKeys("m", "c")
    t.setCursor(0, 0)
    t.doKeys("2", "]", "`")
    t.assertCursorAt(3, 2)
    t.setCursor(0, 0)
    t.doKeys("2", "]", "'")
    t.assertCursorAt(3, 1)
  }

  @Test("jumpToMark_next_sameline")
  func u146_jumpToMark_next_sameline() {
    let t = UpstreamVim()

    t.setCursor(2, 0)
    t.doKeys("m", "a")
    t.setCursor(2, 4)
    t.doKeys("m", "b")
    t.setCursor(2, 2)
    t.doKeys("]", "`")
    t.assertCursorAt(2, 4)
  }

  @Test("jumpToMark_next_onlyprev")
  func u147_jumpToMark_next_onlyprev() {
    let t = UpstreamVim()

    t.setCursor(2, 0)
    t.doKeys("m", "a")
    t.setCursor(4, 0)
    t.doKeys("]", "`")
    t.assertCursorAt(4, 0)
  }

  @Test("jumpToMark_next_nomark")
  func u148_jumpToMark_next_nomark() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("]", "`")
    t.assertCursorAt(2, 2)
    t.doKeys("]", "'")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_next_linewise_over")
  func u149_jumpToMark_next_linewise_over() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "a")
    t.setCursor(3, 4)
    t.doKeys("m", "b")
    t.setCursor(2, 1)
    t.doKeys("]", "'")
    t.assertCursorAt(3, 1)
  }

  @Test("jumpToMark_next_action")
  func u150_jumpToMark_next_action() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "t")
    t.setCursor(0, 0)
    t.doKeys("d", "]", "`")
    t.assertCursorAt(0, 0)
    let actual = t.getLine(0)
    let expected = "pop pop 0 1 2 3 4"
    #expect(actual == expected)
  }

  @Test("jumpToMark_prev")
  func u151_jumpToMark_prev() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "t")
    t.setCursor(4, 0)
    t.doKeys("[", "`")
    t.assertCursorAt(2, 2)
    t.setCursor(4, 0)
    t.doKeys("[", "'")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_prev_repeat")
  func u152_jumpToMark_prev_repeat() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "a")
    t.setCursor(3, 2)
    t.doKeys("m", "b")
    t.setCursor(4, 2)
    t.doKeys("m", "c")
    t.setCursor(5, 0)
    t.doKeys("2", "[", "`")
    t.assertCursorAt(3, 2)
    t.setCursor(5, 0)
    t.doKeys("2", "[", "'")
    t.assertCursorAt(3, 1)
  }

  @Test("jumpToMark_prev_sameline")
  func u153_jumpToMark_prev_sameline() {
    let t = UpstreamVim()

    t.setCursor(2, 0)
    t.doKeys("m", "a")
    t.setCursor(2, 4)
    t.doKeys("m", "b")
    t.setCursor(2, 2)
    t.doKeys("[", "`")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_prev_onlynext")
  func u154_jumpToMark_prev_onlynext() {
    let t = UpstreamVim()

    t.setCursor(4, 4)
    t.doKeys("m", "a")
    t.setCursor(2, 0)
    t.doKeys("[", "`")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_prev_nomark")
  func u155_jumpToMark_prev_nomark() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("[", "`")
    t.assertCursorAt(2, 2)
    t.doKeys("[", "'")
    t.assertCursorAt(2, 0)
  }

  @Test("jumpToMark_prev_linewise_over")
  func u156_jumpToMark_prev_linewise_over() {
    let t = UpstreamVim()

    t.setCursor(2, 2)
    t.doKeys("m", "a")
    t.setCursor(3, 4)
    t.doKeys("m", "b")
    t.setCursor(3, 6)
    t.doKeys("[", "'")
    t.assertCursorAt(2, 0)
  }

  @Test("delmark_single")
  func u157_delmark_single() {
    let t = UpstreamVim()

    t.setCursor(1, 2)
    t.doKeys("m", "t")
    t.doEx("delmarks t")
    t.setCursor(0, 0)
    t.doKeys("`", "t")
    t.assertCursorAt(0, 0)
  }

  @Test("delmark_range")
  func u158_delmark_range() {
    let t = UpstreamVim()

    t.setCursor(1, 2)
    t.doKeys("m", "a")
    t.setCursor(2, 2)
    t.doKeys("m", "b")
    t.setCursor(3, 2)
    t.doKeys("m", "c")
    t.setCursor(4, 2)
    t.doKeys("m", "d")
    t.setCursor(5, 2)
    t.doKeys("m", "e")
    t.doEx("delmarks b-d")
    t.setCursor(0, 0)
    t.doKeys("`", "a")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "b")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "c")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "d")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "e")
    t.assertCursorAt(5, 2)
  }

  @Test("delmark_multi")
  func u159_delmark_multi() {
    let t = UpstreamVim()

    t.setCursor(1, 2)
    t.doKeys("m", "a")
    t.setCursor(2, 2)
    t.doKeys("m", "b")
    t.setCursor(3, 2)
    t.doKeys("m", "c")
    t.setCursor(4, 2)
    t.doKeys("m", "d")
    t.setCursor(5, 2)
    t.doKeys("m", "e")
    t.doEx("delmarks bcd")
    t.setCursor(0, 0)
    t.doKeys("`", "a")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "b")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "c")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "d")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "e")
    t.assertCursorAt(5, 2)
  }

  @Test("delmark_multi_space")
  func u160_delmark_multi_space() {
    let t = UpstreamVim()

    t.setCursor(1, 2)
    t.doKeys("m", "a")
    t.setCursor(2, 2)
    t.doKeys("m", "b")
    t.setCursor(3, 2)
    t.doKeys("m", "c")
    t.setCursor(4, 2)
    t.doKeys("m", "d")
    t.setCursor(5, 2)
    t.doKeys("m", "e")
    t.doEx("delmarks b c d")
    t.setCursor(0, 0)
    t.doKeys("`", "a")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "b")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "c")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "d")
    t.assertCursorAt(1, 2)
    t.doKeys("`", "e")
    t.assertCursorAt(5, 2)
  }

  @Test("delmark_all")
  func u161_delmark_all() {
    let t = UpstreamVim()

    t.setCursor(1, 2)
    t.doKeys("m", "a")
    t.setCursor(2, 2)
    t.doKeys("m", "b")
    t.setCursor(3, 2)
    t.doKeys("m", "c")
    t.setCursor(4, 2)
    t.doKeys("m", "d")
    t.setCursor(5, 2)
    t.doKeys("m", "e")
    t.doEx("delmarks a b-de")
    t.setCursor(0, 0)
    t.doKeys("`", "a")
    t.assertCursorAt(0, 0)
    t.doKeys("`", "b")
    t.assertCursorAt(0, 0)
    t.doKeys("`", "c")
    t.assertCursorAt(0, 0)
    t.doKeys("`", "d")
    t.assertCursorAt(0, 0)
    t.doKeys("`", "e")
    t.assertCursorAt(0, 0)
  }

  @Test("visual")
  func u162_visual() {
    let t = UpstreamVim(value: "12345")

    t.doKeys("l", "v", "l", "l")
    t.assertCursorAt(0, 4)
    #expect(VimPosition(0, 1) == t.cm.getCursor(.anchor))
    t.doKeys("d")
    #expect("15" == t.value)
  }

  @Test("visual_yank")
  func u163_visual_yank() {
    let t = UpstreamVim(value: "a test for yank")

    t.doKeys("v", "3", "l", "y")
    t.assertCursorAt(0, 0)
    t.doKeys("p")
    #expect("aa te test for yank" == t.value)
  }

  @Test("visual_w")
  func u164_visual_w() {
    let t = UpstreamVim(value: "motion test")

    t.doKeys("v", "w")
    #expect(t.selection == "motion t")
  }

  @Test("visual_crossover_up")
  func u165_visual_crossover_up() {
    let t = UpstreamVim(value: "cross\ncross\ncross\ncross\ncross\n")

    t.setCursor(3, 2)
    t.doKeys("v", "j", "k", "k")
    #expect(VimPosition(2, 2) == t.cm.getCursor(.head))
    #expect(VimPosition(3, 3) == t.cm.getCursor(.anchor))
    t.doKeys("k")
    #expect(VimPosition(1, 2) == t.cm.getCursor(.head))
    #expect(VimPosition(3, 3) == t.cm.getCursor(.anchor))
  }

  @Test("visual_crossover_down")
  func u166_visual_crossover_down() {
    let t = UpstreamVim(value: "cross\ncross\ncross\ncross\ncross\n")

    t.setCursor(1, 2)
    t.doKeys("v", "k", "j", "j")
    #expect(VimPosition(2, 3) == t.cm.getCursor(.head))
    #expect(VimPosition(1, 2) == t.cm.getCursor(.anchor))
    t.doKeys("j")
    #expect(VimPosition(3, 3) == t.cm.getCursor(.head))
    #expect(VimPosition(1, 2) == t.cm.getCursor(.anchor))
  }

  @Test("visual_exit")
  func u167_visual_exit() {
    let t = UpstreamVim(value: "hello\nworld\nfoo")

    t.doKeys("<C-v>", "l", "j", "j", "<Esc>")
    #expect(t.cm.getCursor(.anchor) == t.cm.getCursor(.head))
    #expect(t.state.visualMode == false)
  }

  @Test("visual_line")
  func u168_visual_line() {
    let t = UpstreamVim(value: " 1\n 2\n 3\n 4\n 5")

    t.doKeys("l", "V", "l", "j", "j", "d")
    #expect(" 4\n 5" == t.value)
  }

  @Test("visual_block_move_to_eol")
  func u169_visual_block_move_to_eol() {
    let t = UpstreamVim(value: "123\n45\n6")

    // moveToEol should move all block cursors to end of line
    t.setCursor(0, 0)
    t.doKeys("<C-v>", "G", "$")
    var selections = t.getSelections().joined(separator: ",")
    #expect("123,45,6" == selections)
    t.doKeys("2", "k", "b")
    selections = t.getSelections().joined(separator: ",")
    #expect("1" == selections)
  }

  @Test("visual_block_different_line_lengths")
  func u170_visual_block_different_line_lengths() {
    let t = UpstreamVim(value: "1234\n5678\nabcdefg")

    // test the block selection with lines of different length
    // i.e. extending the selection
    // till the end of the longest line.
    t.doKeys("<C-v>", "l", "j", "j", "6", "l", "d")
    t.doKeys("d", "d", "d", "d")
    #expect("" == t.value)
  }

  @Test("visual_block_truncate_on_short_line")
  func u171_visual_block_truncate_on_short_line() {
    let t = UpstreamVim(value: "hello world\n{\nthis is\nsparta!")

    // check for left side selection in case
    // of moving up to a shorter line.
    t.replaceRange("", t.cursor)
    t.setCursor(3, 4)
    t.doKeys("<C-v>", "l", "k", "k", "d")
    #expect(("hello world\n{\ntis\nsa!") == t.value)
  }

  @Test("visual_block_corners")
  func u172_visual_block_corners() {
    let t = UpstreamVim(value: "12345\n67891\nabcde")

    t.setCursor(1, 2)
    t.doKeys("<C-v>", "2", "l", "k")
    var selections = t.getSelections()
    #expect("345891" == selections.joined(separator: ""))
    t.doKeys("4", "h")
    selections = t.getSelections()
    #expect("123678" == selections.joined(separator: ""))
    t.doKeys("j", "j")
    selections = t.getSelections()
    #expect("678abc" == selections.joined(separator: ""))
    t.doKeys("4", "l")
    selections = t.getSelections()
    #expect("891cde" == selections.joined(separator: ""))
  }

  @Test("visual_block_mode_switch")
  func u173_visual_block_mode_switch() {
    let t = UpstreamVim(value: "12345\n67891\nabcde")

    // switch between visual modes
    t.setCursor(1, 1)
    t.doKeys("<C-v>", "j", "l", "v")
    var selections = t.getSelections()
    #expect("7891\nabc" == selections.joined(separator: ""))
    t.doKeys("<C-v>")
    selections = t.getSelections()
    #expect("78bc" == selections.joined(separator: ""))
    t.doKeys("V")
    selections = t.getSelections()
    #expect("67891\nabcde" == selections.joined(separator: ""))
  }

  @Test("visual_block_crossing_short_line")
  func u174_visual_block_crossing_short_line() {
    let t = UpstreamVim(value: "123456\n78\nabcdefg\nfoobar\n}\n")

    // visual block with long and short lines
    t.setCursor(0, 3)
    t.doKeys("<C-v>", "j", "j", "j")
    var selections = t.getSelections().joined(separator: ",")
    #expect("4,,d,b" == selections)
    t.doKeys("3", "k")
    selections = t.getSelections().joined(separator: ",")
    #expect("4" == selections)
    t.doKeys("5", "j", "k")
    selections = t.getSelections().joined(separator: "")
    #expect(10 == selections.utf16.count)
  }

  @Test("visual_block_curPos_on_exit")
  func u175_visual_block_curPos_on_exit() {
    let t = UpstreamVim(value: "123456\n78\nabcdefg\nfoobar")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "3", "l", "<Esc>")
    #expect(VimPosition(0, 3) == t.cursor)
    t.doKeys("h", "<C-v>", "2", "j", "3", "l")
    #expect(t.getSelections().joined(separator: ",") == "3456,,cdef")
    t.doKeys("4", "h")
    #expect(t.getSelections().joined(separator: ",") == "23,8,bc")
    t.doKeys("2", "l")
    #expect(t.getSelections().joined(separator: ",") == "34,,cd")
  }

  @Test("visual_marks")
  func u176_visual_marks() {
    let t = UpstreamVim()

    t.doKeys("l", "v", "l", "l", "j", "j", "v")
    t.setCursor(2, 1)
    t.doKeys("'", "<")
    t.assertCursorAt(0, 1)
    t.doKeys("'", ">")
    t.assertCursorAt(2, 0)
  }

  @Test("visual_join")
  func u177_visual_join() {
    let t = UpstreamVim(value: " 1\n 2\n 3\n 4\n 5")

    t.doKeys("l", "V", "l", "j", "j", "J")
    #expect(" 1 2 3\n 4\n 5" == t.value)
    #expect(!t.state.visualMode)
  }

  @Test("visual_join_2")
  func u178_visual_join_2() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5\n6\n")

    t.doKeys("G", "V", "g", "g", "J")
    #expect("1 2 3 4 5 6" == t.value)
    #expect(!t.state.visualMode)
  }

  @Test("visual_join_blank")
  func u179_visual_join_blank() {
    let t = UpstreamVim(value: "1 \n\t2\n\t  \n\n5\n 6\n")

    let initialValue = t.value
    t.doKeys("G", "V", "g", "g", "J")
    #expect("1  2 5 6" == t.value)
    #expect(!t.state.visualMode)
    t.doKeys("u")
    #expect(initialValue == t.value)
    t.doKeys("G", "V", "g", "g", "g", "J")
    #expect("1 \t2\t  5 6" == t.value)
    t.doKeys("u")
    #expect(t.cursor.line == 0)
    #expect(initialValue == t.value)
    t.doKeys("J", "J", "J")
    t.assertCursorAt(0, 3)
    t.doKeys("J")
    t.assertCursorAt(0, 4)
    #expect("1  2 5\n 6\n" == t.value)
    t.doKeys("u")
    #expect("1  2\n5\n 6\n" == t.value)
  }

  @Test("visual_blank")
  func u180_visual_blank() {
    let t = UpstreamVim(value: "\n")

    t.doKeys("v", "k")
    #expect(t.state.visualMode == true)
  }

  @Test("reselect_visual")
  func u181_reselect_visual() {
    let t = UpstreamVim(value: "123456\nfoo\nbar")

    t.doKeys("l", "v", "l", "l", "l", "y", "g", "v")
    t.assertCursorAt(0, 5)
    #expect(VimPosition(0, 1) == t.cm.getCursor(.anchor))
    t.doKeys("v")
    t.setCursor(1, 0)
    t.doKeys("v", "l", "l", "p")
    #expect("123456\n2345\nbar" == t.value)
    t.setCursor(0, 0)
    t.doKeys("g", "v")
    t.assertCursorAt(1, 4)
    #expect(VimPosition(1, 0) == t.cm.getCursor(.anchor))
    t.doKeys("v")
    t.setCursor(2, 0)
    t.doKeys("v", "l", "l", "g", "v")
    t.assertCursorAt(1, 4)
    #expect(VimPosition(1, 0) == t.cm.getCursor(.anchor))
    t.doKeys("g", "v")
    t.assertCursorAt(2, 3)
    #expect(VimPosition(2, 0) == t.cm.getCursor(.anchor))
    #expect("123456\n2345\nbar" == t.value)
  }

  @Test("reselect_visual_line")
  func u182_reselect_visual_line() {
    let t = UpstreamVim(value: "hello\nthis\nis\nfoo\nand\nbar")

    t.doKeys("l", "V", "j", "j", "V", "g", "v", "d")
    #expect("foo\nand\nbar" == t.value)
    t.setCursor(1, 0)
    t.doKeys("V", "y", "j")
    t.doKeys("V", "p", "g", "v", "d")
    #expect("foo\nand" == t.value)
  }

  @Test("s_normal")
  func u183_s_normal() {
    let t = UpstreamVim(value: "abc")

    t.setCursor(0, 1)
    t.doKeys("s")
    t.doKeys("<Esc>")
    #expect("ac" == t.value)
  }

  @Test("s_normal surrogate character")
  func u184_s_normal_surrogate_character() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("s")
    t.doKeys("test")
    t.doKeys("<Esc>")
    #expect("test" == t.value)
  }

  @Test("s_visual")
  func u185_s_visual() {
    let t = UpstreamVim(value: "abc")

    t.setCursor(0, 1)
    t.doKeys("v", "s")
    t.doKeys("<Esc>")
    t.assertCursorAt(0, 0)
    #expect("ac" == t.value)
  }

  @Test("d with surrogate character")
  func u186_d_with_surrogate_character() {
    let t = UpstreamVim(value: "😀")

    t.setCursor(0, 0)
    t.doKeys("v")
    t.doKeys("d")
    t.doKeys("<Esc>")
    #expect("" == t.value)
  }

  @Test("o_visual")
  func u187_o_visual() {
    let t = UpstreamVim(value: "abcd\nefgh\nijkl\nmnop")

    t.setCursor(0, 0)
    t.doKeys("v", "l", "l", "l", "o")
    t.assertCursorAt(0, 0)
    t.doKeys("v", "v", "j", "j", "j", "o")
    t.assertCursorAt(0, 0)
    t.doKeys("O")
    t.doKeys("l", "l")
    t.assertCursorAt(3, 3)
    t.doKeys("d")
    #expect("p" == t.value)
  }

  @Test("changeCase_visual")
  func u188_changeCase_visual() {
    let t = UpstreamVim(value: "abcdef\nghijkl\nmnopq\nshort line\nlong line of text")

    t.setCursor(0, 0)
    t.doKeys("v", "l", "l")
    t.doKeys("U")
    t.assertCursorAt(0, 0)
    t.doKeys("v", "l", "l")
    t.doKeys("u")
    t.assertCursorAt(0, 0)
    t.doKeys("l", "l", "l", ".")
    t.assertCursorAt(0, 3)
    t.setCursor(0, 0)
    t.doKeys("q", "a", "v", "j", "U", "q")
    t.assertCursorAt(0, 0)
    t.doKeys("j", "@", "a")
    t.assertCursorAt(1, 0)
    t.setCursor(3, 0)
    t.doKeys("V", "U", "j", ".")
    #expect("ABCDEF\nGHIJKL\nMnopq\nSHORT LINE\nLONG LINE OF TEXT" == t.value)
  }

  @Test("changeCase_visual_block")
  func u189_changeCase_visual_block() {
    let t = UpstreamVim(value: "abcdef\nghijkl\nmnopq\nfoo")

    t.setCursor(2, 1)
    t.doKeys("<C-v>", "k", "k", "h", "U")
    #expect("ABcdef\nGHijkl\nMNopq\nfoo" == t.value)
    t.setCursor(0, 2)
    t.doKeys(".")
    #expect("ABCDef\nGHIJkl\nMNOPq\nfoo" == t.value)
    t.setCursor(2, 2)
    t.doKeys(".")
    #expect("ABCDef\nGHIJkl\nMNOPq\nfoO" == t.value)
  }

  @Test("visual_paste")
  func u190_visual_paste() {
    let t = UpstreamVim(value: "this is a\nunit test for visual paste")

    t.setCursor(0, 0)
    t.doKeys("v", "l", "l", "y")
    t.assertCursorAt(0, 0)
    t.doKeys("3", "l", "j", "v", "l", "p")
    t.assertCursorAt(1, 5)
    #expect("this is a\nunithitest for visual paste" == t.value)
    t.setCursor(0, 0)
    t.doKeys("y", "y")
    t.setCursor(1, 6)
    t.doKeys("v", "l", "l", "l", "p")
    t.assertCursorAt(2, 0)
    #expect("this is a\nunithi\nthis is a\n for visual paste" == t.value)
  }

  @Test("v_paste_from_register")
  func u191_v_paste_from_register() {
    let t = UpstreamVim(value: "register contents\nare not erased")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "w")
    t.setCursor(1, 0)
    t.doKeys("v", "p")
    t.doEx("registers")
    #expect(t.matches("a\\s+register", "", t.notificationText))
  }

  @Test("S_normal")
  func u192_S_normal() {
    let t = UpstreamVim(value: "aa{\n  bb\ncc")

    t.setCursor(0, 1)
    t.doKeys("j", "S")
    t.doKeys("<Esc>")
    t.assertCursorAt(1, 1)
    #expect(("aa{\n  \ncc") == t.value)
    t.doKeys("j", "S")
    #expect(("aa{\n  \n") == t.value)
    t.assertCursorAt(2, 0)
    t.doKeys("<Esc>")
    t.doKeys("d", "d", "d", "d")
    t.assertCursorAt(0, 0)
    t.doKeys("S")
    #expect(t.state.insertMode)
    #expect("" == t.value)
  }

  @Test("blockwise_paste")
  func u193_blockwise_paste() {
    let t = UpstreamVim(value: "hello\nworld\nfoo\nbar")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "3", "j", "l", "y")
    t.setCursor(0, 2)
    t.doKeys("p")
    #expect("helhelo\nworwold\nfoofo\nbarba" == t.value)
    t.setCursor(0, 0)
    t.doKeys("v", "4", "l", "y")
    t.setCursor(0, 0)
    t.doKeys("<C-v>", "3", "j", "p")
    #expect("helheelhelo\norwold\noofo\narba" == t.value)
  }

  @Test("blockwise_paste_long/short_line")
  func u194_blockwise_paste_long_short_line() {
    let t = UpstreamVim(value: "hello\nfoo\nbar")

    // extend short lines in case of different line lengths.
    t.setCursor(0, 0)
    t.doKeys("<C-v>", "j", "j", "y")
    t.setCursor(0, 3)
    t.doKeys("p")
    #expect("hellho\nfoo f\nbar b" == t.value)
  }

  @Test("blockwise_paste_cut_paste")
  func u195_blockwise_paste_cut_paste() {
    let t = UpstreamVim(value: "cut\nand\npaste\nme")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "2", "j", "x")
    t.setCursor(0, 0)
    t.doKeys("P")
    #expect("cut\nand\npaste\nme" == t.value)
  }

  @Test("blockwise_paste_from_register")
  func u196_blockwise_paste_from_register() {
    let t = UpstreamVim(value: "foobar\nhello\nworld")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "2", "j", "\"", "a", "y")
    t.setCursor(0, 3)
    t.doKeys("\"", "a", "p")
    #expect("foobfar\nhellho\nworlwd" == t.value)
  }

  @Test("blockwise_paste_last_line")
  func u197_blockwise_paste_last_line() {
    let t = UpstreamVim(value: "cut\nand\npaste\nme")

    t.setCursor(0, 0)
    t.doKeys("<C-v>", "2", "j", "l", "y")
    t.setCursor(3, 0)
    t.doKeys("p")
    #expect("cut\nand\npaste\nmcue\n an\n pa" == t.value)
  }

  @Test("S_visual")
  func u198_S_visual() {
    let t = UpstreamVim(value: "aa\nbb\ncc")

    t.setCursor(0, 1)
    t.doKeys("v", "j", "S")
    t.doKeys("<Esc>")
    t.assertCursorAt(0, 0)
    #expect("\ncc" == t.value)
  }

  @Test("d_/")
  func u199_d() {
    let t = UpstreamVim(value: "text match match \n next")

    t.doKeys("2", "d", "/", "match", "\n")
    t.assertCursorAt(0, 0)
    #expect("match \n next" == t.value)
    t.doKeys("d", ":", "2", "\n")
  }

  @Test("/ and n/N")
  func u200_and_n_N() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "match", "\n")
    t.assertCursorAt(0, 11)
    t.doKeys("n")
    t.assertCursorAt(1, 6)
    t.doKeys("N")
    t.assertCursorAt(0, 11)
    t.setCursor(0, 0)
    t.doKeys("2", "/", "match", "\n")
    t.assertCursorAt(1, 6)
  }

  @Test("/ and gn selects the appropriate word")
  func u201_and_gn_selects_the_appropriate_word() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "match", "\n")
    t.assertCursorAt(0, 11)
    t.doKeys("gn", "<Esc>")
    t.assertCursorAt(0, 15)
    t.doKeys("gn", "<Esc>")
    t.doKeys("<Esc>")
    t.assertCursorAt(0, 15)
    t.doKeys("gn")
    t.assertCursorAt(0, 16)
    t.doKeys("gn")
    t.assertCursorAt(1, 11)
    t.doKeys("d")
    #expect("match nope " == t.value)
  }

  @Test("/ and gN selects the appropriate word")
  func u202_and_gN_selects_the_appropriate_word() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "match", "\n")
    t.assertCursorAt(0, 11)
    t.doKeys("gN", "<Esc>")
    t.assertCursorAt(0, 11)
    t.doKeys("e", "gN", "<Esc>")
    t.assertCursorAt(0, 11)
    t.doKeys("gN")
    t.assertCursorAt(0, 11)
    t.doKeys("gN")
    t.assertCursorAt(0, 0)
    t.doKeys("d")
    #expect(" \n nope Match" == t.value)
  }

  @Test("/ and gn with an associated operator")
  func u203_and_gn_with_an_associated_operator() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "match", "\n")
    t.assertCursorAt(0, 11)
    t.doKeys("c", "gn", "changed", "<Esc>")
    #expect("match nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("match nope changed \n nope changed" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope changed" == t.value)
  }

  @Test("/ and gN with an associated operator")
  func u204_and_gN_with_an_associated_operator() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "match", "\n")
    t.assertCursorAt(0, 11)
    t.doKeys("c", "gN", "changed", "<Esc>")
    #expect("match nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope changed" == t.value)
  }

  @Test("/_case")
  func u205_case() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("/", "Match", "\n")
    t.assertCursorAt(1, 6)
  }

  @Test("/_2_pcre")
  func u206_2_pcre() {
    let t = UpstreamVim(value: "word\n another wordword\n wordwordword\n")

    try? t.vim.setOption("pcre", true)
    t.doKeys("/", "(word){2}", "\n")
    t.assertCursorAt(1, 9)
    t.doKeys("n")
    t.assertCursorAt(2, 1)
  }

  @Test("/_2_nopcre")
  func u207_2_nopcre() {
    let t = UpstreamVim(value: "word\n another wordword\n wordwordword\n")

    try? t.vim.setOption("pcre", false)
    t.doKeys("/", "\\(word\\)\\{2}", "\n")
    t.assertCursorAt(1, 9)
    t.doKeys("n")
    t.assertCursorAt(2, 1)
  }

  @Test("/_nongreedy")
  func u208_nongreedy() {
    let t = UpstreamVim(value: "aaa aa \n a aa")

    t.doKeys("/", "aa", "\n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(1, 3)
    t.doKeys("n")
    t.assertCursorAt(0, 0)
  }

  @Test("?_nongreedy")
  func u209_nongreedy() {
    let t = UpstreamVim(value: "aaa aa \n a aa")

    t.doKeys("?", "aa", "\n")
    t.assertCursorAt(1, 3)
    t.doKeys("n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(0, false ? 1 : 0)
  }

  @Test("/_greedy")
  func u210_greedy() {
    let t = UpstreamVim(value: "aaa aa \n a aa")

    t.doKeys("/", "a+", "\n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(1, 1)
    t.doKeys("n")
    t.assertCursorAt(1, 3)
    t.doKeys("n")
    t.assertCursorAt(0, 0)
  }

  @Test("?_greedy")
  func u211_greedy() {
    let t = UpstreamVim(value: "aaa aa \n a aa")

    t.doKeys("?", "a+", "\n")
    t.assertCursorAt(1, 3)
    t.doKeys("n")
    t.assertCursorAt(1, 1)
    t.doKeys("n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(0, 0)
  }

  @Test("/_greedy_0_or_more")
  func u212_greedy_0_or_more() {
    let t = UpstreamVim(value: "aaa  aa\n aa")

    t.doKeys("/", "a*", "\n")
    t.assertCursorAt(0, 3)
    t.doKeys("n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(0, 5)
    t.doKeys("n")
    t.assertCursorAt(1, 0)
    t.doKeys("n")
    t.assertCursorAt(1, 1)
    t.doKeys("n")
    t.assertCursorAt(0, 0)
  }

  @Test("?_greedy_0_or_more")
  func u213_greedy_0_or_more() {
    let t = UpstreamVim(value: "aaa  aa\n aa")

    t.doKeys("?", "a*", "\n")
    t.assertCursorAt(1, 1)
    t.doKeys("n")
    t.assertCursorAt(1, 0)
    t.doKeys("n")
    t.assertCursorAt(0, 5)
    t.doKeys("n")
    t.assertCursorAt(0, 4)
    t.doKeys("n")
    t.assertCursorAt(0, 0)
  }

  @Test("? and n/N")
  func u214_and_n_N() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("?", "match", "\n")
    t.assertCursorAt(1, 6)
    t.doKeys("n")
    t.assertCursorAt(0, 11)
    t.doKeys("N")
    t.assertCursorAt(1, 6)
    t.setCursor(0, 0)
    t.doKeys("2", "?", "match", "\n")
    t.assertCursorAt(0, 11)
  }

  @Test("? and gn selects the appropriate word")
  func u215_and_gn_selects_the_appropriate_word() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("?", "match", "\n", "n")
    t.assertCursorAt(0, 11)
    t.doKeys("gn", "<Esc>")
    t.assertCursorAt(0, 11)
    t.doKeys("e", "gn", "<Esc>")
    t.assertCursorAt(0, 11)
    t.doKeys("gn")
    t.assertCursorAt(0, 11)
    t.doKeys("gn")
    t.assertCursorAt(0, 0)
    t.doKeys("d")
    #expect(" \n nope Match" == t.value)
  }

  @Test("? and gN selects the appropriate word")
  func u216_and_gN_selects_the_appropriate_word() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("?", "match", "\n", "n")
    t.assertCursorAt(0, 11)
    t.doKeys("gN", "<Esc>")
    t.assertCursorAt(0, 15)
    t.doKeys("gN", "<Esc>")
    t.assertCursorAt(0, 15)
    t.doKeys("gN")
    t.assertCursorAt(0, 16)
    t.doKeys("gN")
    t.assertCursorAt(1, 11)
    t.doKeys("d")
    #expect("match nope " == t.value)
  }

  @Test("? and gn with an associated operator")
  func u217_and_gn_with_an_associated_operator() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("?", "match", "\n", "n")
    t.assertCursorAt(0, 11)
    t.doKeys("c", "gn", "changed", "<Esc>")
    #expect("match nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope changed" == t.value)
  }

  @Test("? and gN with an associated operator")
  func u218_and_gN_with_an_associated_operator() {
    let t = UpstreamVim(value: "match nope match \n nope Match")

    t.doKeys("?", "match", "\n", "n")
    t.assertCursorAt(0, 11)
    t.doKeys("c", "gN", "changed", "<Esc>")
    #expect("match nope changed \n nope Match" == t.value)
    t.doKeys(".")
    #expect("match nope changed \n nope changed" == t.value)
    t.doKeys(".")
    #expect("changed nope changed \n nope changed" == t.value)
  }

  @Test("*")
  func u219_x() {
    let t = UpstreamVim(value: "nomatch match nomatch match \nnomatch Match")

    t.setCursor(0, 9)
    t.doKeys("*")
    t.assertCursorAt(0, 22)
    t.setCursor(0, 9)
    t.doKeys("2", "*")
    t.assertCursorAt(1, 8)
  }

  @Test("*_no_word")
  func u220_no_word() {
    let t = UpstreamVim(value: " \n match \n")

    t.setCursor(0, 0)
    t.doKeys("*")
    t.assertCursorAt(0, 0)
  }

  @Test("*_symbol")
  func u221_symbol() {
    let t = UpstreamVim(value: " /}\n/} match \n")

    t.setCursor(0, 0)
    t.doKeys("*")
    t.assertCursorAt(1, 0)
  }

  @Test("#")
  func u222_x() {
    let t = UpstreamVim(value: "nomatch match nomatch match \nnomatch Match")

    t.setCursor(0, 9)
    t.doKeys("#")
    t.assertCursorAt(1, 8)
    t.setCursor(0, 9)
    t.doKeys("2", "#")
    t.assertCursorAt(0, 22)
  }

  @Test("*_seek")
  func u223_seek() {
    let t = UpstreamVim(value: "    :=  match nomatch match \nnomatch Match")

    // Should skip over space and symbols.
    t.setCursor(0, 3)
    t.doKeys("*")
    t.assertCursorAt(0, 22)
  }

  @Test("#")
  func u224_x() {
    let t = UpstreamVim(value: "    :=  match nomatch match \nnomatch Match")

    // Should skip over space and symbols.
    t.setCursor(0, 3)
    t.doKeys("#")
    t.assertCursorAt(1, 8)
  }

  @Test("g*")
  func u225_g() {
    let t = UpstreamVim(value: "matches match alsoMatch\nmatchme matching")

    t.setCursor(0, 8)
    t.doKeys("g", "*")
    t.assertCursorAt(0, 18)
    t.setCursor(0, 8)
    t.doKeys("3", "g", "*")
    t.assertCursorAt(1, 8)
  }

  @Test("g#")
  func u226_g() {
    let t = UpstreamVim(value: "matches match alsoMatch\nmatchme matching")

    t.setCursor(0, 8)
    t.doKeys("g", "#")
    t.assertCursorAt(0, 0)
    t.setCursor(0, 8)
    t.doKeys("3", "g", "#")
    t.assertCursorAt(1, 0)
  }

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

  @Test("macro_insert_repeat")
  func u228_macro_insert_repeat() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "$", "a")
    t.doKeys("larry.")
    t.doKeys("<Esc>")
    t.doKeys("a")
    t.doKeys("curly.")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doKeys("a")
    t.doKeys("moe.")
    t.doKeys("<Esc>")
    t.doKeys("@", "a")
    t.doKeys(".")
    #expect("larry.curly.moe.larry.curly.curly." == t.value)
  }

  @Test("macro_space")
  func u229_macro_space() {
    let t = UpstreamVim(value: "one line of text.")

    t.setCursor(0, 0)
    t.doKeys("<Space>", "<Space>")
    t.assertCursorAt(0, 2)
    t.doKeys("q", "a", "<Space>", "<Space>", "q")
    t.assertCursorAt(0, 4)
    t.doKeys("@", "a")
    t.assertCursorAt(0, 6)
    t.doKeys("@", "a")
    t.assertCursorAt(0, 8)
  }

  @Test("macro_t_search")
  func u230_macro_t_search() {
    let t = UpstreamVim(value: "one line of text.")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "t", "e", "q")
    t.assertCursorAt(0, 1)
    t.doKeys("l", "@", "a")
    t.assertCursorAt(0, 6)
    t.doKeys("l", ";")
    t.assertCursorAt(0, 12)
  }

  @Test("macro_f_search")
  func u231_macro_f_search() {
    let t = UpstreamVim(value: "one line of text.")

    t.setCursor(0, 0)
    t.doKeys("q", "b", "f", "e", "q")
    t.assertCursorAt(0, 2)
    t.doKeys("@", "b")
    t.assertCursorAt(0, 7)
    t.doKeys(";")
    t.assertCursorAt(0, 13)
  }

  @Test("macro_slash_search")
  func u232_macro_slash_search() {
    let t = UpstreamVim(value: "one line of text.")

    t.setCursor(0, 0)
    t.doKeys("q", "c")
    t.doKeys("/", "e", "\n", "q")
    t.assertCursorAt(0, 2)
    t.doKeys("@", "c")
    t.assertCursorAt(0, 7)
    t.doKeys("n")
    t.assertCursorAt(0, 13)
  }

  @Test("macro_multislash_search")
  func u233_macro_multislash_search() {
    let t = UpstreamVim(value: "one line of text to rule them all.")

    t.setCursor(0, 0)
    t.doKeys("q", "d")
    t.doKeys("/", "e", "\n")
    t.doKeys("/", "t", "\n", "q")
    t.assertCursorAt(0, 12)
    t.doKeys("@", "d")
    t.assertCursorAt(0, 15)
  }

  @Test("macro_last_ex_command_register")
  func u234_macro_last_ex_command_register() {
    let t = UpstreamVim(value: "aaaaa")

    t.setCursor(0, 0)
    t.doEx("s/a/b")
    t.doKeys("2", "@", ":")
    #expect("bbbaa" == t.value)
    t.assertCursorAt(0, 2)
  }

  @Test("macro_last_run_macro")
  func u235_macro_last_run_macro() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "C", "a", "<Esc>", "q")
    t.doKeys("q", "b", "C", "b", "<Esc>", "q")
    t.doKeys("@", "a")
    t.doKeys("d", "d")
    t.doKeys("@", "@")
    #expect("a" == t.value)
  }

  @Test("macro_parens")
  func u236_macro_parens() {
    let t = UpstreamVim(value: "see spot run")

    t.setCursor(0, 0)
    t.doKeys("q", "z", "i")
    t.doKeys("(")
    t.doKeys("<Esc>")
    t.doKeys("e", "a")
    t.doKeys(")")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doKeys("w", "@", "z")
    t.doKeys("w", "@", "z")
    #expect("(see) (spot) (run)" == t.value)
  }

  @Test("macro_overwrite")
  func u237_macro_overwrite() {
    let t = UpstreamVim(value: "see spot run")

    t.setCursor(0, 0)
    t.doKeys("q", "z", "0", "i")
    t.doKeys("I ")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doKeys("e")
    t.doKeys("q", "z", "a")
    t.doKeys(".")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doKeys("e", "@", "z")
    t.doKeys("e", "@", "z")
    #expect("I see. spot. run." == t.value)
  }

  @Test("macro_search_f")
  func u238_macro_search_f() {
    let t = UpstreamVim(value: "The quick brown fox jumped over the lazy dog.")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "f", " ")
    t.assertCursorAt(0, 3)
    t.doKeys("q", "0")
    t.assertCursorAt(0, 0)
    t.doKeys("@", "a")
    t.assertCursorAt(0, 3)
  }

  @Test("macro_search_2f")
  func u239_macro_search_2f() {
    let t = UpstreamVim(value: "The quick brown fox jumped over the lazy dog.")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "2", "f", " ")
    t.assertCursorAt(0, 9)
    t.doKeys("q", "0")
    t.assertCursorAt(0, 0)
    t.doKeys("@", "a")
    t.assertCursorAt(0, 9)
  }

  @Test("macro_yank_tick")
  func u240_macro_yank_tick() {
    let t = UpstreamVim(value: "the ex parrot")

    t.setCursor(0, 0)
    t.doKeys("q", "'")
    t.doKeys("y", "<Right>", "<Right>", "<Right>", "<Right>", "p")
    t.assertCursorAt(0, 4)
    #expect("the tex parrot" == t.value)
  }

  @Test("yank_register")
  func u241_yank_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "y")
    t.doKeys("j", "\"", "b", "y", "y")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+foo", "", text))
    #expect(t.matches("b\\s+bar", "", text))
  }

  @Test("yank_visual_block")
  func u242_yank_visual_block() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 1)
    t.doKeys("<C-v>", "l", "j", "\"", "a", "y")
    t.doEx("registers")
    #expect(t.matches("a\\s+oo\\nar", "", t.notificationText))
  }

  @Test("yank_append_line_to_line_register")
  func u243_yank_append_line_to_line_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "y")
    t.doKeys("j", "\"", "A", "y", "y")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+foo\\nbar", "", text))
    #expect(t.matches("\"\\s+foo\\nbar", "", text))
  }

  @Test("yank_append_word_to_word_register")
  func u244_yank_append_word_to_word_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "w")
    t.doKeys("j", "\"", "A", "y", "w")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+foobar", "", text))
    #expect(t.matches("\"\\s+foobar", "", text))
  }

  @Test("yank_append_line_to_word_register")
  func u245_yank_append_line_to_word_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "w")
    t.doKeys("j", "\"", "A", "y", "y")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+foo\\nbar", "", text))
    #expect(t.matches("\"\\s+foo\\nbar", "", text))
  }

  @Test("yank_append_word_to_line_register")
  func u246_yank_append_word_to_line_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.setCursor(0, 0)
    t.doKeys("\"", "a", "y", "y")
    t.doKeys("j", "\"", "A", "y", "w")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+foo\\nbar", "", text))
    #expect(t.matches("\"\\s+foo\\nbar", "", text))
  }

  @Test("black_hole_register")
  func u247_black_hole_register() {
    let t = UpstreamVim(value: "foo\nbar")

    t.doKeys("g", "g", "y", "G")
    t.doEx("registers")
    let registersText = t.notificationText
    t.doKeys("\"", "_", "d", "G")
    t.doEx("registers")
    #expect(registersText == t.notificationText)
    t.doKeys("\"", "_", "p")
    #expect("" == t.value)
  }

  @Test("macro_register")
  func u248_macro_register() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("q", "a", "i")
    t.doKeys("gangnam")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doKeys("q", "b", "o")
    t.doKeys("style")
    t.doKeys("<Esc>")
    t.doKeys("q")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("a\\s+i", "", text))
    #expect(t.matches("b\\s+o", "", text))
  }

  @Test("._register")
  func u249_register() {
    let t = UpstreamVim(value: "")

    t.setCursor(0, 0)
    t.doKeys("i")
    t.doKeys("foo")
    t.doKeys("<Esc>")
    t.doEx("registers")
    #expect(t.matches("\\.\\s+foo", "", t.notificationText))
  }

  @Test(":_register")
  func u250_register() {
    let t = UpstreamVim(value: "")

    t.doEx("bar")
    t.doEx("registers")
    #expect(t.matches(":\\s+bar", "", t.notificationText))
  }

  @Test("registers_html_encoding")
  func u251_registers_html_encoding() {
    let t = UpstreamVim(value: "<script>throw \"&amp;\"</script>")

    t.doKeys("y", "y")
    t.doEx("registers")
    #expect(t.matches("\"\\s+<script>throw \"&amp;\"<\\/script>", "", t.notificationText))
  }

  @Test("search_register_escape")
  func u252_search_register_escape() {
    let t = UpstreamVim(value: "")

    // Check that the register is restored if the user escapes rather than confirms.
    t.doKeys("/", "waldo", "\n")
    t.doKeys("/", "foo", "<Esc>")
    t.doEx("registers")
    let text = t.notificationText
    #expect(t.matches("waldo", "", text))
    #expect(!t.matches("foo", "", text))
  }

  @Test("search_register")
  func u253_search_register() {
    let t = UpstreamVim(value: "")

    t.doKeys("/", "foo", "\n")
    t.doEx("registers")
    #expect(t.matches("\\/\\s+foo", "", t.notificationText))
  }

  @Test("search_history")
  func u254_search_history() {
    let t = UpstreamVim(value: "")

    t.doKeys("/", "this", "\n")
    t.doKeys("/", "checks", "\n")
    t.doKeys("/", "search", "\n")
    t.doKeys("/", "history", "\n")
    t.doKeys("/", "checks", "\n")
    t.doKeys("/")
    t.doKeys("Up")
    #expect(t.promptValue == "checks")
    t.doKeys("Up")
    #expect(t.promptValue == "history")
    t.doKeys("Up")
    #expect(t.promptValue == "search")
    t.doKeys("Up")
    #expect(t.promptValue == "this")
    t.doKeys("Down")
    #expect(t.promptValue == "search")
  }

  @Test("exCommand_history")
  func u255_exCommand_history() {
    let t = UpstreamVim(value: "")

    t.doEx("registers")
    t.doEx("sort")
    t.doEx("map")
    t.doEx("invalid")
    t.doKeys(":")
    t.doKeys("Up")
    #expect(t.promptValue == "invalid")
    t.doKeys("Up")
    #expect(t.promptValue == "map")
    t.doKeys("Up")
    #expect(t.promptValue == "sort")
    t.doKeys("Up")
    #expect(t.promptValue == "registers")
    t.doKeys("<Esc>", ":")
    t.doKeys("s")
    #expect(t.promptValue == "s")
    t.doKeys("Up")
    #expect(t.promptValue == "sort")
  }

  @Test("search_clear")
  func u256_search_clear() {
    let t = UpstreamVim()

    t.doKeys("/", "foo")
    #expect(t.promptValue == "foo")
    t.doKeys("<C-u>")
    #expect(t.promptValue == "")
  }

  @Test("exCommand_clear")
  func u257_exCommand_clear() {
    let t = UpstreamVim()

    t.doKeys(":", "foo")
    #expect(t.promptValue == "foo")
    t.doKeys("<C-u>")
    #expect(t.promptValue == "")
  }

  @Test("._repeat")
  func u258_repeat() {
    let t = UpstreamVim(value: "1 2 3 4 5 6")

    t.setCursor(0, 0)
    t.doKeys("2", "d", "w")
    t.doKeys("3", ".")
    #expect("6" == t.value)
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

  @Test("._startinsert")
  func u260_startinsert() {
    let t = UpstreamVim(value: "x")

    t.doEx("map i x")
    t.doKeys("i")
    #expect("" == t.value)
    t.doEx("start")
    t.doKeys("test")
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("testestt" == t.value)
    t.assertCursorAt(0, 6)
    t.doEx("start!")
    t.doKeys("xyz")
    #expect("testesttxyz" == t.value)
    t.assertCursorAt(0, 11)
  }

  @Test("._insert_repeat")
  func u261_insert_repeat() {
    let t = UpstreamVim(value: "")

    t.doKeys("i")
    t.doKeys("test")
    t.setCursor(0, 4)
    t.doKeys("<Esc>")
    t.doKeys("2", ".")
    #expect("testesttestt" == t.value)
    t.assertCursorAt(0, 10)
  }

  @Test("._repeat_insert")
  func u262_repeat_insert() {
    let t = UpstreamVim(value: "")

    t.doKeys("3", "i")
    t.doKeys("te")
    t.setCursor(0, 2)
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("tetettetetee" == t.value)
    t.assertCursorAt(0, 10)
  }

  @Test("._insert_o")
  func u263_insert_o() {
    let t = UpstreamVim(value: "")

    t.doKeys("o")
    t.doKeys("z")
    t.setCursor(1, 1)
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("\nz\nz" == t.value)
    t.assertCursorAt(2, 0)
  }

  @Test("._insert_o_repeat")
  func u264_insert_o_repeat() {
    let t = UpstreamVim(value: "")

    t.doKeys("o")
    t.doKeys("z")
    t.doKeys("<Esc>")
    t.setCursor(1, 0)
    t.doKeys("2", ".")
    #expect("\nz\nz\nz" == t.value)
    t.assertCursorAt(3, 0)
  }

  @Test("._insert_cw")
  func u266_insert_cw() {
    let t = UpstreamVim(value: "word1 word2 word3")

    t.doKeys("c", "w")
    t.doKeys("test")
    t.doKeys("<Esc>")
    t.setCursor(0, 3)
    t.doKeys("2", "l")
    t.doKeys(".")
    #expect("test test word3" == t.value)
    t.assertCursorAt(0, 8)
  }

  @Test("._insert_cw_repeat")
  func u267_insert_cw_repeat() {
    let t = UpstreamVim(value: "word1 word2 word3")

    // For some reason, repeat cw in desktop VIM will does not repeat insert mode
    // changes. Will conform to that behavior.
    t.doKeys("c", "w")
    t.doKeys("test")
    t.doKeys("<Esc>")
    t.setCursor(0, 4)
    t.doKeys("l")
    t.doKeys("2", ".")
    #expect("test test" == t.value)
    t.assertCursorAt(0, 8)
  }

  @Test("._delete")
  func u268_delete() {
    let t = UpstreamVim(value: "zabcde")

    t.setCursor(0, 5)
    t.doKeys("i")
    t.doKeys("Backspace")
    t.doKeys("<Esc>")
    t.doKeys(".")
    #expect("zace" == t.value)
    t.assertCursorAt(0, 1)
  }

  @Test("._delete_repeat")
  func u269_delete_repeat() {
    let t = UpstreamVim(value: "zzabcde")

    t.setCursor(0, 6)
    t.doKeys("i")
    t.doKeys("Backspace")
    t.doKeys("<Esc>")
    t.doKeys("2", ".")
    #expect("zzce" == t.value)
    t.assertCursorAt(0, 1)
  }

  @Test("._visual_>")
  func u270_visual() {
    let t = UpstreamVim(value: "1\n2\n3\n4")

    t.setCursor(0, 0)
    t.doKeys("V", "j", ">")
    t.setCursor(2, 0)
    t.doKeys(".")
    #expect("  1\n  2\n  3\n  4" == t.value)
    t.assertCursorAt(2, 2)
  }

  @Test("._replace_repeat")
  func u271_replace_repeat() {
    let t = UpstreamVim(value: "abcdef\nabcdefg")

    t.doKeys("R")
    t.replaceRange("123", t.cursor, t.cursor.offsetting(0, 3))
    t.setCursor(0, 3)
    t.doKeys("<Esc>")
    t.doKeys("2", ".")
    #expect("12123123\nabcdefg" == t.value)
    t.assertCursorAt(0, 7)
    t.setCursor(1, 0)
    t.doKeys(".")
    #expect("12123123\n123123g" == t.value)
    t.doKeys("l", "\"", ".", "p")
    #expect("12123123\n123123g123" == t.value)
  }

  @Test("f;")
  func u272_f() {
    let t = UpstreamVim(value: "01x3xx678x")

    t.setCursor(0, 0)
    t.doKeys("f", "x")
    t.doKeys(";")
    t.doKeys("2", ";")
    #expect(9 == t.cursor.ch)
  }

  @Test("F;")
  func u273_F() {
    let t = UpstreamVim(value: "01x3xx6x8x")

    t.setCursor(0, 8)
    t.doKeys("F", "x")
    t.doKeys(";")
    t.doKeys("2", ";")
    #expect(2 == t.cursor.ch)
  }

  @Test("t;")
  func u274_t() {
    let t = UpstreamVim(value: "01x3xx678x")

    t.setCursor(0, 0)
    t.doKeys("t", "x")
    t.doKeys(";")
    t.doKeys("2", ";")
    #expect(8 == t.cursor.ch)
  }

  @Test("T;")
  func u275_T() {
    let t = UpstreamVim(value: "0xx3xx678x")

    t.setCursor(0, 9)
    t.doKeys("T", "x")
    t.doKeys(";")
    t.doKeys("2", ";")
    #expect(2 == t.cursor.ch)
  }

  @Test("f,")
  func u276_f() {
    let t = UpstreamVim(value: "01x3xx678x")

    t.setCursor(0, 6)
    t.doKeys("f", "x")
    t.doKeys(",")
    t.doKeys("2", ",")
    #expect(2 == t.cursor.ch)
  }

  @Test("F,")
  func u277_F() {
    let t = UpstreamVim(value: "01x3xx678x")

    t.setCursor(0, 3)
    t.doKeys("F", "x")
    t.doKeys(",")
    t.doKeys("2", ",")
    #expect(9 == t.cursor.ch)
  }

  @Test("t,")
  func u278_t() {
    let t = UpstreamVim(value: "01x3xx678x")

    t.setCursor(0, 6)
    t.doKeys("t", "x")
    t.doKeys(",")
    t.doKeys("2", ",")
    #expect(3 == t.cursor.ch)
  }

  @Test("T,")
  func u279_T() {
    let t = UpstreamVim(value: "01x3xx67xx")

    t.setCursor(0, 4)
    t.doKeys("T", "x")
    t.doKeys(",")
    t.doKeys("2", ",")
    #expect(8 == t.cursor.ch)
  }

  @Test("fd,;")
  func u280_fd() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("f", "4")
    t.setCursor(0, 0)
    t.doKeys("d", ";")
    #expect("56789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("d", ",")
    #expect("01239" == t.value)
  }

  @Test("Fd,;")
  func u281_Fd() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("F", "4")
    t.setCursor(0, 9)
    t.doKeys("d", ";")
    #expect("01239" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("d", ",")
    #expect("56789" == t.value)
  }

  @Test("td,;")
  func u282_td() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("t", "4")
    t.setCursor(0, 0)
    t.doKeys("d", ";")
    #expect("456789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("d", ",")
    #expect("012349" == t.value)
  }

  @Test("Td,;")
  func u283_Td() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("T", "4")
    t.setCursor(0, 9)
    t.doKeys("d", ";")
    #expect("012349" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("d", ",")
    #expect("456789" == t.value)
  }

  @Test("fc,;")
  func u284_fc() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("f", "4")
    t.setCursor(0, 0)
    t.doKeys("c", ";", "<Esc>")
    #expect("56789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("c", ",")
    #expect("01239" == t.value)
  }

  @Test("Fc,;")
  func u285_Fc() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("F", "4")
    t.setCursor(0, 9)
    t.doKeys("c", ";", "<Esc>")
    #expect("01239" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("c", ",")
    #expect("56789" == t.value)
  }

  @Test("tc,;")
  func u286_tc() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("t", "4")
    t.setCursor(0, 0)
    t.doKeys("c", ";", "<Esc>")
    #expect("456789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("c", ",")
    #expect("012349" == t.value)
  }

  @Test("Tc,;")
  func u287_Tc() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("T", "4")
    t.setCursor(0, 9)
    t.doKeys("c", ";", "<Esc>")
    #expect("012349" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("c", ",")
    #expect("456789" == t.value)
  }

  @Test("fy,;")
  func u288_fy() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("f", "4")
    t.setCursor(0, 0)
    t.doKeys("y", ";", "P")
    #expect("012340123456789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("y", ",", "P")
    #expect("012345678456789" == t.value)
  }

  @Test("Fy,;")
  func u289_Fy() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("F", "4")
    t.setCursor(0, 9)
    t.doKeys("y", ";", "p")
    #expect("012345678945678" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("y", ",", "P")
    #expect("012340123456789" == t.value)
  }

  @Test("ty,;")
  func u290_ty() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 0)
    t.doKeys("t", "4")
    t.setCursor(0, 0)
    t.doKeys("y", ";", "P")
    #expect("01230123456789" == t.value)
    t.doKeys("u")
    t.setCursor(0, 9)
    t.doKeys("y", ",", "p")
    #expect("01234567895678" == t.value)
  }

  @Test("Ty,;")
  func u291_Ty() {
    let t = UpstreamVim(value: "0123456789")

    t.setCursor(0, 9)
    t.doKeys("T", "4")
    t.setCursor(0, 9)
    t.doKeys("y", ";", "p")
    #expect("01234567895678" == t.value)
    t.doKeys("u")
    t.setCursor(0, 0)
    t.doKeys("y", ",", "P")
    #expect("01230123456789" == t.value)
  }

  @Test("vFT")
  func u292_vFT() {
    let t = UpstreamVim(value: "1123 123 123")

    t.setCursor(0, 0)
    t.doKeys("v", "f", "1")
    t.assertCursorAt(0, 2)
    t.doKeys("2", "t", " ")
    t.assertCursorAt(0, 8)
    #expect(VimPosition(0, 0) == t.cm.getCursor(.anchor))
    t.doKeys("<Esc>")
    #expect(VimPosition(0, 7) == t.cm.getCursor(.anchor))
    t.doKeys("v", "F", "3")
    t.assertCursorAt(0, 3)
    #expect(VimPosition(0, 8) == t.cm.getCursor(.anchor))
    t.doKeys("T", "1")
    t.assertCursorAt(0, 2)
    t.doKeys("F", "1")
    t.assertCursorAt(0, 1)
    t.doKeys("F", "1")
    t.assertCursorAt(0, 0)
  }

  @Test("vf,;")
  func u293_vf() {
    let t = UpstreamVim(value: "ab.cd.ef.g")

    t.doKeys("0", "v")
    t.doKeys("f", ".")
    #expect("ab." == t.selection)
    t.doKeys(";")
    #expect("ab.cd." == t.selection)
    t.doKeys(";")
    #expect("ab.cd.ef." == t.selection)
    t.doKeys(",")
    #expect("ab.cd." == t.selection)
    t.doKeys(";")
    #expect("ab.cd.ef." == t.selection)
    t.doKeys("2", ",")
    #expect("ab." == t.selection)
    t.doKeys("2", ",")
    #expect("ab." == t.selection)
  }

  @Test("moveTillCharacter")
  func u294_moveTillCharacter() {
    let t = UpstreamVim(value: "The quick brown fox \n")

    t.setCursor(0, 0)
    t.doKeys("/", "q", "\n")
    #expect(4 == t.cursor.ch)
    t.doKeys("t")
    t.doKeys("o")
    #expect("The quick brown fox \n" == t.value)
    t.doKeys("d")
    t.doKeys("t")
    t.doKeys("o")
    #expect("The quick bown fox \n" == t.value)
    t.doKeys(".")
    #expect("The quick box \n" == t.value)
    t.doKeys("d")
    t.doKeys("t")
    t.doKeys("q")
    #expect("The quick box \n" == t.value)
    t.doKeys("d")
    t.doKeys("t")
    t.doKeys("z")
    #expect("The quick box \n" == t.value)
    t.doKeys("d")
    t.doKeys("N")
    #expect("The ox \n" == t.value)
    #expect(4 == t.cursor.ch)
  }

  @Test("searchForPipe")
  func u295_searchForPipe() {
    let t = UpstreamVim(value: "this|that")

    try? t.vim.setOption("pcre", false)
    t.setCursor(0, 0)
    t.doKeys("/", "|", "\n")
    #expect(4 == t.cursor.ch)
  }

  @Test("[[, ]]")
  func u296_x() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(0, 0)
    t.doKeys("]", "]")
    t.assertCursorAt(9, 0)
    t.doKeys("2", "]", "]")
    t.assertCursorAt(13, 0)
    t.doKeys("]", "]")
    t.assertCursorAt(17, 0)
    t.doKeys("[", "[")
    t.assertCursorAt(13, 0)
    t.doKeys("2", "[", "[")
    t.assertCursorAt(9, 0)
    t.doKeys("[", "[")
    t.assertCursorAt(0, 0)
  }

  @Test("[], ][")
  func u297_x() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(0, 0)
    t.doKeys("]", "[")
    t.assertCursorAt(12, 0)
    t.doKeys("2", "]", "[")
    t.assertCursorAt(16, 0)
    t.doKeys("]", "[")
    t.assertCursorAt(17, 0)
    t.doKeys("[", "]")
    t.assertCursorAt(16, 0)
    t.doKeys("2", "[", "]")
    t.assertCursorAt(12, 0)
    t.doKeys("[", "]")
    t.assertCursorAt(0, 0)
  }

  @Test("[{, ]}")
  func u298_x() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(4, 10)
    t.doKeys("[", "{")
    t.assertCursorAt(2, 12)
    t.doKeys("2", "[", "{")
    t.assertCursorAt(0, 1)
    t.setCursor(4, 10)
    t.doKeys("]", "}")
    t.assertCursorAt(6, 11)
    t.doKeys("2", "]", "}")
    t.assertCursorAt(8, 1)
    t.setCursor(0, 1)
    t.doKeys("]", "}")
    t.assertCursorAt(8, 1)
    t.doKeys("[", "{")
    t.assertCursorAt(0, 1)
  }

  @Test("[(, ])")
  func u299_x() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(4, 10)
    t.doKeys("[", "(")
    t.assertCursorAt(3, 14)
    t.doKeys("2", "[", "(")
    t.assertCursorAt(0, 0)
    t.setCursor(4, 10)
    t.doKeys("]", ")")
    t.assertCursorAt(5, 11)
    t.doKeys("2", "]", ")")
    t.assertCursorAt(8, 0)
    t.doKeys("[", "(")
    t.assertCursorAt(0, 0)
    t.doKeys("]", ")")
    t.assertCursorAt(8, 0)
  }

  @Test("[#, ]#")
  func u300_x() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(10, 3)
    t.doKeys("2", "[", "#")
    t.assertCursorAt(4, 0)
    t.doKeys("5", "]", "#")
    t.assertCursorAt(17, 0)
    t.setCursor(10, 3)
    t.doKeys("]", "#")
    t.assertCursorAt(14, 0)
  }

  @Test("[m, ]m, [M, ]M")
  func u301_m_m_M_M() {
    let t = UpstreamVim(value: "({\n  ({\n  /*comment {\n            */(\n#else                \n  /*       )\n#if        }\n  )}*/\n)}\n{}\n#else {{\n{}\n}\n{\n#endif\n}\n}\n#else")

    t.setCursor(11, 0)
    t.doKeys("[", "m")
    t.assertCursorAt(10, 7)
    t.doKeys("4", "[", "m")
    t.assertCursorAt(1, 3)
    t.doKeys("5", "]", "m")
    t.assertCursorAt(11, 0)
    t.doKeys("[", "M")
    t.assertCursorAt(9, 1)
    t.doKeys("3", "]", "M")
    t.assertCursorAt(15, 0)
    t.doKeys("5", "[", "M")
    t.assertCursorAt(7, 3)
  }

  @Test("i_indent_right")
  func u302_i_indent_right() {
    let t = UpstreamVim(value: " word1\nword2\nword3 ", indentUnit: 2)

    t.setCursor(0, 3)
    let expectedValue = "   word1\nword2\nword3 "
    t.doKeys("i", "<C-t>")
    #expect(expectedValue == t.value)
    t.assertCursorAt(0, 5)
  }

  @Test("i_indent_left")
  func u303_i_indent_left() {
    let t = UpstreamVim(value: "   word1\nword2\nword3 ", indentUnit: 2)

    t.setCursor(0, 3)
    let expectedValue = " word1\nword2\nword3 "
    t.doKeys("i", "<C-d>")
    #expect(expectedValue == t.value)
    t.assertCursorAt(0, 1)
  }

  @Test("ex_go_to_line")
  func u304_ex_go_to_line() {
    let t = UpstreamVim(value: "a\nb\nc\nd\ne\n")

    t.setCursor(0, 0)
    t.doEx("4")
    t.assertCursorAt(3, 0)
    t.doEx("4-1")
    t.assertCursorAt(2, 0)
  }

  @Test("ex_go_to_mark")
  func u305_ex_go_to_mark() {
    let t = UpstreamVim(value: "a\nb\nc\nd\ne\n")

    t.setCursor(3, 0)
    t.doKeys("m", "a")
    t.setCursor(0, 0)
    t.doEx("'a")
    t.assertCursorAt(3, 0)
  }

  @Test("ex_go_to_line_offset")
  func u306_ex_go_to_line_offset() {
    let t = UpstreamVim(value: "a\nb\nc\nd\ne\n")

    t.setCursor(0, 0)
    t.doEx("+3")
    t.assertCursorAt(3, 0)
    t.doEx("-1")
    t.assertCursorAt(2, 0)
    t.doEx(".2")
    t.assertCursorAt(4, 0)
    t.doEx(".-3")
    t.assertCursorAt(1, 0)
  }

  @Test("ex_go_to_mark_offset")
  func u307_ex_go_to_mark_offset() {
    let t = UpstreamVim(value: "a\nb\nc\nd\ne\n")

    t.setCursor(2, 0)
    t.doKeys("m", "a")
    t.setCursor(0, 0)
    t.doEx("'a1")
    t.assertCursorAt(3, 0)
    t.doEx("'a-1")
    t.assertCursorAt(1, 0)
    t.doEx("'a+2")
    t.assertCursorAt(4, 0)
  }

  @Test("ex_delete")
  func u308_ex_delete() {
    let t = UpstreamVim(value: "l 1\nl 2\nl 3\nl 4\n")

    t.doKeys("j")
    t.doEx("delete")
    #expect("l 1\nl 3\nl 4\n" == t.value)
    t.doEx("d")
    #expect("l 1\nl 4\n" == t.value)
  }

  @Test("ex_sort")
  func u309_ex_sort() {
    let t = UpstreamVim(value: "b\nZ\nd\nc\na")

    t.doEx("sort")
    #expect("Z\na\nb\nc\nd" == t.value)
  }

  @Test("ex_sort_reverse")
  func u310_ex_sort_reverse() {
    let t = UpstreamVim(value: "b\nd\nc\na")

    t.doEx("sort!")
    #expect("d\nc\nb\na" == t.value)
  }

  @Test("ex_sort_range")
  func u311_ex_sort_range() {
    let t = UpstreamVim(value: "b\nd\nc\na")

    t.doEx("2,3sort")
    #expect("b\nc\nd\na" == t.value)
  }

  @Test("ex_sort_oneline")
  func u312_ex_sort_oneline() {
    let t = UpstreamVim(value: "b\nd\nc\na")

    t.doEx("2sort")
    #expect("b\nd\nc\na" == t.value)
  }

  @Test("ex_sort_ignoreCase")
  func u313_ex_sort_ignoreCase() {
    let t = UpstreamVim(value: "b\nZ\nd\nc\na")

    t.doEx("sort i")
    #expect("a\nb\nc\nd\nZ" == t.value)
  }

  @Test("ex_sort_unique")
  func u314_ex_sort_unique() {
    let t = UpstreamVim(value: "b\nZ\na\na\nd\na\nc\na")

    t.doEx("sort u")
    #expect("Z\na\nb\nc\nd" == t.value)
  }

  @Test("ex_sort_decimal")
  func u315_ex_sort_decimal() {
    let t = UpstreamVim(value: "6\nd3\n s5\n.9")

    t.doEx("sort d")
    #expect("d3\n s5\n6\n.9" == t.value)
  }

  @Test("ex_sort_decimal_negative")
  func u316_ex_sort_decimal_negative() {
    let t = UpstreamVim(value: "6\nd3\n s5\n.9\nz-9")

    t.doEx("sort d")
    #expect("z-9\nd3\n s5\n6\n.9" == t.value)
  }

  @Test("ex_sort_decimal_reverse")
  func u317_ex_sort_decimal_reverse() {
    let t = UpstreamVim(value: "6\nd3\n s5\n.9")

    t.doEx("sort! d")
    #expect(".9\n6\n s5\nd3" == t.value)
  }

  @Test("ex_sort_hex")
  func u318_ex_sort_hex() {
    let t = UpstreamVim(value: "6\nd3\n s5\n&0xB\n.9")

    t.doEx("sort x")
    #expect((" s5\n6\n.9\n&0xB\nd3") == t.value)
  }

  @Test("ex_sort_octal")
  func u319_ex_sort_octal() {
    let t = UpstreamVim(value: "6\nd3\n s5\n.9\n.8")

    t.doEx("sort o")
    #expect(".9\n.8\nd3\n s5\n6" == t.value)
  }

  @Test("ex_sort_decimal_mixed")
  func u320_ex_sort_decimal_mixed() {
    let t = UpstreamVim(value: "a3\nz\nc1\ny\nb2")

    t.doEx("sort d")
    #expect("z\ny\nc1\nb2\na3" == t.value)
  }

  @Test("ex_sort_decimal_mixed_reverse")
  func u321_ex_sort_decimal_mixed_reverse() {
    let t = UpstreamVim(value: "a3\nz\nc1\ny\nb2")

    t.doEx("sort! d")
    #expect("a3\nb2\nc1\nz\ny" == t.value)
  }

  @Test("ex_sort_pattern_alpha")
  func u322_ex_sort_pattern_alpha() {
    let t = UpstreamVim(value: "z\ny\nc1\nb2\na3")

    t.doEx("sort r/[a-z]/")
    #expect("a3\nb2\nc1\ny\nz" == t.value)
  }

  @Test("ex_sort_pattern_alpha_reverse")
  func u323_ex_sort_pattern_alpha_reverse() {
    let t = UpstreamVim(value: "z\ny\nc1\nb2\na3")

    t.doEx("sort! r /[a-z]/")
    #expect("z\ny\nc1\nb2\na3" == t.value)
  }

  @Test("ex_sort_pattern_alpha_ignoreCase")
  func u324_ex_sort_pattern_alpha_ignoreCase() {
    let t = UpstreamVim(value: "z\nY\nC1\nb2\na3")

    t.doEx("sort ri/[a-z]/")
    #expect("a3\nb2\nC1\nY\nz" == t.value)
  }

  @Test("ex_sort_pattern_alpha_longer")
  func u325_ex_sort_pattern_alpha_longer() {
    let t = UpstreamVim(value: "z\nab\naa\nade\nadelle\nalexandra\nalex\nadriana\nadele\ny\nc\nb\na")

    t.doEx("sort r/[a-z]+/")
    #expect("a\naa\nab\nade\nadele\nadelle\nadriana\nalex\nalexandra\nb\nc\ny\nz" == t.value)
  }

  @Test("ex_sort_pattern_alpha_only")
  func u326_ex_sort_pattern_alpha_only() {
    let t = UpstreamVim(value: "z1\ny2\na3\nc\nb")

    t.doEx("sort r/^[a-z]$/")
    #expect("z1\ny2\na3\nb\nc" == t.value)
  }

  @Test("ex_sort_pattern_alpha_only_reverse")
  func u327_ex_sort_pattern_alpha_only_reverse() {
    let t = UpstreamVim(value: "z1\ny2\na3\nc\nb")

    t.doEx("sort! r/^[a-z]$/")
    #expect("c\nb\nz1\ny2\na3" == t.value)
  }

  @Test("ex_sort_pattern_alpha_num")
  func u328_ex_sort_pattern_alpha_num() {
    let t = UpstreamVim(value: "z1\ny2\na3\nc\nb")

    t.doEx("sort r/[a-z][0-9]/")
    #expect("c\nb\na3\ny2\nz1" == t.value)
  }

  @Test("ex_sort_pattern_no_r")
  func u329_ex_sort_pattern_no_r() {
    let t = UpstreamVim(value: "1 in c \n z \n2 in d \n in\n3 in a \n")

    t.doEx("sort /in/")
    #expect(" z \n in\n\n3 in a \n1 in c \n2 in d " == t.value)
    t.doEx("sort r/in/")
    #expect(" z \n\n in\n3 in a \n1 in c \n2 in d " == t.value)
    t.doEx("sort r/. in/")
    #expect(" z \n\n in\n1 in c \n2 in d \n3 in a " == t.value)
    t.doEx("sort /./")
    #expect("\n3 in a \n1 in c \n2 in d \n in\n z " == t.value)
    t.doEx("sort /in d/")
    #expect("\n3 in a \n1 in c \n in\n z \n2 in d " == t.value)
  }

  @Test("ex_global")
  func u330_ex_global() {
    let t = UpstreamVim(value: "one one\n one one\n one one")

    t.setCursor(0, 0)
    t.doEx("g/one/s//two")
    #expect("two one\n two one\n two one" == t.value)
    t.doEx("1,2g/two/s//one")
    #expect("one one\n one one\n two one" == t.value)
    t.doEx("g/^ /")
    #expect(" one one\n two one" == t.notificationText)
  }

  @Test("ex_normal")
  func u331_ex_normal() {
    let t = UpstreamVim(value: "one one\nx\none\none one")

    t.doEx("norm /<Esc>\"/p")
    t.doEx("norm /x<Cr>\"/p")
    t.doEx("norm /h<Esc>\"/p")
    t.doEx("norm /one<Cr>3li<Right> <Esc>\"/p")
    #expect("one one\nxxx\none one\none one" == t.value)
    t.setCursor(0, 0)
    t.doEx("g/one/normal    cw 1<lt>Esc><Esc>$i$")
    t.doKeys("rt")
    #expect((" 1<Esc> on$e\nxxx\n 1<Esc> on$e\n 1<Esc> on$t") == t.value)
    t.doKeys("/", "<", "\n")
    t.doKeys("x", "x", "p")
    #expect((" 1sEc> on$e\nxxx\n 1<Esc> on$e\n 1<Esc> on$t") == t.value)
    t.setCursor(0, 0)
    t.doEx("map k j")
    t.doEx("normal kkk")
    t.assertCursorAt(3, 0)
    t.doEx("normal! kkk")
    t.assertCursorAt(0, 0)
  }

  @Test("ex_global_substitute_join")
  func u332_ex_global_substitute_join() {
    let t = UpstreamVim(value: "one\ntwo\nthree\nfour\nfive\n")

    t.doEx("g/o/s/\\n/;")
    #expect(("one;two\nthree\nfour;five\n") == t.value)
  }

  @Test("ex_global_substitute_split")
  func u333_ex_global_substitute_split() {
    let t = UpstreamVim(value: "one\ntwo\nthree\nfour\nfive\n")

    t.doEx("g/e/s/[or]/\\n")
    #expect("\nne\ntwo\nth\nee\nfour\nfive\n" == t.value)
  }

  @Test("ex_global_delete")
  func u334_ex_global_delete() {
    let t = UpstreamVim(value: "one\ntwo\nthree\nfour\nfive\nsix\nseven\nnine\n---")

    t.doEx("g/e/d\\n")
    #expect("two\nfour\nsix\n---" == t.value)
    t.doKeys("u")
    t.doEx("g/e/g/v/d\\n")
    #expect("one\ntwo\nthree\nfour\nsix\nnine\n---" == t.value)
  }

  @Test("ex_global_confirm")
  func u335_ex_global_confirm() {
    let t = UpstreamVim(value: "one one\n one one\n one one\n one one\n one one")

    t.setCursor(0, 0)
    t.doEx("g/one/s//two/gc")
    t.doKeys("n")
    t.doKeys("y")
    t.doKeys("a")
    t.doKeys("q")
    t.doKeys("y")
    #expect("one two\n two two\n one one\n two one\n one one" == t.value)
  }

  @Test("ex_vglobal")
  func u336_ex_vglobal() {
    let t = UpstreamVim(value: "one\n two\n three\n four\n five\n")

    t.doEx("v/e/s/o/e")
    #expect("one\n twe\n three\n feur\n five\n" == t.value)
    t.doEx("v/[vw]")
    #expect("one\n three\n feur\n" == t.notificationText)
  }

  @Test("ex_substitute_same_line")
  func u337_ex_substitute_same_line() {
    let t = UpstreamVim(value: "one one\n one one")

    t.setCursor(1, 0)
    t.doEx("s/one/two/g")
    #expect("one one\n two two" == t.value)
  }

  @Test("ex_substitute_alternate_separator")
  func u338_ex_substitute_alternate_separator() {
    let t = UpstreamVim(value: "o/e o/e\n o/e o/e")

    t.setCursor(1, 0)
    t.doEx("s#o/e#two#g")
    #expect(("o/e o/e\n two two") == t.value)
  }

  @Test("ex_substitute_full_file")
  func u339_ex_substitute_full_file() {
    let t = UpstreamVim(value: "one one\n one one")

    t.setCursor(1, 0)
    t.doEx("%s/one/two/g")
    #expect("two two\n two two" == t.value)
  }

  @Test("ex_substitute_input_range")
  func u340_ex_substitute_input_range() {
    let t = UpstreamVim(value: "1\n2\n3\n4")

    t.setCursor(1, 0)
    t.doEx("1,3s/\\d/0/g")
    #expect("0\n0\n0\n4" == t.value)
  }

  @Test("ex_substitute_range_current_to_input")
  func u341_ex_substitute_range_current_to_input() {
    let t = UpstreamVim(value: "1\n2\n3\n4")

    t.setCursor(1, 0)
    t.doEx(".,3s/\\d/0/g")
    #expect("1\n0\n0\n4" == t.value)
  }

  @Test("ex_substitute_range_input_to_current")
  func u342_ex_substitute_range_input_to_current() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(3, 0)
    t.doEx("2,.s/\\d/0/g")
    #expect("1\n0\n0\n0\n5" == t.value)
  }

  @Test("ex_substitute_range_offset")
  func u343_ex_substitute_range_offset() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(2, 0)
    t.doEx("-1,+1s/\\d/0/g")
    #expect("1\n0\n0\n0\n5" == t.value)
  }

  @Test("ex_substitute_range_implicit_offset")
  func u344_ex_substitute_range_implicit_offset() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(0, 0)
    t.doEx(".1,.3s/\\d/0/g")
    #expect("1\n0\n0\n0\n5" == t.value)
  }

  @Test("ex_substitute_to_eof")
  func u345_ex_substitute_to_eof() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(2, 0)
    t.doEx(".,$s/\\d/0/g")
    #expect("1\n2\n0\n0\n0" == t.value)
  }

  @Test("ex_substitute_to_relative_eof")
  func u346_ex_substitute_to_relative_eof() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(4, 0)
    t.doEx("2,$-2s/\\d/0/g")
    #expect("1\n0\n0\n4\n5" == t.value)
  }

  @Test("ex_substitute_range_mark")
  func u347_ex_substitute_range_mark() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(2, 0)
    t.doKeys("ma")
    t.setCursor(0, 0)
    t.doEx(".,'as/\\d/0/g")
    #expect("0\n0\n0\n4\n5" == t.value)
  }

  @Test("ex_substitute_range_mark_offset")
  func u348_ex_substitute_range_mark_offset() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(2, 0)
    t.doKeys("ma")
    t.setCursor(0, 0)
    t.doEx("'a-1,'a+1s/\\d/0/g")
    #expect("1\n0\n0\n0\n5" == t.value)
  }

  @Test("ex_substitute_visual_range")
  func u349_ex_substitute_visual_range() {
    let t = UpstreamVim(value: "1\n2\n3\n4\n5")

    t.setCursor(1, 0)
    t.doKeys("V", "2", "j", "v")
    t.doKeys(":")
    #expect(t.promptValue == ("'<,'>"))
    t.doKeys("s/\\d/0/g", "\n")
    #expect("1\n0\n0\n0\n5" == t.value)
  }

  @Test("ex_substitute_empty_query")
  func u350_ex_substitute_empty_query() {
    let t = UpstreamVim(value: "a11 a12 a13")

    // If the query is empty, use last query.
    t.setCursor(1, 0)
    t.doKeys("/", "1\n")
    t.doEx("s//b/g")
    #expect("abb ab2 ab3" == t.value)
  }

  @Test("ex_substitute_javascript")
  func u351_ex_substitute_javascript() {
    let t = UpstreamVim(value: "a 0 b")

    try? t.vim.setOption("pcre", false)
    t.setCursor(1, 0)
    t.doEx("s/\\(\\d\\+\\)/$$ $' $` $& \\1/g")
    #expect(("a $$ $' $` $& 0 b") == t.value)
    t.setValue("W12345678OR12345D")
    t.doEx("s/\\d//g")
    #expect("WORD" == t.value)
  }

  @Test("ex_substitute_empty_arguments")
  func u352_ex_substitute_empty_arguments() {
    let t = UpstreamVim(value: "a a\na a")

    t.setCursor(0, 0)
    t.doEx("s/a/b/g")
    t.setCursor(1, 0)
    t.doEx("s")
    #expect("b b\nb a" == t.value)
  }

  @Test("ex_substitute_nopcre_special")
  func u354_ex_substitute_nopcre_special() {
    let t = UpstreamVim(value: "")

    try? t.vim.setOption("pcre", false)
    t.setValue("aabb1cxyz$^o aabb2cxyz$^o aabb3cxyz$^o aabb4cxyz$^o ")
    t.doEx("s/" + "\\v<a*(b|\\d){3}c?[x-z]+\\$\\^.> " + "\\V\\<a\\*\\(b\\|\\d\\)\\{3\\}c\\?\\[x-z]\\+$^\\.\\> " + "\\m\\<a*\\(b\\|\\d\\)\\{3}c\\?[x-z]\\+\\$\\^.\\> " + "\\M\\<a\\*\\(b\\|\\d\\)\\{3}c\\?\\[x-z]\\+\\$\\^\\.\\>" + "/M\\4 m\\3 V\\2 v\\1/")
    #expect("M4 m3 V2 v1 " == t.value)
    t.setValue("10 12 13 42")
    t.doEx("s/\\m\\(1\\)\\v\\ze(\\d+)/\\2\\1 a\\1/g")
    #expect("01 a10 21 a12 31 a13 42" == t.value)
    t.doEx("s/2\\zs\\>/b/g")
    #expect("01 a10 21 a12b 31 a13 42b" == t.value)
    t.doEx("s/\\m\\<\\d\\+ //g")
    #expect("a10 a12b a13 42b" == t.value)
  }

  @Test("ex_substitute_ampersand_pcre")
  func u355_ex_substitute_ampersand_pcre() {
    let t = UpstreamVim(value: "foo")

    t.setCursor(0, 0)
    try? t.vim.setOption("pcre", true)
    t.doEx("%s/foo/namespace.&/")
    #expect("namespace.foo" == t.value)
  }

  @Test("ex_substitute_ampersand_multiple_pcre")
  func u356_ex_substitute_ampersand_multiple_pcre() {
    let t = UpstreamVim(value: "foo\nfzo")

    t.setCursor(0, 0)
    try? t.vim.setOption("pcre", true)
    t.doEx("%s/f.o/namespace.&/")
    #expect("namespace.foo\nnamespace.fzo" == t.value)
  }

  @Test("ex_escaped_ampersand_should_not_substitute_pcre")
  func u357_ex_escaped_ampersand_should_not_substitute_pcre() {
    let t = UpstreamVim(value: "foo")

    t.setCursor(0, 0)
    try? t.vim.setOption("pcre", true)
    t.doEx("%s/foo/namespace.\\&/")
    #expect(("namespace.&") == t.value)
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

  @Test("ex_yank")
  func u359_ex_yank() {
    let t = UpstreamVim()

    let curStart = VimPosition(3, 0)
    t.setCursor(curStart)
    t.doEx("y")
    let register = t.registerController.getRegister(nil)
    let line = t.getLine(3)
    #expect((line + "\n") == register.text.string)
  }

  @Test("set_langmap")
  func u360_set_langmap() {
    let t = UpstreamVim()

    t.doEx("set langmap==j")
    t.setCursor(0, 0)
    t.doKeys("=")
    t.assertCursorAt(1, 0)
  }

  @Test("mapclear")
  func u361_mapclear() {
    let t = UpstreamVim(value: "abc abc")

    try? t.vim.map("w", "l", context: nil)
    t.setCursor(0, 0)
    t.assertCursorAt(0, 0)
    t.doKeys("w")
    t.assertCursorAt(0, 1)
    t.vim.mapclear(context: "visual")
    t.doKeys("v", "w", "v")
    t.assertCursorAt(0, 4)
    t.doKeys("w")
    t.assertCursorAt(0, 5)
  }

  @Test("mapclear_context")
  func u362_mapclear_context() {
    let t = UpstreamVim(value: "abc abc")

    try? t.vim.map("w", "l", context: "normal")
    t.setCursor(0, 0)
    t.assertCursorAt(0, 0)
    t.doKeys("w")
    t.assertCursorAt(0, 1)
    t.vim.mapclear(context: "normal")
    t.doKeys("w")
    t.assertCursorAt(0, 4)
  }

  @Test("ex_map_key2key")
  func u363_ex_map_key2key() {
    let t = UpstreamVim(value: "abc")

    t.doEx("map a x")
    t.doKeys("a")
    t.assertCursorAt(0, 0)
    #expect("bc" == t.value)
  }

  @Test("ex_unmap_key2key")
  func u364_ex_unmap_key2key() {
    let t = UpstreamVim(value: "abc")

    t.doEx("map a x")
    t.doEx("unmap a")
    t.doKeys("a")
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("ex_unmap_key2key_does_not_remove_default")
  func u365_ex_unmap_key2key_does_not_remove_default() {
    let t = UpstreamVim(value: "abc")

    t.doEx("unmap a")
    #expect(t.matches("No such mapping: unmap a", "", t.notificationText))
    t.doKeys("a")
    #expect("vim-insert" == t.option("keyMap"))
  }

  @Test("ex_map_ex2key:")
  func u366_ex_map_ex2key() {
    let t = UpstreamVim(value: "abc")

    t.doEx("map :del x")
    t.doEx("del")
    t.assertCursorAt(0, 0)
    #expect("bc" == t.value)
  }

  @Test("ex_omap")
  func u367_ex_omap() {
    let t = UpstreamVim(value: "hello unfair world")

    t.doKeys("0", "w", "d", "w")
    #expect(t.value == "hello world")
    t.doKeys("u")
    t.doKeys(":", "omap w $\n")
    t.doKeys("0", "w")
    t.assertCursorAt(0, 6)
    t.doKeys("d", "w")
    #expect(t.value == "hello ")
  }

  @Test("ex_nmap")
  func u368_ex_nmap() {
    let t = UpstreamVim(value: "hello\nunfair\nworld")

    t.setCursor(0, 3)
    t.doEx("nmap k gj")
    t.doKeys("k")
    t.assertCursorAt(1, 3)
    t.doKeys("d", "k")
    #expect(t.value == "world")
    t.doKeys("u")
    t.setCursor(1, 3)
    t.doEx("map k gj")
    t.doKeys("d", "k")
    #expect(t.value == "hello\nunfld")
    t.assertCursorAt(1, 3)
    t.doKeys("<Up>")
    t.assertCursorAt(0, 3)
  }

  @Test("ex_map_key2key_from_colon")
  func u369_ex_map_key2key_from_colon() {
    let t = UpstreamVim(value: "abc")

    t.doEx("map : x")
    t.doKeys(":")
    t.assertCursorAt(0, 0)
    #expect("bc" == t.value)
  }

  @Test("map <Esc> in normal mode")
  func u370_map_Esc_in_normal_mode() {
    let t = UpstreamVim()

    try? t.vim.noremap("<Esc>", "i", context: "normal")
    t.doKeys("<Esc>")
    #expect(t.state.insertMode)
    t.doKeys("<Esc>")
    #expect(!t.state.insertMode)
  }

  @Test("noremap")
  func u371_noremap() {
    let t = UpstreamVim(value: "wOrd1")

    t.doEx("noremap ; l")
    t.doEx("map l $")
    t.doEx("map q l")
    t.doKeys("l")
    t.assertCursorAt(0, 4)
    t.setCursor(0, 0)
    t.doKeys("q")
    t.assertCursorAt(0, 4)
    t.setCursor(0, 0)
    #expect("wOrd1" == t.value)
    t.doKeys(";", "r", "1")
    #expect("w1rd1" == t.value)
    t.doKeys("i", ";", "<Esc>")
    #expect(("w;1rd1") == t.value)
    t.doEx("mapclear")
    t.setCursor(0, 0)
    t.doKeys("l")
    t.assertCursorAt(0, 1)
    t.doKeys("x", "p", "l")
    #expect(("w1;rd1") == t.value)
    t.doEx("noremap x \"_x")
    t.doKeys("x", "p")
    #expect(("w1;d;1") == t.value)
    t.doEx("mapclear")
  }

  @Test("noremap_all_mappings")
  func u372_noremap_all_mappings() {
    let t = UpstreamVim(value: "HeY")

    // mapping to 'u' should undo in normal mode and lowercase in visual mode
    try? t.vim.noremap("a", "u", context: nil)
    t.doKeys("y", "y", "p")
    #expect("HeY\nHeY" == t.value)
    t.doKeys("a")
    #expect("HeY" == t.value)
    t.doKeys("V", "a")
    #expect("hey" == t.value)
  }

  @Test("noremap_swap")
  func u373_noremap_swap() {
    let t = UpstreamVim(value: "foo")

    try? t.vim.noremap("i", "a", context: "normal")
    try? t.vim.noremap("a", "i", context: "normal")
    t.setCursor(0, 0)
    t.doKeys("a")
    #expect(VimPosition(0, 0) == t.cursor)
    t.doKeys("<Esc>", "i")
    #expect(VimPosition(0, 1) == t.cursor)
  }

  @Test("noremap_map_interaction")
  func u374_noremap_map_interaction() {
    let t = UpstreamVim(value: "wOrd1\nwOrd2")

    // noremap should clobber map
    try? t.vim.map(";", "l", context: nil)
    try? t.vim.noremap(";", "l", context: nil)
    try? t.vim.map("l", "j", context: nil)
    t.setCursor(0, 0)
    t.doKeys(";")
    #expect(VimPosition(0, 1) == t.cursor)
    t.doKeys("l")
    #expect(VimPosition(1, 1) == t.cursor)
    try? t.vim.map("m", ";", context: nil)
    t.doKeys("m")
    #expect(VimPosition(1, 2) == t.cursor)
  }

  @Test("noremap_map_interaction2")
  func u375_noremap_map_interaction2() {
    let t = UpstreamVim(value: "wOrd1\nwOrd2")

    // map should point to the most recent noremap
    try? t.vim.noremap(";", "l", context: nil)
    try? t.vim.map("m", ";", context: nil)
    try? t.vim.noremap(";", "h", context: nil)
    t.setCursor(0, 0)
    t.doKeys("l")
    #expect(VimPosition(0, 1) == t.cursor)
    t.doKeys("m")
    #expect(VimPosition(0, 0) == t.cursor)
  }

  @Test("gq_and_gw")
  func u376_gq_and_gw() {
    let t = UpstreamVim(value: "wOrd1\nwOrd2")

    t.setValue("1\n2\nhello world\n" + "xxx ".jsRepeat(20) + "\nyyy" + "\n\nnext\nparagraph")
    t.setCursor(2, 5)
    t.doKeys("gqgq")
    t.assertCursorAt(2, 0)
    #expect(t.getLine(2) == "hello world")
    t.doKeys("gqj")
    t.assertCursorAt(3, 0)
    #expect(t.getLine(3) == "xxx xxx xxx ")

    t.doKeys("gq}")
    t.assertCursorAt(4, 0)
    #expect(t.getLine(3) == "xxx xxx xxx yyy")

    t.doKeys("gqG")
    t.doKeys("gqgg")
    t.doKeys(":set tw=15\n")
    t.doKeys("gg", "V", "gq")
    #expect(t.getLine(0) == "1 2 hello world")
    #expect(t.getLine(5) == "xxx xxx xxx xxx yyy")
    t.doKeys(":6\n")
    t.doKeys("gqq")
    #expect(t.getLine(6) == "yyy")
  }

  @Test("beforeSelectionChange")
  func u377_beforeSelectionChange() {
    let t = UpstreamVim(value: "abc")

    t.setCursor(0, 100)
    #expect(t.cm.getCursor(.head) == t.cm.getCursor(.anchor))
  }

  @Test("increment_binary")
  func u378_increment_binary() {
    let t = UpstreamVim(value: "0b000")

    t.setCursor(0, 4)
    t.doKeys("<C-a>")
    #expect("0b001" == t.value)
    t.doKeys("<C-a>")
    #expect("0b010" == t.value)
    t.doKeys("<C-x>")
    #expect("0b001" == t.value)
    t.doKeys("<C-x>")
    #expect("0b000" == t.value)
    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("0b001" == t.value)
    t.doKeys("<C-a>")
    #expect("0b010" == t.value)
    t.doKeys("<C-x>")
    #expect("0b001" == t.value)
    t.doKeys("<C-x>")
    #expect("0b000" == t.value)
  }

  @Test("increment_octal")
  func u379_increment_octal() {
    let t = UpstreamVim(value: "000")

    t.setCursor(0, 2)
    t.doKeys("<C-a>")
    #expect("001" == t.value)
    t.doKeys("<C-a>")
    #expect("002" == t.value)
    t.doKeys("<C-a>")
    #expect("003" == t.value)
    t.doKeys("<C-a>")
    #expect("004" == t.value)
    t.doKeys("<C-a>")
    #expect("005" == t.value)
    t.doKeys("<C-a>")
    #expect("006" == t.value)
    t.doKeys("<C-a>")
    #expect("007" == t.value)
    t.doKeys("<C-a>")
    #expect("010" == t.value)
    t.doKeys("<C-x>")
    #expect("007" == t.value)
    t.doKeys("<C-x>")
    #expect("006" == t.value)
    t.doKeys("<C-x>")
    #expect("005" == t.value)
    t.doKeys("<C-x>")
    #expect("004" == t.value)
    t.doKeys("<C-x>")
    #expect("003" == t.value)
    t.doKeys("<C-x>")
    #expect("002" == t.value)
    t.doKeys("<C-x>")
    #expect("001" == t.value)
    t.doKeys("<C-x>")
    #expect("000" == t.value)
    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("001" == t.value)
    t.doKeys("<C-a>")
    #expect("002" == t.value)
    t.doKeys("<C-x>")
    #expect("001" == t.value)
    t.doKeys("<C-x>")
    #expect("000" == t.value)
  }

  @Test("increment_decimal")
  func u380_increment_decimal() {
    let t = UpstreamVim(value: "100")

    t.setCursor(0, 2)
    t.doKeys("<C-a>")
    #expect("101" == t.value)
    t.doKeys("<C-a>")
    #expect("102" == t.value)
    t.doKeys("<C-a>")
    #expect("103" == t.value)
    t.doKeys("<C-a>")
    #expect("104" == t.value)
    t.doKeys("<C-a>")
    #expect("105" == t.value)
    t.doKeys("<C-a>")
    #expect("106" == t.value)
    t.doKeys("<C-a>")
    #expect("107" == t.value)
    t.doKeys("<C-a>")
    #expect("108" == t.value)
    t.doKeys("<C-a>")
    #expect("109" == t.value)
    t.doKeys("<C-a>")
    #expect("110" == t.value)
    t.doKeys("<C-x>")
    #expect("109" == t.value)
    t.doKeys("<C-x>")
    #expect("108" == t.value)
    t.doKeys("<C-x>")
    #expect("107" == t.value)
    t.doKeys("<C-x>")
    #expect("106" == t.value)
    t.doKeys("<C-x>")
    #expect("105" == t.value)
    t.doKeys("<C-x>")
    #expect("104" == t.value)
    t.doKeys("<C-x>")
    #expect("103" == t.value)
    t.doKeys("<C-x>")
    #expect("102" == t.value)
    t.doKeys("<C-x>")
    #expect("101" == t.value)
    t.doKeys("<C-x>")
    #expect("100" == t.value)
    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("101" == t.value)
    t.doKeys("<C-a>")
    #expect("102" == t.value)
    t.doKeys("<C-x>")
    #expect("101" == t.value)
    t.doKeys("<C-x>")
    #expect("100" == t.value)
  }

  @Test("increment_decimal_single_zero")
  func u381_increment_decimal_single_zero() {
    let t = UpstreamVim(value: "0")

    t.doKeys("<C-a>")
    #expect("1" == t.value)
    t.doKeys("<C-a>")
    #expect("2" == t.value)
    t.doKeys("<C-a>")
    #expect("3" == t.value)
    t.doKeys("<C-a>")
    #expect("4" == t.value)
    t.doKeys("<C-a>")
    #expect("5" == t.value)
    t.doKeys("<C-a>")
    #expect("6" == t.value)
    t.doKeys("<C-a>")
    #expect("7" == t.value)
    t.doKeys("<C-a>")
    #expect("8" == t.value)
    t.doKeys("<C-a>")
    #expect("9" == t.value)
    t.doKeys("<C-a>")
    #expect("10" == t.value)
    t.doKeys("<C-x>")
    #expect("9" == t.value)
    t.doKeys("<C-x>")
    #expect("8" == t.value)
    t.doKeys("<C-x>")
    #expect("7" == t.value)
    t.doKeys("<C-x>")
    #expect("6" == t.value)
    t.doKeys("<C-x>")
    #expect("5" == t.value)
    t.doKeys("<C-x>")
    #expect("4" == t.value)
    t.doKeys("<C-x>")
    #expect("3" == t.value)
    t.doKeys("<C-x>")
    #expect("2" == t.value)
    t.doKeys("<C-x>")
    #expect("1" == t.value)
    t.doKeys("<C-x>")
    #expect("0" == t.value)
    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("1" == t.value)
    t.doKeys("<C-a>")
    #expect("2" == t.value)
    t.doKeys("<C-x>")
    #expect("1" == t.value)
    t.doKeys("<C-x>")
    #expect("0" == t.value)
  }

  @Test("increment_hexadecimal")
  func u382_increment_hexadecimal() {
    let t = UpstreamVim(value: "0x0")

    t.setCursor(0, 2)
    t.doKeys("<C-a>")
    #expect("0x1" == t.value)
    t.doKeys("<C-a>")
    #expect("0x2" == t.value)
    t.doKeys("<C-a>")
    #expect("0x3" == t.value)
    t.doKeys("<C-a>")
    #expect("0x4" == t.value)
    t.doKeys("<C-a>")
    #expect("0x5" == t.value)
    t.doKeys("<C-a>")
    #expect("0x6" == t.value)
    t.doKeys("<C-a>")
    #expect("0x7" == t.value)
    t.doKeys("<C-a>")
    #expect("0x8" == t.value)
    t.doKeys("<C-a>")
    #expect("0x9" == t.value)
    t.doKeys("<C-a>")
    #expect("0xa" == t.value)
    t.doKeys("<C-a>")
    #expect("0xb" == t.value)
    t.doKeys("<C-a>")
    #expect("0xc" == t.value)
    t.doKeys("<C-a>")
    #expect("0xd" == t.value)
    t.doKeys("<C-a>")
    #expect("0xe" == t.value)
    t.doKeys("<C-a>")
    #expect("0xf" == t.value)
    t.doKeys("<C-a>")
    #expect("0x10" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0f" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0e" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0d" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0c" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0b" == t.value)
    t.doKeys("<C-x>")
    #expect("0x0a" == t.value)
    t.doKeys("<C-x>")
    #expect("0x09" == t.value)
    t.doKeys("<C-x>")
    #expect("0x08" == t.value)
    t.doKeys("<C-x>")
    #expect("0x07" == t.value)
    t.doKeys("<C-x>")
    #expect("0x06" == t.value)
    t.doKeys("<C-x>")
    #expect("0x05" == t.value)
    t.doKeys("<C-x>")
    #expect("0x04" == t.value)
    t.doKeys("<C-x>")
    #expect("0x03" == t.value)
    t.doKeys("<C-x>")
    #expect("0x02" == t.value)
    t.doKeys("<C-x>")
    #expect("0x01" == t.value)
    t.doKeys("<C-x>")
    #expect("0x00" == t.value)
    t.setCursor(0, 0)
    t.doKeys("<C-a>")
    #expect("0x01" == t.value)
    t.doKeys("<C-a>")
    #expect("0x02" == t.value)
    t.doKeys("<C-x>")
    #expect("0x01" == t.value)
    t.doKeys("<C-x>")
    #expect("0x00" == t.value)
  }

  @Test("<C-r>_insert_mode")
  func u383_C_r_insert_mode() {
    let t = UpstreamVim(value: "123 456 ")

    t.assertCursorAt(0, 0)
    t.doKeys("d", "w", "A")
    t.doKeys("<C-r>", "-")
    #expect("456 123 " == t.value)
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
