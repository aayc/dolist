import Foundation
import Testing

@testable import DailyDoListAgent

@Suite("Markdown rendering")
struct MarkdownTests {
  private func links(in text: AttributedString) -> [URL] {
    text.runs.compactMap(\.link)
  }

  private func allLinks(_ blocks: [MarkdownBlock]) -> [URL] {
    blocks.flatMap { block -> [URL] in
      switch block {
      case .paragraph(_, let text), .heading(_, _, let text), .listItem(_, _, _, let text),
        .quote(_, let text):
        return links(in: text)
      case .table(_, let header, let rows):
        return (header + rows.flatMap { $0 }).flatMap(links(in:))
      case .code, .rule:
        return []
      }
    }
  }

  @Test func onlyWebAndMailLinksSurvive() {
    let blocks = MarkdownRenderer.blocks(
      from:
        "[ok](https://example.com) [mail](mailto:sam@example.com) [js](javascript:alert(1)) [file](file:///etc/hosts) [rel](../notes) [app](x-apple.systempreferences:com.apple)"
    )
    #expect(
      allLinks(blocks).map(\.absoluteString) == ["https://example.com", "mailto:sam@example.com"])
    guard case .paragraph(_, let text) = blocks.first else {
      Issue.record("expected a paragraph")
      return
    }
    // The text of stripped links stays.
    #expect(String(text.characters) == "ok mail js file rel app")
  }

  @Test func inlineRenderingIsSanitizedToo() {
    let text = MarkdownRenderer.inline("**Hi**\n[x](javascript:void(0)) [y](https://example.com)")
    #expect(links(in: text).map(\.absoluteString) == ["https://example.com"])
    #expect(String(text.characters) == "Hi\nx y")
  }

  @Test func blocksKeepTheirStructure() {
    let source = """
      # Title
      Line one
      line two

      - first
      - second
        - nested

      1. one
      2. two

      > quoted

      ```swift
      let x = 1
      ```

      | A | B |
      |---|---|
      | 1 | 2 |
      | 3 | 4 |

      ---
      """
    let blocks = MarkdownRenderer.blocks(from: source)
    var kinds: [String] = []
    for block in blocks {
      switch block {
      case .heading(_, let level, let text): kinds.append("h\(level):\(String(text.characters))")
      case .paragraph(_, let text): kinds.append("p:\(String(text.characters))")
      case .listItem(_, let marker, let depth, let text):
        kinds.append("li\(depth)\(marker ?? "_"):\(String(text.characters))")
      case .quote(_, let text): kinds.append("q:\(String(text.characters))")
      case .code(_, let language, let code): kinds.append("code(\(language ?? "")):\(code)")
      case .table(_, let header, let rows):
        kinds.append(
          "table:\(header.map { String($0.characters) })|\(rows.map { $0.map { String($0.characters) } })"
        )
      case .rule: kinds.append("rule")
      }
    }
    #expect(
      kinds == [
        "h1:Title",
        "p:Line one\nline two",
        "li1•:first",
        "li1•:second",
        "li2•:nested",
        "li11.:one",
        "li12.:two",
        "q:quoted",
        "code(swift):let x = 1",
        "table:[\"A\", \"B\"]|[[\"1\", \"2\"], [\"3\", \"4\"]]",
        "rule",
      ])
  }

  @Test func continuationParagraphsOfAListItemHaveNoMarker() {
    let blocks = MarkdownRenderer.blocks(from: "1. First\n\n   More about it\n2. Second")
    let markers = blocks.compactMap { block -> String? in
      if case .listItem(_, let marker, _, _) = block { return marker ?? "-" }
      return nil
    }
    #expect(markers == ["1.", "-", "2."])
  }

  @Test func rawHTMLIsDroppedAndImagesShowTheirAltText() {
    let blocks = MarkdownRenderer.blocks(
      from: "Hello <b>bold</b> ![a cat](https://example.com/cat.png)")
    guard case .paragraph(_, let text) = blocks.first else {
      Issue.record("expected a paragraph")
      return
    }
    #expect(String(text.characters) == "Hello bold a cat")
  }

  @Test func blockIdsAreUnique() {
    let blocks = MarkdownRenderer.blocks(
      from: SampleData.snapshot().artifacts["art_sample_desks"].map {
        String(decoding: $0.data, as: UTF8.self)
      } ?? "")
    #expect(!blocks.isEmpty)
    #expect(Set(blocks.map(\.id)).count == blocks.count)
  }

  @MainActor
  @Test func theCacheReturnsTheSameBlocks() {
    let first = MarkdownCache.shared.blocks(for: "**cached**")
    #expect(MarkdownCache.shared.blocks(for: "**cached**") == first)
  }
}

@Suite("Link and HTML policies")
struct SafetyPolicyTests {
  @Test(arguments: [
    ("https://example.com/path?q=1", true), ("http://example.com", true),
    ("HTTPS://EXAMPLE.COM", true),
    ("mailto:sam@example.com", true), ("mailto:", false), ("javascript:alert(1)", false),
    ("file:///etc/hosts", false), ("ftp://example.com", false), ("http:relative", false),
    ("x-apple.systempreferences:com.apple.preference.security", false),
    ("data:text/html,hi", false),
    ("ddl://open", false),
  ])
  func linkPolicy(link: String, allowed: Bool) throws {
    let url = try #require(URL(string: link))
    #expect(LinkPolicy.isAllowed(url) == allowed)
  }

