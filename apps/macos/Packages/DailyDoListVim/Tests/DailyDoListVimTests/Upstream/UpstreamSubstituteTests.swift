// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the `testSubstitute` (with and without 'pcre') and `testSubstituteConfirm` cases, generated from the upstream source.

import Testing

@testable import DailyDoListVim


/// A `testSubstitute` case: from line 1, `:expr` (or `:noPcreExpr` with 'nopcre').
struct UpstreamSubstituteCase: Sendable, CustomTestStringConvertible {
  let name: String
  let value: String
  let expected: String
  let expr: String
  let noPcreExpr: String

  var testDescription: String { name }
}

/// A `testSubstituteConfirm` case: the command, then the confirmation keys one by one.
struct UpstreamConfirmCase: Sendable, CustomTestStringConvertible {
  let name: String
  let command: String
  let value: String
  let expected: String
  let keys: String
  let end: [Int]

  var testDescription: String { name }
}

@MainActor
@Suite struct UpstreamSubstituteTests {
  @Test(arguments: substitutions)
  func pcre(_ c: UpstreamSubstituteCase) throws {
    let t = UpstreamVim(value: c.value)
    t.setCursor(1, 0)
    try t.vim.setOption("pcre", true)
    t.doEx(c.expr)
    #expect(t.value == c.expected)
  }

  @Test(arguments: substitutions)
  func nopcre(_ c: UpstreamSubstituteCase) throws {
    let t = UpstreamVim(value: c.value)
    t.setCursor(1, 0)
    try t.vim.setOption("pcre", false)
    t.doEx(c.noPcreExpr)
    #expect(t.value == c.expected)
  }

  @Test(arguments: confirmations)
  func confirm(_ c: UpstreamConfirmCase) {
    let t = UpstreamVim(value: c.value)
    t.doEx(c.command)
    for key in c.keys { t.doKeys(String(key)) }
    #expect(t.value == c.expected)
    t.assertCursorAt(c.end[0], c.end[1])
  }

