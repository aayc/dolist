import Testing

@testable import DailyDoListVim

/// Ex command lines: ranges (`parseInput_`, `parseLineSpec_`), command names and arguments.
@MainActor
@Suite struct ExParserTests {
  private func parse(_ input: String, in t: VimTester) throws -> ExParams {
    var stream = StringStream(VimText(input))
    let params = ExParams()
    try t.vim.parseInput(t.cm, &stream, params)
    if let name = params.commandName, let command = t.vim.matchExCommand(name) {
      t.vim.parseCommandArgs(&stream, params, command)
    }
    return params
  }

  private let doc = "one\ntwo\nfoo\nthree\nfoo\nsix"

  @Test func numbersAndSpecialLines() throws {
    let t = VimTester(doc, cursor: (3, 0))
    let range = try parse("2,4d", in: t)
    #expect(range.line == 1 && range.lineEnd == 3 && range.commandName == "d")
    let all = try parse("%s/a/b/g", in: t)
    #expect(all.line == 0 && all.lineEnd == 5 && all.commandName == "s" && all.argString == "/a/b/g")
    let last = try parse("$-1y", in: t)
    #expect(last.line == 4)
    let current = try parse(".,+2y", in: t)
    #expect(current.line == 3 && current.lineEnd == 5)
    let offsetOnly = try parse("+1", in: t)
    #expect(offsetOnly.line == 4 && offsetOnly.commandName == "")
  }

  @Test func withoutRangeTheCursorLineIsTheSelection() throws {
    let t = VimTester(doc, cursor: (2, 1))
    let params = try parse("sort", in: t)
    #expect(params.line == nil && params.selectionLine == 2)
  }

  @Test func marksAndPatterns() throws {
    let t = VimTester(doc, cursor: (0, 0))
    t.keys("j", "m", "a", "3", "j", "m", "b", "g", "g")
    let marks = try parse("'a,'bd", in: t)
    #expect(marks.line == 1 && marks.lineEnd == 4)
    let forward = try parse("/foo/d", in: t)
    #expect(forward.line == 2)
    let chained = try parse("/foo//foo/d", in: t)
    #expect(chained.line == 4)
    t.buffer.setCursor(line: 5, ch: 0)
    let backward = try parse("?foo?d", in: t)
    #expect(backward.line == 4)
  }

  @Test func errors() {
    let t = VimTester(doc)
    #expect(throws: JSException.self) { try parse("'zd", in: t) }
    #expect(throws: JSException.self) { try parse("/nothing/d", in: t) }
  }

  @Test func commandNamesAndArguments() throws {
    let t = VimTester(doc)
    #expect(try parse("s/a/b/", in: t).commandName == "s")
    #expect(try parse("!!", in: t).commandName == "!!")
    #expect(try parse("normal! dd", in: t).commandName == "normal")
    let map = try parse("nmap <C-x> dd", in: t)
    #expect(map.commandName == "nmap" && map.args == ["<C-x>", "dd"])
    #expect(t.vim.matchExCommand("sor")?.name == "sort")
    #expect(t.vim.matchExCommand("zz") == nil)
  }
}
