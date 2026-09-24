// Ported from vim_test.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the `testEdit` (text objects) and `testSelection` cases, generated from the upstream source.

import Testing

@testable import DailyDoListVim

/// A `testEdit` case: keys at `at` in `before`, then the document must be `after` (or, for
/// `testSelection`, the selection must be `selection`).
struct UpstreamEditCase: Sendable, CustomTestStringConvertible {
  let name: String
  let before: String
  let at: [Int]
  let keys: [String]
  var after: String? = nil
  var selection: String? = nil

  var testDescription: String { name }
}

@MainActor
@Suite struct UpstreamEditTests {
  @Test(arguments: edits)
  func edit(_ c: UpstreamEditCase) {
    let t = UpstreamVim(value: c.before)
    t.setCursor(c.at[0], c.at[1])
    t.doKeys(c.keys)
    #expect(t.value == c.after)
  }

  @Test(arguments: selections)
  func selection(_ c: UpstreamEditCase) {
    let t = UpstreamVim(value: c.before)
    t.setCursor(c.at[0], c.at[1])
    t.doKeys(c.keys)
    #expect(t.selection == c.selection)
  }

  nonisolated static let edits: [UpstreamEditCase] = [
    UpstreamEditCase(
      name: "diw_mid_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["d", "i", "w"],
      after: "foo \t\t baz"),
    UpstreamEditCase(
      name: "daw_mid_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["d", "a", "w"],
      after: "foo \tbaz"),
    UpstreamEditCase(
      name: "diw_mid_punct", before: "foo \tbAr.\t baz", at: [0, 6], keys: ["d", "i", "w"],
      after: "foo \t.\t baz"),
    UpstreamEditCase(
      name: "daw_mid_punct", before: "foo \tbAr.\t baz", at: [0, 6], keys: ["d", "a", "w"],
      after: "foo.\t baz"),
    UpstreamEditCase(
      name: "diw_mid_punct2", before: "foo \t,bAr.\t baz", at: [0, 7], keys: ["d", "i", "w"],
      after: "foo \t,.\t baz"),
    UpstreamEditCase(
      name: "daw_mid_punct2", before: "foo \t,bAr.\t baz", at: [0, 7], keys: ["d", "a", "w"],
      after: "foo \t,.\t baz"),
    UpstreamEditCase(
      name: "diw_start_spc", before: "bAr \tbaz", at: [0, 1], keys: ["d", "i", "w"], after: " \tbaz"
    ),
    UpstreamEditCase(
      name: "daw_start_spc", before: "bAr \tbaz", at: [0, 1], keys: ["d", "a", "w"], after: "baz"),
    UpstreamEditCase(
      name: "diw_start_punct", before: "bAr. \tbaz", at: [0, 1], keys: ["d", "i", "w"],
      after: ". \tbaz"),
    UpstreamEditCase(
      name: "daw_start_punct", before: "bAr. \tbaz", at: [0, 1], keys: ["d", "a", "w"],
      after: ". \tbaz"),
    UpstreamEditCase(
      name: "diw_end_spc", before: "foo \tbAr", at: [0, 6], keys: ["d", "i", "w"], after: "foo \t"),
    UpstreamEditCase(
      name: "daw_end_spc", before: "foo \tbAr", at: [0, 6], keys: ["d", "a", "w"], after: "foo"),
    UpstreamEditCase(
      name: "diw_end_punct", before: "foo \tbAr.", at: [0, 6], keys: ["d", "i", "w"],
      after: "foo \t."),
    UpstreamEditCase(
      name: "daw_end_punct", before: "foo \tbAr.", at: [0, 6], keys: ["d", "a", "w"], after: "foo."),
    UpstreamEditCase(
      name: "diw_space_word1", before: "foo \t\n\tbar.", at: [0, 4], keys: ["d", "i", "w"],
      after: "foo\n\tbar."),
    UpstreamEditCase(
      name: "diw_space_word2", before: "foo +bar.", at: [0, 3], keys: ["d", "i", "w"],
      after: "foo+bar."),
    UpstreamEditCase(
      name: "diw_space_word3", before: " foo bar.", at: [0, 0], keys: ["d", "i", "w"],
      after: "foo bar."),
    UpstreamEditCase(
      name: "diW_mid_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["d", "i", "W"],
      after: "foo \t\t baz"),
    UpstreamEditCase(
      name: "daW_mid_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["d", "a", "W"],
      after: "foo \tbaz"),
    UpstreamEditCase(
      name: "diW_mid_punct", before: "foo \tbAr.\t baz", at: [0, 6], keys: ["d", "i", "W"],
      after: "foo \t\t baz"),
    UpstreamEditCase(
      name: "daW_mid_punct", before: "foo \tbAr.\t baz", at: [0, 6], keys: ["d", "a", "W"],
      after: "foo \tbaz"),
    UpstreamEditCase(
      name: "diW_mid_punct2", before: "foo \t,bAr.\t baz", at: [0, 7], keys: ["d", "i", "W"],
      after: "foo \t\t baz"),
    UpstreamEditCase(
      name: "daW_mid_punct2", before: "foo \t,bAr.\t baz", at: [0, 7], keys: ["d", "a", "W"],
      after: "foo \tbaz"),
    UpstreamEditCase(
      name: "diW_start_spc", before: "bAr\t baz", at: [0, 1], keys: ["d", "i", "W"], after: "\t baz"
    ),
    UpstreamEditCase(
      name: "daW_start_spc", before: "bAr\t baz", at: [0, 1], keys: ["d", "a", "W"], after: "baz"),
    UpstreamEditCase(
      name: "diW_start_punct", before: "bAr.\t baz", at: [0, 1], keys: ["d", "i", "W"],
      after: "\t baz"),
    UpstreamEditCase(
      name: "daW_start_punct", before: "bAr.\t baz", at: [0, 1], keys: ["d", "a", "W"], after: "baz"
    ),
    UpstreamEditCase(
      name: "diW_end_spc", before: "foo \tbAr", at: [0, 6], keys: ["d", "i", "W"], after: "foo \t"),
    UpstreamEditCase(
      name: "daW_end_spc", before: "foo \tbAr", at: [0, 6], keys: ["d", "a", "W"], after: "foo"),
    UpstreamEditCase(
      name: "diW_end_punct", before: "foo \tbAr.", at: [0, 6], keys: ["d", "i", "W"],
      after: "foo \t"),
    UpstreamEditCase(
      name: "daW_end_punct", before: "foo \tbAr.", at: [0, 6], keys: ["d", "a", "W"], after: "foo"),
    UpstreamEditCase(
      name: "diW_space_word2", before: "foo +bar.", at: [0, 3], keys: ["d", "i", "W"],
      after: "foo+bar."),
    UpstreamEditCase(
      name: "di(_open_spc", before: "foo (bAr) baz", at: [0, 4], keys: ["d", "i", "("],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "di)_open_spc", before: "foo (bAr) baz", at: [0, 4], keys: ["d", "i", ")"],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "dib_open_spc", before: "foo (bAr) baz", at: [0, 4], keys: ["d", "i", "b"],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "da(_open_spc", before: "foo (bAr) baz", at: [0, 4], keys: ["d", "a", "("],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "da)_open_spc", before: "foo (bAr) baz", at: [0, 4], keys: ["d", "a", ")"],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "di(_middle_spc", before: "foo (bAr) baz", at: [0, 6], keys: ["d", "i", "("],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "di)_middle_spc", before: "foo (bAr) baz", at: [0, 6], keys: ["d", "i", ")"],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "da(_middle_spc", before: "foo (bAr) baz", at: [0, 6], keys: ["d", "a", "("],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "da)_middle_spc", before: "foo (bAr) baz", at: [0, 6], keys: ["d", "a", ")"],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "di(_close_spc", before: "foo (bAr) baz", at: [0, 8], keys: ["d", "i", "("],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "di)_close_spc", before: "foo (bAr) baz", at: [0, 8], keys: ["d", "i", ")"],
      after: "foo () baz"),
    UpstreamEditCase(
      name: "da(_close_spc", before: "foo (bAr) baz", at: [0, 8], keys: ["d", "a", "("],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "da)_close_spc", before: "foo (bAr) baz", at: [0, 8], keys: ["d", "a", ")"],
      after: "foo  baz"),
    UpstreamEditCase(
      name: "di`", before: "foo `bAr` baz", at: [0, 4], keys: ["d", "i", "`"], after: "foo `` baz"),
    UpstreamEditCase(
      name: "di>", before: "foo <bAr> baz", at: [0, 4], keys: ["d", "i", ">"], after: "foo <> baz"),
    UpstreamEditCase(
      name: "da<", before: "foo <bAr> baz", at: [0, 4], keys: ["d", "a", "<"], after: "foo  baz"),
    UpstreamEditCase(
      name: "dab_on_(_should_delete_around_()block", before: "o( in(abc) )", at: [0, 5],
      keys: ["d", "a", "b"], after: "o( in )"),
    UpstreamEditCase(
      name: "daB_on_{_should_delete_around_{}block", before: "o{ in{abc} }", at: [0, 5],
      keys: ["d", "a", "B"], after: "o{ in }"),
    UpstreamEditCase(
      name: "diB_on_{_should_delete_inner_{}block", before: "o{ in{abc} }", at: [0, 5],
      keys: ["d", "i", "B"], after: "o{ in{} }"),
    UpstreamEditCase(
      name: "da{_on_{_should_delete_inner_block", before: "o{ in{abc} }", at: [0, 5],
      keys: ["d", "a", "{"], after: "o{ in }"),
    UpstreamEditCase(
      name: "di[_on_(_should_not_delete", before: "foo (bAr) baz", at: [0, 4],
      keys: ["d", "i", "["], after: "foo (bAr) baz"),
    UpstreamEditCase(
      name: "di[_on_)_should_not_delete", before: "foo (bAr) baz", at: [0, 8],
      keys: ["d", "i", "["], after: "foo (bAr) baz"),
    UpstreamEditCase(
      name: "da[_on_(_should_not_delete", before: "foo (bAr) baz", at: [0, 4],
      keys: ["d", "a", "["], after: "foo (bAr) baz"),
    UpstreamEditCase(
      name: "da[_on_)_should_not_delete", before: "foo (bAr) baz", at: [0, 8],
      keys: ["d", "a", "["], after: "foo (bAr) baz"),
    UpstreamEditCase(
      name: "di{_middle_spc", before: "a{\n\tbar\n}b", at: [1, 3], keys: ["d", "i", "{"],
      after: "a{}b"),
    UpstreamEditCase(
      name: "di}_middle_spc", before: "a{\n\tbar\n}b", at: [1, 3], keys: ["d", "i", "}"],
      after: "a{}b"),
    UpstreamEditCase(
      name: "da{_middle_spc", before: "a{\n\tbar\n}b", at: [1, 3], keys: ["d", "a", "{"],
      after: "ab"),
    UpstreamEditCase(
      name: "da}_middle_spc", before: "a{\n\tbar\n}b", at: [1, 3], keys: ["d", "a", "}"],
      after: "ab"),
    UpstreamEditCase(
      name: "daB_middle_spc", before: "a{\n\tbar\n}b", at: [1, 3], keys: ["d", "a", "B"],
      after: "ab"),
    UpstreamEditCase(
      name: "di{_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["d", "i", "{"],
      after: "a{}b"),
    UpstreamEditCase(
      name: "di}_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["d", "i", "}"],
      after: "a{}b"),
    UpstreamEditCase(
      name: "da{_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["d", "a", "{"],
      after: "ab"),
    UpstreamEditCase(
      name: "da}_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["d", "a", "}"],
      after: "ab"),
    UpstreamEditCase(
      name: "di[_middle_spc", before: "a\t[\n\tbar\n]b", at: [1, 3], keys: ["d", "i", "["],
      after: "a\t[]b"),
    UpstreamEditCase(
      name: "di]_middle_spc", before: "a\t[\n\tbar\n]b", at: [1, 3], keys: ["d", "i", "]"],
      after: "a\t[]b"),
    UpstreamEditCase(
      name: "da[_middle_spc", before: "a\t[\n\tbar\n]b", at: [1, 3], keys: ["d", "a", "["],
      after: "a\tb"),
    UpstreamEditCase(
      name: "da]_middle_spc", before: "a\t[\n\tbar\n]b", at: [1, 3], keys: ["d", "a", "]"],
      after: "a\tb"),
    UpstreamEditCase(
      name: "di<_middle_spc", before: "a\t<\n\tbar\n>b", at: [1, 3], keys: ["d", "i", "<"],
      after: "a\t<>b"),
    UpstreamEditCase(
      name: "di>_middle_spc", before: "a\t<\n\tbar\n>b", at: [1, 3], keys: ["d", "i", ">"],
      after: "a\t<>b"),
    UpstreamEditCase(
      name: "da<_middle_spc", before: "a\t<\n\tbar\n>b", at: [1, 3], keys: ["d", "a", "<"],
      after: "a\tb"),
    UpstreamEditCase(
      name: "da>_middle_spc", before: "a\t<\n\tbar\n>b", at: [1, 3], keys: ["d", "a", ">"],
      after: "a\tb"),
    UpstreamEditCase(
      name: "dat_noop", before: "<outer><inner>hello</inner></outer>", at: [0, 9],
      keys: ["d", "a", "t"], after: "<outer><inner>hello</inner></outer>"),
  ]

