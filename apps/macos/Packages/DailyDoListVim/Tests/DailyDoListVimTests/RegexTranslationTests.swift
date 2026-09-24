import Foundation
import Testing

@testable import DailyDoListVim

/// The JavaScript regex layer on top of ICU: syntax, matching semantics that differ between the
/// engines, `source` escaping and V8's error messages.
@Suite struct RegexTranslationTests {
  private func matches(_ pattern: String, _ flags: String = "", _ subject: String, from: Int = 0)
    throws -> [String?]?
  {
    let regex = try JSRegExp(VimText(pattern), flags: flags)
    guard let m = regex.firstMatch(in: VimText(subject), from: from) else { return nil }
    return (0..<m.count).map { m[$0]?.string }
  }

  private func index(_ pattern: String, _ flags: String = "", _ subject: String) throws -> Int? {
    try JSRegExp(VimText(pattern), flags: flags).firstMatch(in: VimText(subject), from: 0)?.index
  }

  @Test func literalAndClasses() throws {
    #expect(try matches("b+", "", "abbbc") == ["bbb"])
    #expect(try matches("[a-c]+", "", "xxabcabx") == ["abcab"])
    // ICU operators that are literals in JavaScript.
    #expect(try matches("a&&b", "", "a&&b") == ["a&&b"])
    #expect(try matches("[&&]", "", "&") == ["&"])
    #expect(try matches("[[:alpha:]]", "", ":]") == [":]"])
    #expect(try matches("a#b", "", "a#b") == ["a#b"])
    #expect(try matches("[^]", "", "\n") == ["\n"])
    #expect(try matches("[]", "", "a") == nil)
  }

  @Test func classEscapesAreAscii() throws {
    // \w, \d and \b only know ASCII in JavaScript (ICU would take all of Unicode).
    #expect(try matches("\\w+", "", "é_ab9") == ["_ab9"])
    #expect(try matches("\\d", "", "٣7") == ["7"])
    #expect(try matches("\\bé", "", " é") == nil)
    #expect(try matches("\\Bé", "", " é") == ["é"])
    // \s is JavaScript's whitespace (including U+FEFF, excluding U+0085).
    #expect(try matches("\\s", "", "\u{85}\u{FEFF}") == ["\u{FEFF}"])
    // With `iu`, \w also matches the case-folded ſ and K (Kelvin).
    #expect(try matches("\\w", "iu", "ſ") == ["ſ"])
    #expect(try matches("\\w", "i", "ſ") == nil)
  }

  @Test func dotAndAnchors() throws {
    // `.` excludes exactly the four JavaScript line terminators.
    #expect(try matches(".", "", "\u{2028}\u{85}") == ["\u{85}"])
    #expect(try matches(".", "s", "\n") == ["\n"])
    // ^ and $ follow the `m` flag and the four line terminators.
    #expect(try index("^b", "", "a\nb") == nil)
    #expect(try index("^b", "m", "a\nb") == 2)
    #expect(try index("a$", "m", "a\u{2028}b") == 0)
    #expect(try index("a$", "", "a\n") == nil)
  }

  @Test func caseInsensitivity() throws {
    #expect(try matches("straße", "i", "STRASSE") == nil)
    #expect(try matches("straße", "i", "STRAßE") == ["STRAßE"])
    #expect(try matches("ǅ", "i", "ǆ") == ["ǆ"])
    #expect(try matches("[a-z]+", "i", "AbC") == ["AbC"])
    // Modifiers scope case folding (ES2025).
    #expect(try matches("(?i:a)b", "", "Ab") == ["Ab"])
    #expect(try matches("(?i:a)b", "", "AB") == nil)
  }

  @Test func groupsAndBackreferences() throws {
    #expect(try matches("(?<year>\\d{4})-\\k<year>", "", "2026-2026") == ["2026-2026", "2026"])
    #expect(try matches("(a)|(b)", "", "b") == ["b", nil, "b"])
    #expect(try matches("(a)\\1", "", "aa") == ["aa", "a"])
    // Annex B: \8 is a literal, \1 without a group too.
    #expect(try matches("\\8", "", "8") == ["8"])
  }

