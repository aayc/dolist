import Foundation
import Testing

@testable import DailyDoListEditor

@Suite("Tokenizer: inline syntax")
struct TokenizerInlineTests {
  @Test func emphasis() {
    #expect(spans("**bold**", .bold) == ["**bold**"])
    #expect(spans("__bold__", .bold) == ["__bold__"])
    #expect(spans("*it*", .italic) == ["*it*"])
    #expect(spans("_it_", .italic) == ["_it_"])
    #expect(markers("**bold** and *it*", .emphasis) == ["**", "**", "*", "*"])
    #expect(spans("***both***", .bold) == ["**both**"])
    #expect(spans("***both***", .italic) == ["***both***"])
    #expect(spans("**bold *inner* bold**", .italic) == ["*inner*"])
    #expect(spans("**bold *inner* bold**", .bold) == ["**bold *inner* bold**"])
    #expect(spans("*a **b** c*", .bold) == ["**b**"])
    #expect(spans("*a **b** c*", .italic) == ["*a **b** c*"])
  }

  @Test func flankingRules() {
    #expect(spans("snake_case_word", .italic).isEmpty)
    #expect(spans("foo_bar_", .italic).isEmpty)
    #expect(spans("foo*bar*", .italic) == ["*bar*"])
    #expect(spans("a * b * c", .italic).isEmpty)
    #expect(spans("** not bold **", .bold).isEmpty)
    #expect(spans("*unterminated", .italic).isEmpty)
    #expect(spans("**unterminated", .bold).isEmpty)
    #expect(spans("*(*punct*)*", .italic).count == 2)
    #expect(spans("_(x)_", .italic) == ["_(x)_"])
    #expect(spans("2*3*4", .italic) == ["*3*"])
  }

  @Test func ruleOfThree() {
    #expect(spans("*foo**bar**baz*", .italic) == ["*foo**bar**baz*"])
    #expect(spans("*foo**bar**baz*", .bold) == ["**bar**"])
    #expect(spans("**foo*bar*baz**", .bold) == ["**foo*bar*baz**"])
  }

  @Test func strikethroughAndHighlight() {
    #expect(spans("~~gone~~", .strikethrough) == ["~~gone~~"])
    #expect(markers("~~gone~~", .strikethrough) == ["~~", "~~"])
    #expect(spans("~one~", .strikethrough).isEmpty)
    #expect(spans("~~~three~~~", .strikethrough).isEmpty)
    #expect(spans("==marked==", .highlight) == ["==marked=="])
    #expect(spans("a == b == c", .highlight).isEmpty)
    #expect(spans("===x===", .highlight).isEmpty)
    #expect(spans("**==both==**", .highlight) == ["==both=="])
  }

  @Test func codeSpans() {
    #expect(spans("`code`", .code) == ["`code`"])
    #expect(markers("`code`", .code) == ["`", "`"])
    #expect(spans("``a`b``", .code) == ["``a`b``"])
    #expect(markers("``a`b``", .code) == ["``", "``"])
    #expect(spans("`**not bold**`", .bold).isEmpty)
    #expect(spans("`[[not a link]]`", .wikilink).isEmpty)
    #expect(tagNames("`#notatag`").isEmpty)
    #expect(spans("`unterminated", .code).isEmpty)
    #expect(spans("``unmatched` lengths", .code).isEmpty)
    #expect(spans("`a` and `b`", .code) == ["`a`", "`b`"])
    #expect(spans("**`code` in bold**", .bold) == ["**`code` in bold**"])
  }

  @Test func escapes() {
    #expect(spans("\\*not italic\\*", .italic).isEmpty)
    #expect(markers("\\*not italic\\*", .escape) == ["\\", "\\"])
    #expect(markers("\\a is not an escape", .escape).isEmpty)
    #expect(spans("\\[[not a link]]", .wikilink).isEmpty)
  }

  @Test func markdownLinks() {
    let line = "see [the docs](https://example.com/a_b \"Title\") now"
    #expect(spans(line, .link) == ["the docs"])
    #expect(markers(line, .link) == ["[", "](https://example.com/a_b \"Title\")"])
    #expect(linkTargets(line) == [.url("https://example.com/a_b")])
    #expect(spans("[**bold** link](u)", .bold) == ["**bold**"])
    #expect(linkTargets("[x](<a b.md>)") == [.url("a b.md")])
    #expect(linkTargets("[x](Daily/2026-06-19.md#Tasks)") == [.url("Daily/2026-06-19.md#Tasks")])
    #expect(linkTargets("[x](foo(bar))") == [.url("foo(bar)")])
    #expect(linkTargets("[x](a\\)b)") == [.url("a)b")])
    #expect(linkTargets("[a](b").isEmpty)
    #expect(linkTargets("[a]").isEmpty)
    #expect(linkTargets("[a][ref]").isEmpty)
    #expect(linkTargets("[](u)").isEmpty)
    #expect(linkTargets("[a]()").isEmpty)
    #expect(linkTargets("![alt](img.png)").isEmpty)
    #expect(markers("![alt](img.png)").isEmpty)
    #expect(linkTargets("[outer [inner](a)](b)") == [.url("a")])
    #expect(linkTargets("[see https://x.com](https://y.com)") == [.url("https://y.com")])
  }