  nonisolated static let selections: [UpstreamEditCase] = [
    UpstreamEditCase(
      name: "viw_middle_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["v", "i", "w"],
      selection: "bAr"),
    UpstreamEditCase(
      name: "vaw_middle_spc", before: "foo \tbAr\t baz", at: [0, 6], keys: ["v", "a", "w"],
      selection: "bAr\t "),
    UpstreamEditCase(
      name: "viw_middle_punct", before: "foo \tbAr,\t baz", at: [0, 6], keys: ["v", "i", "w"],
      selection: "bAr"),
    UpstreamEditCase(
      name: "vaW_middle_punct", before: "foo \tbAr,\t baz", at: [0, 6], keys: ["v", "a", "W"],
      selection: "bAr,\t "),
    UpstreamEditCase(
      name: "viw_start_spc", before: "foo \tbAr\t baz", at: [0, 5], keys: ["v", "i", "w"],
      selection: "bAr"),
    UpstreamEditCase(
      name: "viw_end_spc", before: "foo \tbAr\t baz", at: [0, 7], keys: ["v", "i", "w"],
      selection: "bAr"),
    UpstreamEditCase(
      name: "viw_eol", before: "foo \tbAr", at: [0, 7], keys: ["v", "i", "w"], selection: "bAr"),
    UpstreamEditCase(
      name: "vi{_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["v", "i", "{"],
      selection: "\n\tbar\n\t"),
    UpstreamEditCase(
      name: "va{_middle_spc", before: "a{\n\tbar\n\t}b", at: [1, 3], keys: ["v", "a", "{"],
      selection: "{\n\tbar\n\t}"),
    UpstreamEditCase(
      name: "va{outside", before: "xa{\n\tbar\n\t}b", at: [0, 0], keys: ["v", "a", "{"],
      selection: "{\n\tbar\n\t}"),
  ]
}