  nonisolated static let substitutions: [UpstreamSubstituteCase] = [
    UpstreamSubstituteCase(name: "ex_substitute_capture", value: "a11 a12 a13", expected: "a1111 a1212 a1313", expr: "s/(\\d+)/$1$1/g", noPcreExpr: "s/\\(\\d\\+\\)/\\1\\1/g"),
    UpstreamSubstituteCase(name: "ex_substitute_capture2", value: "a 0 b", expected: "a $00 b", expr: "s/(\\d+)/$$$1$1/g", noPcreExpr: "s/\\(\\d\\+\\)/$\\1\\1/g"),
    UpstreamSubstituteCase(name: "ex_substitute_nocapture", value: "a11 a12 a13", expected: "a$1$1 a$1$1 a$1$1", expr: "s/(\\d+)/$$1$$1/g", noPcreExpr: "s/\\(\\d\\+\\)/$1$1/g"),
    UpstreamSubstituteCase(name: "ex_substitute_nocapture2", value: "a 0 b", expected: "a $10 b", expr: "s/(\\d+)/$$1$1/g", noPcreExpr: "s/\\(\\d\\+\\)/\\$1\\1/g"),
    UpstreamSubstituteCase(name: "ex_substitute_nocapture", value: "a b c", expected: "a $ c", expr: "s/b/$$/", noPcreExpr: "s/b/$/"),
    UpstreamSubstituteCase(name: "ex_substitute_slash_regex", value: "one/two \n three/four", expected: "one|two \n three|four", expr: "%s/\\//|", noPcreExpr: "%s/\\//|"),
    UpstreamSubstituteCase(name: "ex_substitute_pipe_regex", value: "one|two \n three|four", expected: "one,two \n three,four", expr: "%s/\\|/,/", noPcreExpr: "%s/|/,/"),
    UpstreamSubstituteCase(name: "ex_substitute_or_regex", value: "one|two \n three|four", expected: "ana|twa \n thraa|faar", expr: "%s/o|e|u/a/g", noPcreExpr: "%s/o\\|e\\|u/a/g"),
    UpstreamSubstituteCase(name: "ex_substitute_or_word_regex", value: "one|two \n three|four", expected: "five|five \n three|four", expr: "%s/(one|two)/five/g", noPcreExpr: "%s/\\(one\\|two\\)/five/g"),
    UpstreamSubstituteCase(name: "ex_substitute_forward_slash_regex", value: "forward slash / was here", expected: "forward slash  was here", expr: "%s#\\/##g", noPcreExpr: "%s#/##g"),
    UpstreamSubstituteCase(name: "ex_substitute_backslashslash_regex", value: "one\\two \n three\\four", expected: "one,two \n three,four", expr: "%s/\\\\/,", noPcreExpr: "%s/\\\\/,"),
    UpstreamSubstituteCase(name: "ex_substitute_slash_replacement", value: "one,two \n three,four", expected: "one/two \n three/four", expr: "%s/,/\\/", noPcreExpr: "%s/,/\\/"),
    UpstreamSubstituteCase(name: "ex_substitute_backslash_replacement", value: "one,two \n three,four", expected: "one\\two \n three\\four", expr: "%s/,/\\\\/g", noPcreExpr: "%s/,/\\\\/g"),
    UpstreamSubstituteCase(name: "ex_substitute_multibackslash_replacement", value: "one,two \n three,four", expected: "one\\\\\\\\two \n three\\\\\\\\four", expr: "%s/,/\\\\\\\\\\\\\\\\/g", noPcreExpr: "%s/,/\\\\\\\\\\\\\\\\/g"),
    UpstreamSubstituteCase(name: "ex_substitute_dollar_assertion", value: "one,two \n three,four", expected: "one,two ,\n three,four,", expr: "%s/$/,/g", noPcreExpr: "%s/$/,/g"),
    UpstreamSubstituteCase(name: "ex_substitute_dollar_assertion_empty_lines", value: "\n\n\n\n\n\n", expected: ";\n;\n;\n;\n;\n;\n;", expr: "%s/$/;/g", noPcreExpr: "%s/$/;/g"),
    UpstreamSubstituteCase(name: "ex_substitute_dollar_literal", value: "one$two\n$three\nfour$\n$", expected: "one,two\n,three\nfour,\n,", expr: "%s/\\$/,/g", noPcreExpr: "%s/\\$/,/g"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_match", value: "one,two \n three,four", expected: "one,two , three,four", expr: "%s/\\n/,/g", noPcreExpr: "%s/\\n/,/g"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_join_global", value: "one,two \n three,four \n five \n six", expected: "one,two \n three,four , five \n six", expr: "2s/\\n/,/g", noPcreExpr: "2s/\\n/,/g"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_join_noglobal", value: "one,two \n three,four \n five \n six\n", expected: "one,two \n three,four , five , six\n", expr: "2,3s/\\n/,/", noPcreExpr: "2,3s/\\n/,/"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_replacement", value: "one,two, \n three,four,", expected: "one\ntwo\n \n three\nfour\n", expr: "%s/,/\\n/g", noPcreExpr: "%s/,/\\n/g"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_multiple_splits", value: "one,two, \n three,four,five,six, \n seven,", expected: "one,two, \n three\nfour\nfive\nsix\n \n seven,", expr: "2s/,/\\n/g", noPcreExpr: "2s/,/\\n/g"),
    UpstreamSubstituteCase(name: "ex_substitute_newline_first_occurrences", value: "one,two, \n three,four,five,six, \n seven,", expected: "one\ntwo, \n three\nfour,five,six, \n seven\n", expr: "%s/,/\\n/", noPcreExpr: "%s/,/\\n/"),
    UpstreamSubstituteCase(name: "ex_substitute_braces_word", value: "ababab abb ab{2}", expected: "ab abb ab{2}", expr: "%s/(ab){2}//g", noPcreExpr: "%s/\\(ab\\)\\{2\\}//g"),
    UpstreamSubstituteCase(name: "ex_substitute_braces_range", value: "a aa aaa aaaa", expected: "a   a", expr: "%s/a{2,3}//g", noPcreExpr: "%s/a\\{2,3\\}//g"),
    UpstreamSubstituteCase(name: "ex_substitute_braces_literal", value: "ababab abb ab{2}", expected: "ababab abb ", expr: "%s/ab\\{2\\}//g", noPcreExpr: "%s/ab{2}//g"),
    UpstreamSubstituteCase(name: "ex_substitute_braces_char", value: "ababab abb ab{2}", expected: "ababab  ab{2}", expr: "%s/ab{2}//g", noPcreExpr: "%s/ab\\{2\\}//g"),
    UpstreamSubstituteCase(name: "ex_substitute_braces_no_escape", value: "ababab abb ab{2}", expected: "ababab  ab{2}", expr: "%s/ab{2}//g", noPcreExpr: "%s/ab\\{2}//g"),
    UpstreamSubstituteCase(name: "ex_substitute_count", value: "1\n2\n3\n4", expected: "1\n0\n0\n4", expr: "s/\\d/0/i 2", noPcreExpr: "s/\\d/0/i 2"),
    UpstreamSubstituteCase(name: "ex_substitute_count_with_range", value: "1\n2\n3\n4", expected: "1\n2\n0\n0", expr: "1,3s/\\d/0/ 3", noPcreExpr: "1,3s/\\d/0/ 3"),
    UpstreamSubstituteCase(name: "ex_substitute_not_global", value: "aaa\nbaa\ncaa", expected: "xaa\nbxa\ncxa", expr: "%s/a/x/", noPcreExpr: "%s/a/x/"),
    UpstreamSubstituteCase(name: "ex_substitute_optional", value: "aaa  aa\n aa", expected: "<aaa> <> <aa>\n<> <aa>", expr: "%s/(a*)/<$1>/g", noPcreExpr: "%s/\\(a*\\)/<\\1>/g"),
    UpstreamSubstituteCase(name: "ex_substitute_empty_match", value: "aaa  aa\n aa\nbb\n", expected: "<aaa>  <aa>\n <aa>\nbb<>\n<>", expr: "%s/(a+|$)/<$1>/g", noPcreExpr: "%s/\\(a\\+\\|$\\)/<\\1>/g"),
    UpstreamSubstituteCase(name: "ex_substitute_empty_or_match", value: "1234\n567\n89\n0\n", expected: "<12><34>\n<56>7<>\n<89>\n0<>\n<>", expr: "%s/(..|$)/<$1>/g", noPcreExpr: "%s/\\(..\\|$\\)/<\\1>/g"),
  ]

  nonisolated static let confirmations: [UpstreamConfirmCase] = [
    UpstreamConfirmCase(name: "ex_substitute_confirm_emptydoc", command: "%s/x/b/c", value: "", expected: "", keys: "", end: [0, 0]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_nomatch", command: "%s/x/b/c", value: "ba a\nbab", expected: "ba a\nbab", keys: "", end: [0, 0]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_accept", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbbb", keys: "yyy", end: [1, 1]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_random_keys", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbbb", keys: "ysdkywerty", end: [1, 1]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_some", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb a\nbbb", keys: "yny", end: [1, 1]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_all", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbbb", keys: "a", end: [1, 1]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_accept_then_all", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbbb", keys: "ya", end: [1, 1]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_quit", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb a\nbab", keys: "yq", end: [0, 3]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_last", command: "%s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbab", keys: "yl", end: [0, 3]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_oneline", command: "1s/a/b/cg", value: "ba a\nbab", expected: "bb b\nbab", keys: "yl", end: [0, 3]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_range_accept", command: "1,2s/a/b/cg", value: "aa\na \na\na", expected: "bb\nb \na\na", keys: "yyy", end: [1, 0]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_range_some", command: "1,3s/a/b/cg", value: "aa\na \na\na", expected: "ba\nb \nb\na", keys: "ynyy", end: [2, 0]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_range_all", command: "1,3s/a/b/cg", value: "aa\na \na\na", expected: "bb\nb \nb\na", keys: "a", end: [2, 0]),
    UpstreamConfirmCase(name: "ex_substitute_confirm_range_last", command: "1,3s/a/b/cg", value: "aa\na \na\na", expected: "bb\nb \na\na", keys: "yyl", end: [1, 0]),
  ]
}