  @Test func unicodeMode() throws {
    #expect(try matches(".", "u", "😀") == ["😀"])
    // Known difference: without `u`, ICU still reads a surrogate pair as one character, where
    // JavaScript sees two code units (vim's searches run in unicode mode, see the README).
    #expect(try matches(".", "", "😀") == ["😀"])
    #expect(try matches("\\p{Lu}", "u", "aÉ") == ["É"])
    #expect(try matches("\\u{1F600}", "u", "😀") == ["😀"])
  }

  @Test func unboundedLookbehindIsEmulated() throws {
    #expect(try matches("(?<=a.*)b", "", "xxaxxb") == ["b"])
    #expect(try matches("(?<=a.*)b", "", "xxb") == nil)
    #expect(try matches("(?<!a.*)b", "", "xxb") == ["b"])
    #expect(try matches("(?<!a.*)b", "", "ab b") == nil)
    #expect(try matches("(?<=(a+))(b)", "", "caab") == ["b", "aa", "b"])
    // The look-behind sees text before the start index, and its "end here" check doesn't leak
    // into look-aheads.
    #expect(try matches("(?<=a.*)b", "", "ab", from: 1) == ["b"])
    #expect(try matches("(?<=a.*$)", "m", "a\nb") == [""])
  }

  @Test func sourceAndDescription() throws {
    #expect(try JSRegExp(VimText("a/b"), flags: "").source == "a\\/b")
    #expect(try JSRegExp(VimText(""), flags: "").source == "(?:)")
    #expect(try JSRegExp(VimText("a\nb"), flags: "").source == "a\\nb")
    #expect(try JSRegExp(VimText("x"), flags: "mgi").description == "/x/gim")
  }

  @Test func syntaxErrorsReadLikeV8() {
    func message(_ pattern: String, _ flags: String = "") -> String? {
      do {
        _ = try JSRegExp.make(VimText(pattern), flags)
        return nil
      } catch {
        return JSException.from(error).description
      }
    }
    #expect(message("(") == "SyntaxError: Invalid regular expression: /(/: Unterminated group")
    #expect(message("a**") == "SyntaxError: Invalid regular expression: /a**/: Nothing to repeat")
    #expect(
      message("[b-a]")
        == "SyntaxError: Invalid regular expression: /[b-a]/: Range out of order in character class"
    )
    #expect(
      message("\\u{1", "u")
        == "SyntaxError: Invalid regular expression: /\\u{1/u: Invalid Unicode escape")
    #expect(
      message("a{", "u") == "SyntaxError: Invalid regular expression: /a{/u: Incomplete quantifier")
    #expect(message("a{") == nil)
    #expect(message("x", "gg") == "SyntaxError: Invalid flags supplied to RegExp constructor 'gg'")
  }

  @Test func replaceFollowsGetSubstitution() throws {
    func replace(_ subject: String, _ pattern: String, _ flags: String, _ replacement: String)
      throws -> String
    {
      JSReplace.replace(
        VimText(subject), try JSRegExp(VimText(pattern), flags: flags), with: VimText(replacement)
      ).string
    }
    #expect(try replace("a1b2", "(\\d)", "g", "<$1>") == "a<1>b<2>")
    #expect(try replace("abc", "b", "", "[$&|$`|$']") == "a[b|a|c]c")
    #expect(try replace("abc", "b", "", "$$") == "a$c")
    #expect(try replace("abc", "(b)", "", "$2$0") == "a$2$0c")
    #expect(
      try replace("abc", "(?<x>b)", "", "$<x>$<y>")
        == "abc".replacingOccurrences(of: "b", with: "b"))
    #expect(try replace("aaa", "a*?", "g", "-") == "-a-a-a-")
    #expect(try replace("😀", "", "gu", "-") == "-😀-")
    #expect(try replace("😀", "", "g", "-").utf16.count == 5)
  }
}
