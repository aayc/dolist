import Testing

@testable import DailyDoListVim

/// Vim patterns and replacements as JavaScript ones (vim.js's `translateRegex`,
/// `translateRegexReplace`, `unescapeRegexReplace` and `parseQuery`).
@MainActor
@Suite struct VimRegexTests {
  let vim = Vim(scheduler: ManualVimScheduler(), isMac: false)

  private func translate(_ pattern: String) -> String { vim.translateRegex(VimText(pattern)).string }

  @Test func magicMode() {
    #expect(translate("\\(a\\|b\\)") == "(a|b)")
    #expect(translate("a\\{2,3}") == "a{2,3}")
    #expect(translate("(x)") == "\\(x\\)")
    #expect(translate("a+") == "a\\+")
    #expect(translate("a\\+") == "a+")
    #expect(translate("a*.$^") == "a*.$^")
  }

  @Test func wordBoundaries() {
    #expect(translate("\\<foo\\>") == "(?<=[^\\w]|^)(?=[\\w])foo(?<=[\\w])(?=[^\\w]|$)")
  }

  @Test func modeSwitches() {
    #expect(translate("\\vfoo(bar)+") == "foo(bar)+")
    #expect(translate("\\v<x>") == "(?<=[^\\w]|^)(?=[\\w])x(?<=[\\w])(?=[^\\w]|$)")
    #expect(translate("\\V.*$") == "\\.\\*\\$")
    #expect(translate("\\Ma*.") == "a\\*\\.")
    #expect(translate("\\Vx\\mx+") == "xx\\+")
  }

  @Test func matchStartAndEnd() {
    #expect(translate("foo\\zsbar") == "(?<=foo)bar")
    #expect(translate("foo\\zebar") == "foo(?=bar)")
  }

  @Test func trailingBackslashStays() {
    #expect(translate("a\\") == "a\\")
  }

  @Test func replacements() {
    func replace(_ text: String) -> String { vim.translateRegexReplace(VimText(text)).string }
    #expect(replace("\\1-\\2") == "$1-$2")
    #expect(replace("$") == "$$")
    #expect(replace("a\\/b") == "a/b")
    #expect(replace("a/b") == "a\\/b")
    #expect(replace("\\n\\t") == "\n\t")
    #expect(replace("\\\\") == "\\")
    #expect(replace("&") == "&")
  }

  @Test func pcreReplacementsUnescape() {
    func unescape(_ text: String) -> String { vim.unescapeRegexReplace(VimText(text)).string }
    #expect(unescape("\\/\\\\\\n\\&") == "/\\\n&")
    #expect(unescape("\\x") == "\\x")
  }

  @Test func queries() throws {
    let plain = try #require(try vim.parseQuery("foo", false, false))
    #expect(plain.source == "foo")
    #expect(plain.flags.string == "m")
    let forced = try #require(try vim.parseQuery("foo/i", false, false))
    #expect(forced.source == "foo" && forced.flags.string == "im")
    let smart = try #require(try vim.parseQuery("Foo", true, true))
    #expect(smart.flags.string == "m")
    let smartLower = try #require(try vim.parseQuery("foo", true, true))
    #expect(smartLower.flags.string == "im")
    #expect(try vim.parseQuery("", false, false) == nil)
    #expect(vim.register("/").text == "")
    try vim.setOption("pcre", false)
    let translated = try #require(try vim.parseQuery("\\(a\\)", false, false))
    #expect(translated.source == "(a)")
    #expect(vim.register("/").text == "\\(a\\)")
  }

  @Test func invalidQueriesThrowLikeV8() {
    #expect(throws: JSException.self) { try vim.parseQuery("a(", false, false) }
  }
}
