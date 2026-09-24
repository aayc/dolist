import Foundation
import Testing

@testable import DailyDoListEditor

/// Runs a pure command on marked text; returns the marked result, or nil if the command declined.
private func run(_ marked: String, _ command: (NSString, [NSRange]) -> TextEdit?) -> String? {
  let (text, selection) = parseMarked(marked)
  guard let edit = command(text as NSString, [selection]) else { return nil }
  return renderMarked(edit.applied(to: text), edit.selection.first ?? NSRange(location: 0, length: 0))
}

/// `isLiteralLine` for pure commands: code and frontmatter lines per the tokenizer.
private func literalLines(_ text: NSString) -> (Int) -> Bool {
  let lines = MarkdownTokenizer.tokenize(text as String)
  return { offset in
    lines.last { $0.range.location <= offset }?.tokens.kind.isLiteral ?? false
  }
}

private func enter(_ text: NSString, _ selection: [NSRange]) -> TextEdit? {
  ListCommands.newline(in: text, selection: selection, isLiteralLine: literalLines(text))
}

private func backspace(_ text: NSString, _ selection: [NSRange]) -> TextEdit? {
  ListCommands.deleteMarkupBackward(in: text, selection: selection, isLiteralLine: literalLines(text))
}

@Suite("Commands: list editing")
struct ListCommandTests {
  @Test(arguments: [
    ("- a\n\t- b|", "- a\n\t- b\n\t- |"),
    ("- a\n  - b|", "- a\n  - b\n  - |"),
    ("- a\n    - b|", "- a\n    - b\n    - |"),
    ("\t\t- [ ] a|", "\t\t- [ ] a\n\t\t- [ ] |"),
    ("  - a|", "  - a\n  - |"),
    ("1. a|", "1. a\n2. |"),
    ("1) a|", "1) a\n2) |"),
    ("9. a|", "9. a\n10. |"),
    ("1. a|\n2. b\n3. c", "1. a\n2. |\n3. b\n4. c"),
    ("1. a|\n2. b\n\t- nested\n3. c\n\nafter", "1. a\n2. |\n3. b\n\t- nested\n4. c\n\nafter"),
    ("1. [ ] a|", "1. [ ] a\n2. [ ] |"),
    ("- [ ] a|", "- [ ] a\n- [ ] |"),
    ("- [x] a|", "- [x] a\n- [ ] |"),
    ("- [X] a|", "- [X] a\n- [ ] |"),
    ("- [/] a|", "- [/] a\n- [ ] |"),
    ("- [-] a|", "- [-] a\n- [ ] |"),
    ("- [>] a|", "- [>] a\n- [ ] |"),
    ("- [?] a|", "- [?] a\n- [ ] |"),
    ("* [!] a|", "* [!] a\n* [ ] |"),
    ("\t- [/] nested|", "\t- [/] nested\n\t- [ ] |"),
    ("* [ ] a|", "* [ ] a\n* [ ] |"),
    ("+ a|", "+ a\n+ |"),
    ("-   spaced|", "-   spaced\n-   |"),
  ])
  func continuesListsAndTasks(input: String, output: String) {
    #expect(run(input, enter) == output)
  }

  @Test(arguments: [
    ("- a\n- |", "- a\n|"),
    ("1. a\n2. |", "1. a\n|"),
    ("- [ ] a\n- [ ] |", "- [ ] a\n|"),
    ("- [/] |", "|"),
    ("\t- |", "|"),
    ("- |", "|"),
    ("-|", "|"),
    ("- a\n\t- |", "- a\n- |"),
    ("- a\n\t- [ ] |", "- a\n- |"),
    ("1. a\n\t- |", "1. a\n2. |"),
  ])
  func endsListsOnEmptyItems(input: String, output: String) {
    #expect(run(input, enter) == output)
  }

  @Test(arguments: [
    ("> - a|", "> - a\n> - |"),
    ("> - [ ] a|", "> - [ ] a\n> - [ ] |"),
    ("> - [/] a|", "> - [/] a\n> - [ ] |"),
    ("> - |", "> |"),
    ("> a|", "> a\n> |"),
    ("> |", ">\n> |"),
    ("> > deep|", "> > deep\n> > |"),
  ])
  func continuesBlockquotes(input: String, output: String) {
    #expect(run(input, enter) == output)
  }

  @Test(arguments: [
    ("- [ ] a|b", "- [ ] a\n- [ ] |b"),
    ("- [ ] |a", "- [ ]\n- [ ] |a"),
    ("- [|] a", "- [\n- |] a"),
  ])
  func splitsItemsWithoutLosingText(input: String, output: String) {
    #expect(run(input, enter) == output)
  }

  @Test(arguments: ["```\n- a|\n```", "text|", "|- [ ] a", "-| [ ] a", "- «a»", "---\ntitle: - x|\n---", "# Heading|"])
  func leavesOtherLinesToTheDefaultNewline(input: String) {
    #expect(run(input, enter) == nil)
  }