  @Test func onlyAllowedLinksAreHandedToTheSystem() throws {
    var opened: [URL] = []
    let unsafe = try #require(URL(string: "javascript:alert(1)"))
    let safe = try #require(URL(string: "https://example.com"))
    #expect(!LinkPolicy.handle(unsafe) { opened.append($0) })
    #expect(LinkPolicy.handle(safe) { opened.append($0) })
    #expect(opened == [safe])
  }

  @Test func htmlDocumentsCarryARestrictivePolicy() {
    let document = HTMLArtifactPolicy.document(for: "<p>Hi</p>")
    #expect(document.hasPrefix("<meta http-equiv=\"Content-Security-Policy\""))
    #expect(document.contains("default-src 'none'"))
    #expect(document.hasSuffix("<p>Hi</p>"))
  }

  @Test func onlyTheInitialLoadMayNavigate() {
    let blank = URL(string: "about:blank")
    let web = URL(string: "https://example.com")
    #expect(HTMLArtifactPolicy.allowsNavigation(to: blank, isMainFrame: true, hasLoaded: false))
    #expect(HTMLArtifactPolicy.allowsNavigation(to: nil, isMainFrame: true, hasLoaded: false))
    #expect(!HTMLArtifactPolicy.allowsNavigation(to: blank, isMainFrame: true, hasLoaded: true))
    #expect(!HTMLArtifactPolicy.allowsNavigation(to: web, isMainFrame: true, hasLoaded: true))
    #expect(!HTMLArtifactPolicy.allowsNavigation(to: web, isMainFrame: true, hasLoaded: false))
    #expect(!HTMLArtifactPolicy.allowsNavigation(to: blank, isMainFrame: false, hasLoaded: false))
  }
}

@Suite("Inbox grouping")
struct InboxGroupingTests {
  static var calendar: Calendar { FormattingTests.calendar }
  static var now: Date { FormattingTests.now }
  static var nowMillis: Double { now.epochMillis }
  static var yesterday: Double { now.addingTimeInterval(-86_400).epochMillis }

  @Test func anythingWaitingOnTheUserComesFirst() {
    #expect(InboxGroup.of(status: .waitingUser, pendingApprovals: 0) == .needsYou)
    #expect(InboxGroup.of(status: .waitingApproval, pendingApprovals: 0) == .needsYou)
    #expect(InboxGroup.of(status: .working, pendingApprovals: 1) == .needsYou)
    #expect(InboxGroup.of(status: .queued, pendingApprovals: 0) == .working)
    #expect(InboxGroup.of(status: .triaging, pendingApprovals: 0) == .working)
    #expect(InboxGroup.of(status: .done, pendingApprovals: 0) == .done)
    #expect(InboxGroup.of(status: .cancelled, pendingApprovals: 0) == .other)
    #expect(InboxGroup.of(status: "from_the_future", pendingApprovals: 0) == .other)
    #expect(InboxGroup.allCases.map(\.title) == ["Needs you", "Working", "Done", "Other"])
  }

  @Test func showsTodayPlusOlderThreadsThatStillNeedAttentionNewestFirst() {
    let sections = InboxGrouping.sections(
      for: [
        Fixture.summary(
          "old-done", status: .done, createdAt: Self.yesterday, updatedAt: Self.yesterday),
        Fixture.summary(
          "old-waiting", status: .waitingApproval, createdAt: Self.yesterday,
          updatedAt: Self.yesterday),
        Fixture.summary(
          "old-working", status: .working, createdAt: Self.yesterday, updatedAt: Self.yesterday),
        Fixture.summary(
          "done-a", status: .done, createdAt: Self.nowMillis - 9_000,
          updatedAt: Self.nowMillis - 5_000),
        Fixture.summary(
          "done-b", status: .done, createdAt: Self.nowMillis - 9_000,
          updatedAt: Self.nowMillis - 100),
        Fixture.summary(
          "created-today", status: .failed, createdAt: Self.nowMillis - 1_000,
          updatedAt: Self.yesterday),
      ],
      now: Self.now, calendar: Self.calendar)
    #expect(sections.map(\.group) == [.needsYou, .working, .done, .other])
    #expect(
      sections.map { $0.threads.map(\.id) } == [
        ["old-waiting"], ["old-working"], ["done-b", "done-a"], ["created-today"],
      ])
  }

  @Test func aLocallyKnownPendingApprovalMovesAThreadUp() {
    let sections = InboxGrouping.sections(
      for: [Fixture.summary(status: .working, updatedAt: Self.nowMillis)],
      pendingApprovalThreadIds: ["thr_1"],
      now: Self.now, calendar: Self.calendar)
    #expect(sections.map(\.group) == [.needsYou])
  }

  @Test func emptyInboxHasNoSections() {
    #expect(InboxGrouping.sections(for: [], now: Self.now, calendar: Self.calendar).isEmpty)
  }
}
