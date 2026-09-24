// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the `testMotion` and `testJumplist` cases, generated from the upstream source.

import Testing

@testable import DailyDoListVim

/// A `testMotion` / `testJumplist` case: keys from `start`, then the cursor must be at `end`.
struct UpstreamMotionCase: Sendable, CustomTestStringConvertible {
  let name: String
  let keys: [String]
  let end: [Int]
  let start: [Int]
  var value: String? = nil

  var testDescription: String { name }
}

@MainActor
@Suite struct UpstreamMotionTests {
  @Test(arguments: motions)
  func motion(_ c: UpstreamMotionCase) {
    let t = UpstreamVim(value: c.value ?? upstreamCode)
    t.setCursor(c.start[0], c.start[1])
    t.doKeys(c.keys)
    t.assertCursorAt(c.end[0], c.end[1])
  }

  @Test(arguments: jumplist)
  func jumplist(_ c: UpstreamMotionCase) {
    let t = UpstreamVim(value: upstreamJumplistScene)
    t.setCursor(c.start[0], c.start[1])
    t.doKeys(c.keys)
    t.assertCursorAt(c.end[0], c.end[1])
  }

  nonisolated static let motions: [UpstreamMotionCase] = [
    UpstreamMotionCase(name: "|", keys: ["|"], end: [0, 0], start: [0, 4]),
    UpstreamMotionCase(name: "|_repeat", keys: ["3", "|"], end: [0, 2], start: [0, 4]),
    UpstreamMotionCase(name: "h", keys: ["h"], end: [0, 0], start: [0, 1]),
    UpstreamMotionCase(name: "h_repeat", keys: ["3", "h"], end: [0, 2], start: [0, 5]),
    UpstreamMotionCase(name: "l", keys: ["l"], end: [0, 1], start: [0, 0]),
    UpstreamMotionCase(name: "Space", keys: ["Space"], end: [0, 1], start: [0, 0]),
    UpstreamMotionCase(name: "l_repeat", keys: ["2", "l"], end: [0, 2], start: [0, 0]),
    UpstreamMotionCase(name: "j", keys: ["j"], end: [1, 5], start: [0, 5]),
    UpstreamMotionCase(name: "j_repeat", keys: ["2", "j"], end: [2, 5], start: [0, 5]),
    UpstreamMotionCase(name: "j_repeat_clip", keys: ["1000", "j"], end: [15, 0], start: [0, 0]),
    UpstreamMotionCase(name: "k", keys: ["k"], end: [0, 5], start: [1, 5]),
    UpstreamMotionCase(name: "k_repeat", keys: ["2", "k"], end: [0, 4], start: [2, 4]),
    UpstreamMotionCase(name: "k_repeat_clip", keys: ["1000", "k"], end: [0, 4], start: [2, 4]),
    UpstreamMotionCase(name: "w", keys: ["w"], end: [0, 1], start: [0, 0]),
    UpstreamMotionCase(
      name: "keepHPos", keys: ["5", "j", "j", "7", "k"], end: [8, 12], start: [12, 12]),
    UpstreamMotionCase(name: "keepHPosEol", keys: ["$", "2", "j"], end: [2, 18], start: [0, 0]),
    UpstreamMotionCase(
      name: "w_multiple_newlines_no_space", keys: ["w"], end: [12, 2], start: [11, 2]),
    UpstreamMotionCase(
      name: "w_multiple_newlines_with_space", keys: ["w"], end: [14, 0], start: [12, 51]),
    UpstreamMotionCase(name: "w_repeat", keys: ["2", "w"], end: [0, 7], start: [0, 0]),
    UpstreamMotionCase(name: "w_wrap", keys: ["w"], end: [1, 1], start: [0, 7]),
    UpstreamMotionCase(name: "w_endOfDocument", keys: ["w"], end: [15, 0], start: [15, 0]),
    UpstreamMotionCase(name: "w_start_to_end", keys: ["1000", "w"], end: [15, 0], start: [0, 0]),
    UpstreamMotionCase(name: "W", keys: ["W"], end: [0, 1], start: [0, 0]),
    UpstreamMotionCase(name: "W_repeat", keys: ["2", "W"], end: [1, 1], start: [0, 1]),
    UpstreamMotionCase(name: "e", keys: ["e"], end: [0, 5], start: [0, 0]),
    UpstreamMotionCase(name: "e_repeat", keys: ["2", "e"], end: [0, 9], start: [0, 0]),
    UpstreamMotionCase(name: "e_wrap", keys: ["e"], end: [1, 5], start: [0, 9]),
    UpstreamMotionCase(name: "e_endOfDocument", keys: ["e"], end: [15, 0], start: [15, 0]),
    UpstreamMotionCase(name: "e_start_to_end", keys: ["1000", "e"], end: [15, 0], start: [0, 0]),
    UpstreamMotionCase(name: "b", keys: ["b"], end: [1, 1], start: [1, 5]),
    UpstreamMotionCase(name: "b_repeat", keys: ["2", "b"], end: [0, 7], start: [1, 5]),
    UpstreamMotionCase(name: "b_wrap", keys: ["b"], end: [0, 7], start: [1, 1]),
    UpstreamMotionCase(name: "b_startOfDocument", keys: ["b"], end: [0, 0], start: [0, 0]),
    UpstreamMotionCase(name: "b_end_to_start", keys: ["1000", "b"], end: [0, 0], start: [15, 0]),
    UpstreamMotionCase(name: "ge", keys: ["g", "e"], end: [0, 9], start: [1, 5]),
    UpstreamMotionCase(name: "ge_repeat", keys: ["2", "g", "e"], end: [0, 5], start: [1, 1]),
    UpstreamMotionCase(name: "ge_wrap", keys: ["g", "e"], end: [0, 9], start: [1, 1]),
    UpstreamMotionCase(name: "ge_startOfDocument", keys: ["g", "e"], end: [0, 0], start: [0, 0]),
    UpstreamMotionCase(
      name: "ge_end_to_start", keys: ["1000", "g", "e"], end: [0, 0], start: [15, 0]),
    UpstreamMotionCase(name: "gg", keys: ["g", "g"], end: [0, 1], start: [3, 1]),
    UpstreamMotionCase(name: "gg_repeat", keys: ["3", "g", "g"], end: [2, 0], start: [0, 0]),
    UpstreamMotionCase(name: "G", keys: ["G"], end: [15, 0], start: [3, 1]),
    UpstreamMotionCase(name: "G_repeat", keys: ["3", "G"], end: [2, 0], start: [0, 0]),
    UpstreamMotionCase(name: "0", keys: ["0"], end: [0, 0], start: [0, 8]),
    UpstreamMotionCase(name: "^", keys: ["^"], end: [0, 1], start: [0, 8]),
    UpstreamMotionCase(name: "+", keys: ["+"], end: [1, 1], start: [0, 8]),
    UpstreamMotionCase(name: "-", keys: ["-"], end: [0, 1], start: [1, 4]),
    UpstreamMotionCase(name: "_", keys: ["6", "_"], end: [5, 2], start: [0, 8]),
    UpstreamMotionCase(name: "$", keys: ["$"], end: [0, 9], start: [0, 1]),
    UpstreamMotionCase(name: "$_repeat", keys: ["2", "$"], end: [1, 7], start: [0, 3]),
    UpstreamMotionCase(name: "$", keys: ["v", "$"], end: [0, 10], start: [0, 1]),
    UpstreamMotionCase(name: "f", keys: ["f", "p"], end: [2, 2], start: [2, 0]),
    UpstreamMotionCase(name: "f_repeat", keys: ["2", "f", "p"], end: [2, 6], start: [2, 2]),
    UpstreamMotionCase(name: "f_num", keys: ["f", "2"], end: [2, 14], start: [2, 0]),
    UpstreamMotionCase(name: "f<S-Space>", keys: ["f", "<S-Space>"], end: [0, 6], start: [0, 1]),
    UpstreamMotionCase(name: "t", keys: ["t", "p"], end: [2, 1], start: [2, 0]),
    UpstreamMotionCase(name: "t_repeat", keys: ["2", "t", "p"], end: [2, 5], start: [2, 2]),
    UpstreamMotionCase(name: "F", keys: ["F", "p"], end: [2, 2], start: [2, 4]),
    UpstreamMotionCase(name: "F_repeat", keys: ["2", "F", "p"], end: [2, 2], start: [2, 6]),
    UpstreamMotionCase(name: "T", keys: ["T", "p"], end: [2, 3], start: [2, 4]),
    UpstreamMotionCase(name: "T_repeat", keys: ["2", "T", "p"], end: [2, 3], start: [2, 6]),
    UpstreamMotionCase(name: "%_parens", keys: ["%"], end: [3, 3], start: [3, 1]),
    UpstreamMotionCase(name: "%_squares", keys: ["%"], end: [3, 7], start: [3, 5]),
    UpstreamMotionCase(name: "%_braces", keys: ["%"], end: [3, 11], start: [3, 9]),
    UpstreamMotionCase(name: "%_seek_outside", keys: ["%"], end: [4, 16], start: [4, 1]),
    UpstreamMotionCase(name: "%_seek_inside", keys: ["%"], end: [4, 11], start: [4, 14]),
    UpstreamMotionCase(
      name: "di(_outside_should_stay", keys: ["d", "i", "("], end: [0, 0], start: [0, 0]),
  ]