  @Test(arguments: [
    ("- |a", "|a"),
    ("- [ ] |a", "|a"),
    ("> |a", "|a"),
    ("> > |a", "> |a"),
    ("1. |a", "|a"),
    ("- a\n\t- |", "- a\n\t|"),
    ("\t- |a", "\t|a"),
    ("> - [x] |done", "> |done"),
  ])
  func backspaceRemovesMarkup(input: String, output: String) {
    #expect(run(input, backspace) == output)
  }

  @Test(arguments: ["- a|", "|- a", "text|", "- [ ]| a", "```\n- |a\n```", "- «a»"])
  func backspaceLeavesOtherPositionsAlone(input: String) {
    #expect(run(input, backspace) == nil)
  }

  @Test(arguments: [
    ("- a\n- b|", "- a\n\t- b|"),
    ("- a|", "\t- a|"),
    ("1. a\n2. b|", "1. a\n\t2. b|"),
    ("«- a\nb»", "\t«- a\n\tb»"),
    ("> - quoted|", "> \t- quoted|"),
    ("«plain\ntext»", "\t«plain\n\ttext»"),
  ])
  func tabIndentsListItems(input: String, output: String) {
    #expect(run(input) { ListCommands.indent(in: $0, selection: $1) } == output)
  }

  @Test func tabOnPlainTextDefersToTheTextView() {
    #expect(run("a|b") { ListCommands.indent(in: $0, selection: $1) } == nil)
  }

  @Test(arguments: [
    ("\t- a|", "- a|"),
    ("  - a|", "- a|"),
    ("      - a|", "  - a|"),
    ("- a|", "- a|"),
    ("\t\t- [ ] a|", "\t- [ ] a|"),
    ("«\t- a\n\t- b»", "«- a\n- b»"),
    ("> \t- q|", "> - q|"),
  ])
  func shiftTabOutdents(input: String, output: String) {
    #expect(run(input) { ListCommands.outdent(in: $0, selection: $1) } == output)
  }
}

@Suite("Commands: tasks")
struct TaskCommandTests {
  private func checklist(_ text: NSString, _ selection: [NSRange]) -> TextEdit? {
    TaskCommands.toggleChecklist(in: text, selection: selection)
  }

  @Test(arguments: [
    ("buy |milk", "- [ ] buy |milk"),
    ("|buy milk", "- [ ] |buy milk"),
    ("\tnested|", "\t- [ ] nested|"),
    ("- item|", "- [ ] item|"),
    ("1. step|", "1. [ ] step|"),
    ("-|", "- [ ] |"),
    ("> - quoted|", "> - [ ] quoted|"),
    ("> plain|", "> - [ ] plain|"),
    ("- [ ] task|", "- [x] task|"),
    ("- [x] task|", "- [ ] task|"),
    ("- [X] task|", "- [ ] task|"),
    ("- [/] task|", "- [x] task|"),
    ("- [-] task|", "- [x] task|"),
    ("|", "- [ ] |"),
    ("«a\n\nb»", "«- [ ] a\n\n- [ ] b»"),
    ("«- [ ] a\n- [x] b\nc»\nd", "«- [x] a\n- [ ] b\n- [ ] c»\nd"),
    ("«a\n»b", "«- [ ] a\n»b"),
  ])
  func toggleChecklist(input: String, output: String) {
    #expect(run(input, checklist) == output)
  }

  @Test func toggleTaskOnlyTouchesTaskLines() {
    let text = "- [ ] a\nplain\n- [x] b\n1. [/] c" as NSString
    #expect(TaskCommands.toggleTask(in: text, lineContaining: 0)?.text == "x")
    #expect(TaskCommands.toggleTask(in: text, lineContaining: 8) == nil)
    #expect(TaskCommands.toggleTask(in: text, lineContaining: 16)?.text == " ")
    #expect(TaskCommands.toggleTask(in: text, lineContaining: 25)?.text == "x")
    #expect(TaskCommands.toggleTask(in: text, lineContaining: 25)?.range == NSRange(location: 26, length: 1))
  }
}

@Suite("Commands: formatting")
struct FormattingCommandTests {
  private func style(_ style: FormattingCommands.MarkupStyle) -> (NSString, [NSRange]) -> TextEdit? {
    { FormattingCommands.toggle(style, in: $0, selection: $1) }
  }

  @Test(arguments: [
    ("a «word» b", "a **«word»** b"),
    ("a **«word»** b", "a «word» b"),
    ("a «**word**» b", "a «word» b"),
    ("a wo|rd b", "a **wo|rd** b"),
    ("a **wo|rd** b", "a wo|rd b"),
    ("a | b", "a **|** b"),
    ("a **|** b", "a | b"),
    ("***«x»***", "*«x»*"),
    ("*«x»*", "***«x»***"),
    ("snake_ca|se", "**snake_ca|se**"),
    ("éco|le", "**éco|le**"),
  ])
  func bold(input: String, output: String) {
    #expect(run(input, style(.bold)) == output)
  }

  @Test(arguments: [
    ("«x»", "*«x»*"),
    ("*«x»*", "«x»"),
    ("**«x»**", "***«x»***"),
    ("***«x»***", "**«x»**"),
  ])
  func italic(input: String, output: String) {
    #expect(run(input, style(.italic)) == output)
  }

