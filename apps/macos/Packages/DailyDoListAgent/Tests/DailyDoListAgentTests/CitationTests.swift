import AppKit
import DailyDoListModels
import DailyDoListUI
import Foundation
import SwiftUI
import Testing

@testable import DailyDoListAgent

@Suite("Citations, wikilinks and link previews")
@MainActor
struct CitationTests {
  private func paragraph(_ source: String) throws -> AttributedString {
    guard case .paragraph(_, let text) = try #require(MarkdownRenderer.blocks(from: source).first)
    else {
      Issue.record("not a paragraph: \(source)")
      return AttributedString()
    }
    return text
  }

  private func links(_ text: AttributedString) -> [(String, URL)] {
    text.runs.compactMap { run in run.link.map { (String(text[run.range].characters), $0) } }
  }

  // MARK: Wikilinks

  @Test func wikilinksBecomeNoteLinksShownByTheirLabel() throws {
    let text = try paragraph(
      "See [[Ideas]], [[Projects/Launch Plan#Goals|the plan]] and [[Projects/Garden Redesign#Beds]]."
    )
    #expect(String(text.characters) == "See Ideas, the plan and Garden Redesign › Beds.")
    let found = links(text)
    #expect(found.map(\.0) == ["Ideas", "the plan", "Garden Redesign › Beds"])
    #expect(
      found.map { WikiLinkURL.target(of: $0.1) } == [
        "Ideas", "Projects/Launch Plan#Goals", "Projects/Garden Redesign#Beds",
      ])
    // Emphasis around a wikilink is kept.
    let bold = try paragraph("**[[Ideas]]**")
    #expect(bold.runs.first?.inlinePresentationIntent?.contains(.stronglyEmphasized) == true)
    #expect(bold.runs.first?.link != nil)
  }

  @Test func wikilinksInCodeOrWithoutANoteStayText() throws {
    #expect(links(try paragraph("Use `[[Ideas]]` to link")).isEmpty)
    #expect(String(try paragraph("A [[#Heading]] link").characters) == "A [[#Heading]] link")
    #expect(links(try paragraph("Broken [[ ]] and [[a\nb]]")).isEmpty)
    #expect(links(MarkdownRenderer.inline("inline [[Ideas|ideas]] too")).map(\.0) == ["ideas"])
  }

  @Test func wikiLinkURLsRoundTrip() throws {
    for target in ["Ideas", "Projects/Launch Plan#Goals", "Daily/2026-09-24", "Café & co?"] {
      let url = try #require(WikiLinkURL.url(for: target))
      #expect(url.scheme == WikiLinkURL.scheme)
      #expect(WikiLinkURL.target(of: url) == target)
      #expect(!LinkPolicy.isAllowed(url), "wikilinks never leave the app")
    }
    #expect(WikiLinkURL.target(of: URL(string: "https://x.example")!) == nil)
    #expect(WikiLinkURL.noteName("Projects/Launch Plan.md#Goals") == "Launch Plan")
  }

  // MARK: Previews

  @Test func pagePreviewsComeFromTheSourcesElseTheLink() {
    let sources = SampleData.desksSources
    let cited = LinkPreview.make(
      url: "https://office-shop.example/lift-2#deals", label: "2", sources: sources)
    #expect(cited.title == "Sample Lift 2 standing desk")
    #expect(cited.host == "office-shop.example")
    #expect(cited.snippet == "Single motor, 27–47 in. Regularly discounted to $349.")
    #expect(cited.url == "https://office-shop.example/lift-2#deals")
    #expect(
      cited.text
        == "Sample Lift 2 standing desk\noffice-shop.example\nSingle motor, 27–47 in. Regularly discounted to $349.\nhttps://office-shop.example/lift-2#deals"
    )
    // Matching ignores www., a trailing slash and http vs https.
    #expect(
      LinkPreview.make(url: "http://www.desks.example/rise-pro/", label: nil, sources: sources)
        .title == "Example Rise Pro — Desks Example")
    // Without a source: the link text, or the hostname for a bare number.
    let plain = LinkPreview.make(
      url: "https://www.news.example/story?id=4", label: "The story", sources: sources)
    #expect(
      plain
        == LinkPreview(
          title: "The story", host: "news.example", url: "https://www.news.example/story?id=4"))
    #expect(
      LinkPreview.make(url: "https://news.example/a", label: "7", sources: []).title
        == "news.example")
    #expect(
      LinkPreview.make(url: "https://news.example/a", label: "https://news.example/a", sources: [])
        .text == "news.example\nhttps://news.example/a")
    #expect(
      LinkPreview.isCitationLabel("12") && !LinkPreview.isCitationLabel("1a")
        && !LinkPreview.isCitationLabel("1234"))
    #expect(
      NotePreview(title: "Ideas", lines: ["# Ideas", "- one"]).text == "Ideas\n# Ideas\n- one")
  }

  // MARK: Rich text

  @Test func citationsAreRaisedChipsAndLinksAreUnderlined() throws {
    let text = try paragraph(
      "Pick **Rise Pro**[1](https://desks.example/rise-pro), see [the review](https://reviews.example/x) and `code`."
    )
    let attributed = AgentRichText.attributed(text, style: .body)
    let string = attributed.string as NSString
    let citation = string.range(of: "1")
    #expect(
      attributed.attribute(.agentCitation, at: citation.location, effectiveRange: nil) as? Bool
        == true)
    #expect(
      attributed.attribute(.baselineOffset, at: citation.location, effectiveRange: nil) as? CGFloat
        == AgentRichText.citationBaselineOffset)
    #expect(
      attributed.attribute(.kern, at: citation.location - 1, effectiveRange: nil) != nil,
      "room before the chip")
    #expect(
      attributed.attribute(.underlineStyle, at: citation.location, effectiveRange: nil) == nil)
    let review = string.range(of: "the review")
    #expect(
      attributed.attribute(.underlineStyle, at: review.location, effectiveRange: nil) as? Int
        == NSUnderlineStyle.single.rawValue)
    #expect(
      attributed.attribute(.link, at: review.location, effectiveRange: nil) as? URL
        == URL(string: "https://reviews.example/x"))
    let bold = try #require(
      attributed.attribute(.font, at: string.range(of: "Rise").location, effectiveRange: nil)
        as? NSFont)
    #expect(bold.fontDescriptor.symbolicTraits.contains(.bold))
    let code = try #require(
      attributed.attribute(.font, at: string.range(of: "code").location, effectiveRange: nil)
        as? NSFont)
    #expect(code.isFixedPitch)
  }

  final class OpenedNotes {
    var targets: [String] = []
  }

  private func textView(
    _ source: String, sources: [CitedSource] = [], opened: OpenedNotes = OpenedNotes()
  ) throws -> CitationTextView {
    let view = CitationTextView()
    view.sources = sources
    view.noteLinks = AgentNoteLinks(open: { opened.targets.append($0) }, preview: { _ in nil })
    view.setContent(try paragraph(source), style: .body)
    view.frame = NSRect(x: 0, y: 0, width: 420, height: view.height(forWidth: 420))
    view.layoutManager?.ensureLayout(for: view.textContainer!)
    return view
  }

  private func center(of needle: String, in view: CitationTextView) -> NSPoint {
    let range = (view.string as NSString).range(of: needle)
    let rect = view.anchorRect(of: range)
    return NSPoint(x: rect.midX, y: rect.midY)
  }

  @Test func theTextViewKnowsTheLinkUnderThePointer() throws {
    let view = try textView(
      "Pick Rise Pro, dual motor [1](https://desks.example/rise-pro); see [[Projects/Home Office|your home office note]].",
      sources: SampleData.desksSources)
    let first = try #require(view.link(at: center(of: "1", in: view)))
    #expect(first.url.absoluteString == "https://desks.example/rise-pro")
    guard case .page(let preview) = view.previewContent(for: first) else {
      Issue.record("a page")
      return
    }
    #expect(preview.title == "Example Rise Pro — Desks Example")
    let note = try #require(view.link(at: center(of: "your home office note", in: view)))
    #expect(view.previewContent(for: note) == .note("Projects/Home Office"))
    #expect(view.link(at: center(of: "dual motor", in: view)) == nil)
  }

  @Test func clicksFollowThePolicyAndOpenNotes() throws {
    let opened = OpenedNotes()
    let view = try textView("See [[Ideas]] or [x](javascript:alert(1))", opened: opened)
    let note = try #require(WikiLinkURL.url(for: "Ideas"))
    #expect(view.textView(view, clickedOnLink: note, at: 4))
    #expect(opened.targets == ["Ideas"])
    // Anything the policy refuses is swallowed, never opened.
    #expect(view.textView(view, clickedOnLink: URL(string: "file:///etc/hosts")!, at: 0))
    #expect(opened.targets == ["Ideas"])
  }

  @Test func hoveringALinkTracksItUntilThePointerLeaves() throws {
    let view = try textView(
      "Tallest downtown [2](https://skyline.example/towers#ridge), saved to [[Ideas]].",
      sources: SampleData.questionSources)
    view.hover(at: center(of: "2", in: view))
    #expect(view.hoveredLink?.url.absoluteString == "https://skyline.example/towers#ridge")
    view.hover(at: center(of: "Ideas", in: view))
    #expect(view.hoveredLink.map { WikiLinkURL.target(of: $0.url) } == "Ideas")
    view.hover(at: nil)
    #expect(view.hoveredLink == nil)
    #expect(view.popover == nil, "offscreen views show no card")
  }

  /// The chip is drawn around the raised digit, inside its line (checked on pixels).
  @Test func chipsSurroundTheirDigits() throws {
    let view = try textView("with its spire [1](https://x.example/a). It has")
    let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / view.bounds.width
    let digit = view.anchorRect(of: (view.string as NSString).range(of: "1"))
    func bounds(_ matches: (NSColor) -> Bool) -> NSRect {
      var found = NSRect.null
      for y in 0..<rep.pixelsHigh {
        for x in Int((digit.minX - 8) * scale)..<Int((digit.maxX + 4) * scale) {
          guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), matches(color) else {
            continue
          }
          found = found.union(
            NSRect(
              x: CGFloat(x) / scale, y: CGFloat(y) / scale, width: 1 / scale, height: 1 / scale))
        }
      }
      return found
    }
    let ink = bounds { $0.alphaComponent > 0.5 && $0.blueComponent > $0.redComponent + 0.3 }
    let chip = bounds {
      $0.alphaComponent > 0.05 && $0.alphaComponent < 0.4
        && $0.blueComponent > $0.redComponent + 0.2
    }
    #expect(!ink.isNull && !chip.isNull)
    #expect(chip.insetBy(dx: -0.5, dy: -0.5).contains(ink), "chip \(chip) around digit \(ink)")
    #expect(abs(chip.midX - ink.midX) < 1 && abs(chip.midY - ink.midY) < 1.5)
    #expect(chip.minY >= 0 && chip.maxY < view.bounds.height)
  }

  @Test func heightsFollowTheWidth() throws {
    let view = try textView(SampleData.desksAnswer)
    let narrow = view.height(forWidth: 200)
    let wide = view.height(forWidth: 800)
    #expect(narrow > wide)
    #expect(wide > 10)
    #expect(view.naturalWidth > 800)
  }
}