  @Test func autolinksAndBareURLs() {
    #expect(spans("<https://auto.link/x>", .link) == ["https://auto.link/x"])
    #expect(markers("<https://auto.link/x>", .autolink) == ["<", ">"])
    #expect(linkTargets("<me@example.com>") == [.url("me@example.com")])
    #expect(linkTargets("<div>").isEmpty)
    #expect(spans("go to https://example.com/a_b_c.", .link) == ["https://example.com/a_b_c"])
    #expect(spans("go to https://example.com/a_b_c.", .italic).isEmpty)
    #expect(spans("(https://x.com/foo)", .link) == ["https://x.com/foo"])
    #expect(spans("https://en.wikipedia.org/wiki/Foo_(bar)", .link) == ["https://en.wikipedia.org/wiki/Foo_(bar)"])
    #expect(spans("*https://x.com*", .link) == ["https://x.com"])
    #expect(spans("*https://x.com*", .italic) == ["*https://x.com*"])
    #expect(spans("HTTPS://X.COM/Path", .link) == ["HTTPS://X.COM/Path"])
    #expect(spans("www.example.com/page", .link) == ["www.example.com/page"])
    #expect(spans("xhttps://nope.com", .link).isEmpty)
    #expect(spans("https://", .link).isEmpty)
    #expect(spans("a &amp; https://x.com?a=1&amp;", .link) == ["https://x.com?a=1"])
  }

  @Test func wikilinks() {
    #expect(spans("[[Note]]", .wikilink) == ["Note"])
    #expect(markers("[[Note]]", .wikilink) == ["[[", "]]"])
    #expect(linkTargets("[[Note]]") == [.wiki(target: "Note", subpath: nil, alias: nil, isEmbed: false)])
    #expect(spans("[[Note|Alias]]", .wikilink) == ["Alias"])
    #expect(markers("[[Note|Alias]]", .wikilink) == ["[[Note|", "]]"])
    #expect(linkTargets("[[Daily/2026-06-19#Tasks|today]]") == [
      .wiki(target: "Daily/2026-06-19", subpath: "Tasks", alias: "today", isEmbed: false)
    ])
    #expect(spans("[[Note#Heading]]", .wikilink) == ["Note#Heading"])
    #expect(linkTargets("![[image.png]]") == [.wiki(target: "image.png", subpath: nil, alias: nil, isEmbed: true)])
    #expect(markers("![[image.png]]", .wikilink) == ["![[", "]]"])
    #expect(markers("[[Note|]]", .wikilink) == ["[[", "|]]"])
    #expect(linkTargets("[[]]").isEmpty)
    #expect(linkTargets("[[a]b]]").isEmpty)
    #expect(linkTargets("[[unclosed").isEmpty)
    #expect(spans("[[a_b_c]] and *it*", .italic) == ["*it*"])
    #expect(linkTargets("[[a]] [[b]]").count == 2)
  }

  @Test func tags() {
    #expect(tagNames("#tag and #nested/tag-1") == ["tag", "nested/tag-1"])
    #expect(spans("#tag", .tag) == ["#tag"])
    #expect(tagNames("#123").isEmpty)
    #expect(tagNames("#1a") == ["1a"])
    #expect(tagNames("a#tag").isEmpty)
    #expect(tagNames("(#tag)").isEmpty)
    #expect(tagNames("https://x.com/#frag").isEmpty)
    #expect(tagNames("[[Note#Heading]]").isEmpty)
    #expect(tagNames("#café #日本語 #emoji😀").sorted() == ["café", "emoji", "日本語"])
    #expect(tagNames("#").isEmpty)
    #expect(tagNames("# heading-like in text? no: a # b").isEmpty)
  }

  @Test func unicodeOffsets() {
    let line = "😀 **b** 👩‍👩‍👧 *i*"
    let tokens = tokenizeLine(line)
    let bold = tokens.spans.first { $0.style == .bold }
    #expect(bold?.range == NSRange(location: 3, length: 5))
    #expect(spans(line, .italic) == ["*i*"])
    #expect(spans("**😀**", .bold) == ["**😀**"])
    #expect(spans("é*x*é", .italic) == ["*x*"])
    #expect(spans("日本*語*", .italic) == ["*語*"])
  }

  @Test func markersAlwaysLieInsideTheLine() {
    let lines = [
      "**", "*", "`", "[[", "]]", "[", "](", "<", "==", "~~", "\\", "#", "- [", "> ", "***",
      "**a*b**c*", "[a](b)(c)", "[[a|b|c]]", "`a``b`", "<a:b>", "h", "www.",
    ]
    for line in lines {
      let length = (line as NSString).length
      let tokens = tokenizeLine(line)
      for range in tokens.markers.map(\.range) + tokens.spans.map(\.range) + tokens.links.map(\.range) {
        #expect(range.location >= 0 && range.end <= length, "\(line) \(range)")
      }
    }
  }
}