  @Test func otherMarkers() {
    #expect(run("«x»", style(.highlight)) == "==«x»==")
    #expect(run("==«x»==", style(.highlight)) == "«x»")
    #expect(run("«x»", style(.strikethrough)) == "~~«x»~~")
    #expect(run("«x»", style(.inlineCode)) == "`«x»`")
    #expect(run("`co|de`", style(.inlineCode)) == "co|de")
  }

  @Test(arguments: [
    ("see «docs» here", "see [docs](|) here"),
    ("«https://example.com»", "[|](https://example.com)"),
    ("x |", "x [|]()"),
    ("visit «https://x.com »today", "visit [|](https://x.com) today"),
    ("visit« https://x.com» today", "visit [|](https://x.com) today"),
    ("«www.x.com\n»next", "[|](www.x.com)\nnext"),
  ])
  func insertLink(input: String, output: String) {
    #expect(run(input) { FormattingCommands.insertLink(in: $0, selection: $1) } == output)
  }
}

@Suite("Text diff and line index")
struct TextDiffTests {
  @Test func minimalChange() {
    #expect(TextDiff.minimalChange(from: "same", to: "same") == nil)
    #expect(
      TextDiff.minimalChange(from: "- [ ] book flights", to: "- [ ] book cheap flights")
        == TextDiff.Change(range: NSRange(location: 11, length: 0), replacement: "cheap "))
    #expect(TextDiff.minimalChange(from: "abc", to: "aXc") == TextDiff.Change(range: NSRange(location: 1, length: 1), replacement: "X"))
    #expect(TextDiff.minimalChange(from: "abc", to: "") == TextDiff.Change(range: NSRange(location: 0, length: 3), replacement: ""))
    #expect(
      TextDiff.minimalChange(from: "- [ ] A\n- [ ] B", to: "- [ ] New\n- [ ] A\n- [ ] B")
        == TextDiff.Change(range: NSRange(location: 0, length: 0), replacement: "- [ ] New\n"))
    #expect(
      TextDiff.minimalChange(from: "- [ ] X\n- [ ] A", to: "- [ ] A")
        == TextDiff.Change(range: NSRange(location: 0, length: 8), replacement: ""))
    #expect(TextDiff.minimalChange(from: "a😀b", to: "a😁b") == TextDiff.Change(range: NSRange(location: 1, length: 2), replacement: "😁"))
  }

  @Test(arguments: [
    ("", "x"), ("aaaa", "aaaaaa"), ("line\nline\n", "line\nline\nline\n"), ("a\nb\nc", "a\nc"), ("one two", "one\ntwo"),
    ("😀😀", "😀"), ("x", ""),
  ])
  func alwaysProducesTheTarget(current: String, next: String) {
    let change = TextDiff.minimalChange(from: current, to: next)
    let result = change.map { (current as NSString).replacingCharacters(in: $0.range, with: $0.replacement) } ?? current
    #expect(result == next)
  }

  @Test func normalizesLineEndings() {
    #expect(TextDiff.normalizeLineEndings("a\r\nb\rc\n") == "a\nb\nc\n")
    #expect(TextDiff.normalizeLineEndings("plain") == "plain")
  }

  @Test func lineIndexTracksEdits() {
    let text = NSMutableString(string: "one\ntwo\nthree")
    var index = LineIndex(text)
    #expect(index.starts == [0, 4, 8])
    text.replaceCharacters(in: NSRange(location: 4, length: 0), with: "new\n")
    let change = index.applyEdit(location: 4, oldLength: 0, newLength: 4, text: text)
    #expect(index.starts == [0, 4, 8, 12])
    #expect(change == LineIndex.Change(firstLine: 1, oldLastLine: 1, newLastLine: 2))
    text.replaceCharacters(in: NSRange(location: 2, length: 8), with: "")
    index.applyEdit(location: 2, oldLength: 8, newLength: 0, text: text)
    #expect(index == LineIndex(text))
    #expect(index.line(containing: 0) == 0)
    #expect(index.line(containing: text.length) == index.count - 1)
    #expect(index.contentRange(ofLine: 0, textLength: text.length) == NSRange(location: 0, length: 3))
  }

  @Test func lineIndexMatchesRebuildAfterRandomEdits() {
    var rng = SeededGenerator(seed: 7)
    let text = NSMutableString(string: "a\nb\n\nccc\n")
    var index = LineIndex(text)
    let pieces = ["\n", "x", "\n\n", "yz\n", "", "long line\nnext"]
    for _ in 0..<500 {
      let location = Int.random(in: 0...text.length, using: &rng)
      let length = Int.random(in: 0...min(6, text.length - location), using: &rng)
      let piece = pieces.randomElement(using: &rng)!
      text.replaceCharacters(in: NSRange(location: location, length: length), with: piece)
      index.applyEdit(location: location, oldLength: length, newLength: (piece as NSString).length, text: text)
      #expect(index == LineIndex(text))
    }
  }
}