  nonisolated static let jumplist: [UpstreamMotionCase] = [
    UpstreamMotionCase(name: "jumplist_H", keys: ["H", "<C-o>"], end: [5, 2], start: [5, 2]),
    UpstreamMotionCase(name: "jumplist_M", keys: ["M", "<C-o>"], end: [2, 2], start: [2, 2]),
    UpstreamMotionCase(name: "jumplist_L", keys: ["L", "<C-o>"], end: [2, 2], start: [2, 2]),
    UpstreamMotionCase(
      name: "jumplist_[[", keys: ["[", "[", "<C-o>"], end: [5, 2], start: [5, 2]),
    UpstreamMotionCase(
      name: "jumplist_]]", keys: ["]", "]", "<C-o>"], end: [2, 2], start: [2, 2]),
    UpstreamMotionCase(name: "jumplist_G", keys: ["G", "<C-o>"], end: [5, 2], start: [5, 2]),
    UpstreamMotionCase(
      name: "jumplist_gg", keys: ["g", "g", "<C-o>"], end: [5, 2], start: [5, 2]),
    UpstreamMotionCase(name: "jumplist_%", keys: ["%", "<C-o>"], end: [1, 5], start: [1, 5]),
    UpstreamMotionCase(name: "jumplist_{", keys: ["{", "<C-o>"], end: [1, 5], start: [1, 5]),
    UpstreamMotionCase(name: "jumplist_}", keys: ["}", "<C-o>"], end: [1, 5], start: [1, 5]),
    UpstreamMotionCase(
      name: "jumplist_'", keys: ["m", "a", "h", "'", "a", "h", "<C-i>"], end: [1, 0], start: [1, 5]),
    UpstreamMotionCase(
      name: "jumplist_`", keys: ["m", "a", "h", "`", "a", "h", "<C-i>"], end: [1, 5], start: [1, 5]),
    UpstreamMotionCase(
      name: "jumplist_*_cachedCursor", keys: ["*", "<C-o>"], end: [1, 3], start: [1, 3]),
    UpstreamMotionCase(
      name: "jumplist_#_cachedCursor", keys: ["#", "<C-o>"], end: [1, 3], start: [1, 3]),
    UpstreamMotionCase(
      name: "jumplist_n", keys: ["#", "n", "<C-o>"], end: [1, 1], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_N", keys: ["#", "N", "<C-o>"], end: [1, 1], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_repeat_<c-o>", keys: ["*", "*", "*", "3", "<C-o>"], end: [2, 3],
      start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_repeat_<c-i>", keys: ["*", "*", "*", "3", "<C-o>", "2", "<C-i>"],
      end: [5, 0], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_repeated_motion", keys: ["3", "*", "<C-o>"], end: [2, 3], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_/", keys: ["/", "dialog\n", "<C-o>"], end: [2, 3], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_?", keys: ["?", "dialog\n", "<C-o>"], end: [2, 3], start: [2, 3]),
    UpstreamMotionCase(
      name: "jumplist_skip_deleted_mark<c-o>",
      keys: ["*", "n", "n", "k", "d", "k", "<C-o>", "<C-o>", "<C-o>"], end: [0, 2], start: [0, 2]),
    UpstreamMotionCase(
      name: "jumplist_skip_deleted_mark<c-i>",
      keys: ["*", "n", "n", "k", "d", "k", "<C-o>", "<C-i>", "<C-i>"], end: [1, 0], start: [0, 2]),
  ]
}
