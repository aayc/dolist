import AppKit
import DailyDoListUI
import Testing

@testable import DailyDoListEditor

@Suite("Agent lines: markers, sparkles, anchored lines, link previews")
@MainActor
struct AgentLineTests {
  // MARK: Tokenizer

  @Test func aMarkerEndingTheLineMakesItTheAgents() throws {
    let task = tokenizeLine("- [ ] Call the restaurant %%agent:thr_9%%")
    #expect(
      task.agent == AgentMarkerToken(range: NSRange(location: 25, length: 16), threadId: "thr_9"))
    #expect(task.task?.status == UTF16Unit.space)
    #expect(markers("- [ ] Call the restaurant %%agent:thr_9%%", .agent) == [" %%agent:thr_9%%"])
    #expect(
      spans("- [ ] Call the restaurant %%agent:thr_9%%", .agent) == ["- [ ] Call the restaurant"])

    // The text before the marker is tokenized like any line: no closing heading hashes, links.
    #expect(markers("## Trip to Lisbon %%agent%%", .heading) == ["## "])
    #expect(tokenizeLine("## Trip to Lisbon %%agent%%").agent?.threadId == nil)
    let cited = "  - Table at 7 ([Sole](https://sole.example/r)) %%agent:thr_1%%\t"
    #expect(linkTargets(cited) == [.url("https://sole.example/r")])
    #expect(markers(cited, .agent) == [" %%agent:thr_1%%\t"])
    #expect(tokenizeLine("%%agent:x%%").agent?.range == NSRange(location: 0, length: 11))
  }

  @Test func onlyAMarkerAtTheEndCounts() {
    for line in [
      "%%agent%% in the middle", "text %%agent%% x", "- a %%agent:%%", "- a %%Agent%%",
      "- a %%agent:bad id%%",
      "- a %%agent:\(String(repeating: "a", count: 65))%%",
    ] {
      #expect(tokenizeLine(line).agent == nil, "\(line)")
    }
    #expect(tokenizeLine("- a %%agent:\(String(repeating: "a", count: 64))%%").agent != nil)
    #expect(tokenizeLine("- a %%agent:%%agent%%").agent?.range == NSRange(location: 12, length: 9))
  }

  @Test func codeAndFrontmatterStayLiteral() {
    let lines = MarkdownTokenizer.tokenize(
      "---\ntitle: x %%agent%%\n---\n```\ncode %%agent%%\n```\ntext %%agent%%")
    #expect(
      lines.map { $0.tokens.agent != nil } == [false, false, false, false, false, false, true])
  }

  // MARK: Styling and live preview

  private static let note = [
    "- [ ] Book a table for Friday",
    "  - Trattoria Sole has a table at 7 PM ([OpenTable](https://booking.example/r/sole)) %%agent:thr_ab12%%",
    "- [ ] Call the restaurant to confirm %%agent:thr_ab12%%",
    "What's the tallest building here? %%agent%%",
    "End",
  ].joined(separator: "\n")

  private func editor(_ configuration: EditorConfiguration = EditorConfiguration()) -> EditorHarness
  {
    let length = (Self.note as NSString).length
    return EditorHarness(
      text: Self.note, selection: NSRange(location: length, length: 0), configuration: configuration
    )
  }

  @Test func agentTextHasItsOwnColorAndTheMarkerIsFaint() throws {
    let editor = editor()
    let storage = editor.controller.storage
    func color(at needle: String, offset: Int = 0) -> NSColor? {
      storage.attribute(
        .foregroundColor, at: editor.offset(of: needle) + offset, effectiveRange: nil) as? NSColor
    }
    #expect(color(at: "Trattoria") == EditorColors.agentText)
    #expect(color(at: "OpenTable") == EditorColors.accent)
    #expect(color(at: "Call the restaurant") == EditorColors.agentText)
    #expect(color(at: "Book a table") == EditorColors.text)
    #expect(color(at: "%%agent:thr_ab12%%") == EditorColors.tertiaryText)
    // Bullets and checkboxes keep their colors.
    #expect(color(at: "- Trattoria") == EditorColors.secondaryText)
    #expect(color(at: "- [ ] Call") == EditorColors.secondaryText)
  }

  @Test func livePreviewHidesTheMarkerBehindASparkleAndRevealsItWithItsLine() throws {
    let editor = editor()
    editor.layout()
    let marker = editor.range(of: " %%agent:thr_ab12%%\n- [ ] Call")
    let markerRange = NSRange(
      location: marker.location, length: (" %%agent:thr_ab12%%" as NSString).length)
    // Everything but the sparkle's slot (the blank before the marker) is hidden.
    #expect(editor.hiddenCharacters(in: markerRange) == markerRange.length - 1)
    #expect(editor.glyphProperty(at: markerRange.location) == .controlCharacter)
    let slot = editor.advance(
      ofGlyph: editor.controller.layoutManager.glyphIndexForCharacter(at: markerRange.location))
    #expect(
      abs(slot - editor.controller.theme.agentSlotWidth(font: editor.controller.theme.bodyFont))
        < 0.5)

    let sparkles = editor.controller.agentSparkles()
    #expect(sparkles.map(\.threadId) == ["thr_ab12", "thr_ab12", nil])
    #expect(sparkles.map(\.toolTip).last == "Written by the agent")

    // On the caret's line the marker shows as (faint) text, and no sparkle is drawn.
    editor.select(NSRange(location: editor.offset(of: "Trattoria"), length: 0))
    editor.layout()
    #expect(editor.hiddenCharacters(in: markerRange) == 0)
    #expect(editor.controller.agentSparkles().count == 2)
  }

  @Test func sourceModeShowsTheMarker() {
    let editor = editor(EditorConfiguration(livePreview: false))
    editor.layout()
    let marker = editor.range(of: " %%agent%%")
    #expect(editor.hiddenCharacters(in: marker) == 0)
    #expect(editor.controller.agentSparkles().isEmpty)
    #expect(
      editor.controller.storage.attribute(
        .foregroundColor, at: editor.offset(of: "tallest"), effectiveRange: nil) as? NSColor
        == EditorColors.agentText)
  }

  @Test func clickingASparkleOpensItsThread() throws {
    let editor = editor()
    editor.layout()
    let sparkles = editor.controller.agentSparkles()
    let first = try #require(sparkles.first)
    #expect(
      editor.controller.handleClick(
        at: NSPoint(x: first.rect.midX, y: first.rect.midY), modifiers: []))
    #expect(editor.delegate.agentThreadClicks == ["thr_ab12"])
    #expect(
      editor.controller.textView(
        editor.textView, toolTipAt: NSPoint(x: first.rect.midX, y: first.rect.midY))
        == "Written by the agent — open thread")
    // Without a thread the sparkle is just a mark.
    let plain = try #require(sparkles.last)
    #expect(
      !editor.controller.handleClick(
        at: NSPoint(x: plain.rect.midX, y: plain.rect.midY), modifiers: []))
    #expect(editor.delegate.agentThreadClicks == ["thr_ab12"])
    #expect(editor.text == Self.note)
  }

  // MARK: Editing agent lines

  @Test func aCaretPastTheEndOfAHiddenMarkerGoesBeforeIt() {
    let editor = editor()
    let lineEnd = editor.offset(of: "\nWhat's")
    editor.select(NSRange(location: lineEnd, length: 0))
    #expect(editor.selection.location == editor.offset(of: " %%agent:thr_ab12%%\nWhat's"))
    editor.type("!")
    #expect(editor.text.contains("- [ ] Call the restaurant to confirm! %%agent:thr_ab12%%\n"))
    // On the revealed line the caret can go past the marker.
    let end = editor.offset(of: "\nWhat's")
    editor.select(NSRange(location: end, length: 0))
    #expect(editor.selection.location == end)
  }

  @Test func enterBeforeTheMarkerKeepsItOnTheAgentsLine() {
    let editor = editor()
    editor.select(NSRange(location: editor.offset(of: "\nWhat's"), length: 0))
    editor.enter()
    #expect(
      editor.text.contains(
        "- [ ] Call the restaurant to confirm %%agent:thr_ab12%%\n- [ ] \nWhat's"))
    let prose = editor.offset(of: " %%agent%%")
    editor.select(NSRange(location: prose, length: 0))
    editor.enter()
    #expect(editor.text.contains("What's the tallest building here? %%agent%%\n\nEnd"))
  }

  // MARK: Anchored lines

  @Test func anAnchoredLineGetsABandWhileItsBadgeIsDrawn() throws {
    let editor = editor()
    let question = 3
    editor.controller.setBadges([
      EditorBadge(
        id: "anc_q", line: question, status: "done", label: "Done · 1,250 ft", highlightsLine: true),
      EditorBadge(id: "t1", line: 0, status: "working", label: "Working…"),
    ])
    editor.layout()
    let bands = editor.controller.anchoredLineBands(in: editor.textView.visibleRect)
    #expect(bands.count == 1)
    let band = try #require(bands.first)
    let line = editor.controller.lineRectInTextView(at: editor.offset(of: "What's"))
    #expect(abs(band.midY - line.midY) < 2)
    #expect(band.minX < editor.textView.textContainerOrigin.x)
    #expect(band.width > editor.controller.textContainer.size.width)

    // It follows the line through edits above it, and goes away with a hidden badge.
    editor.select(NSRange(location: 0, length: 0))
    editor.type("x\n")
    editor.layout()
    let moved = try #require(
      editor.controller.anchoredLineBands(in: editor.textView.visibleRect).first)
    #expect(moved.minY > band.minY)
    editor.controller.setBadges([
      EditorBadge(id: "anc_q", line: 4, status: "idle", label: "", highlightsLine: true)
    ])
    #expect(editor.controller.anchoredLineBands(in: editor.textView.visibleRect).isEmpty)
  }

  // MARK: Link previews

  @Test func linkPreviewsKnowTheLabelAndTheAgentThreadOfTheLine() throws {
    let text =
      "[[Projects/Launch Plan#Goals|the plan]] and https://site.example/a\n- note [Site](https://site.example/b) %%agent:thr_7%%\nx"
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0))
    editor.layout()
    let wiki = try #require(
      editor.controller.link(at: editor.point(at: editor.range(of: "the plan"))))
    #expect(
      editor.controller.linkPreview(for: wiki)
        == EditorLinkPreview(
          target: .note(target: "Projects/Launch Plan", subpath: "Goals"), label: "the plan"))
    let bare = try #require(
      editor.controller.link(at: editor.point(at: editor.range(of: "site.example/a"))))
    #expect(editor.controller.linkPreview(for: bare)?.label == "https://site.example/a")
    let cited = try #require(editor.controller.link(at: editor.point(at: editor.range(of: "Site"))))
    let preview = try #require(editor.controller.linkPreview(for: cited))
    #expect(
      preview
        == EditorLinkPreview(
          target: .external(URL(string: "https://site.example/b")!), label: "Site",
          agentThreadId: "thr_7"))
    #expect(preview.fallbackText == "Site\nsite.example\nhttps://site.example/b")

    // The tooltip asks the host, and falls back without an answer.
    let point = editor.point(at: editor.range(of: "Site"))
    #expect(editor.controller.textView(editor.textView, toolTipAt: point) == preview.fallbackText)
    editor.delegate.previewAnswer = "Sole — booking page"
    #expect(editor.controller.textView(editor.textView, toolTipAt: point) == "Sole — booking page")
    #expect(editor.delegate.previewRequests.last == preview)
    // Hovering a link asks once, so the host can start loading.
    editor.delegate.previewRequests.removeAll()
    editor.controller.textView(editor.textView, mouseMovedTo: point, modifiers: [])
    editor.controller.textView(
      editor.textView, mouseMovedTo: NSPoint(x: point.x + 1, y: point.y), modifiers: [])
    #expect(editor.delegate.previewRequests == [preview])
    #expect(
      EditorLinkPreview(target: .note(target: "A", subpath: nil), label: "A").fallbackText == "A")
  }

  /// Badges, the sparkle and links show the app's shared tooltip (pointing at what's hovered),
  /// gliding from one to the next and fading when the pointer leaves them.
  @Test func badgesSparklesAndLinksShowTheSharedTooltip() throws {
    let text = "- [ ] Call Sole %%agent:thr_1%%\n[[Note]] and [docs](https://docs.example/x)\nplain"
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0))
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.contentView = editor.controller.view
    defer { window.close() }
    editor.controller.setBadges([
      EditorBadge(id: "b", line: 0, status: "working", label: "Calling the restaurant", unread: 2)
    ])
    editor.layout()
    let tooltips = editor.tooltips
    func hover(_ point: NSPoint?) {
      editor.controller.textView(editor.textView, mouseMovedTo: point, modifiers: [])
    }

    let badge = try #require(editor.controller.currentBadgeLayouts().first)
    hover(NSPoint(x: badge.rect.midX, y: badge.rect.midY))
    #expect(tooltips.presenter.shown == nil, "not before the delay")
    tooltips.clock.advance(by: 0.5)
    #expect(tooltips.presenter.shown?.content.plainText == "Calling the restaurant · 2 unread")
    #expect(
      tooltips.presenter.shown?.anchor
        == window.convertToScreen(editor.textView.convert(badge.rect, to: nil)))

    let sparkle = try #require(editor.controller.agentSparkles().first)
    hover(NSPoint(x: sparkle.rect.midX, y: sparkle.rect.midY))
    #expect(
      tooltips.presenter.shown?.content.plainText == "Written by the agent — open thread",
      "the next one shows at once")
    #expect(tooltips.presenter.animations.last == .glide)

    let note = editor.point(at: editor.range(of: "Note"))
    hover(note)
    #expect(tooltips.presenter.shown?.content.plainText == "Note")
    let anchor = try #require(tooltips.presenter.shown?.anchor)
    #expect(
      anchor.contains(
        window.convertToScreen(editor.textView.convert(NSRect(origin: note, size: .zero), to: nil))
          .origin))
    hover(NSPoint(x: note.x + 1, y: note.y))
    #expect(tooltips.presenter.animations.count == 3, "moving within a link keeps its tooltip")

    hover(editor.point(at: editor.range(of: "plain")))
    #expect(tooltips.presenter.shown == nil)
    #expect(tooltips.presenter.animations.last == .exit)

    // A note switch takes a hovered badge's tooltip with it.
    hover(NSPoint(x: badge.rect.midX, y: badge.rect.midY))
    tooltips.clock.advance(by: 0.5)
    #expect(tooltips.presenter.shown != nil)
    editor.controller.setText("other note", resetUndo: true)
    #expect(tooltips.presenter.shown == nil)
    #expect(tooltips.presenter.animations.last == TooltipAnimation.Kind.none)
  }

  // MARK: Remote changes

  @Test func remoteChangesAtTheSamePlaceApplyInTheOrderGiven() {
    // Lines inserted before an empty line that the next change removes (with the rest).
    let editor = EditorHarness("a\n\nb|")
    editor.controller.applyRemoteChanges([
      EditorTextChange(range: NSRange(location: 2, length: 0), text: "x\n"),
      EditorTextChange(range: NSRange(location: 2, length: 2), text: ""),
    ])
    #expect(editor.text == "a\nx\n")
  }

  @Test func remoteChangesKeepTheCaretAndTheUsersUndo() throws {
    let editor = EditorHarness("# Day\n- [ ] Book a table|\n- [ ] Renew passport\nNotes")
    editor.type(" for two")
    editor.controller.setBadges([
      EditorBadge(id: "t2", line: 2, status: "working", label: "Working…")
    ])
    let caret = editor.selection
    let insert = editor.offset(of: "- [ ] Renew")
    let notes = editor.range(of: "Notes")
    let reported = editor.delegate.textChanges.count
    editor.act {
      editor.controller.applyRemoteChanges([
        EditorTextChange(
          range: NSRange(location: insert, length: 0),
          text: "  - Trattoria Sole at 7 PM %%agent:thr_1%%\n"),
        EditorTextChange(range: notes, text: "Notes (updated)"),
      ])
    }
    #expect(
      editor.text
        == "# Day\n- [ ] Book a table for two\n  - Trattoria Sole at 7 PM %%agent:thr_1%%\n- [ ] Renew passport\nNotes (updated)"
    )
    #expect(editor.selection == caret)
    #expect(editor.controller.badges.map(\.line) == [3])
    #expect(editor.delegate.textChanges.count == reported)
    editor.undo()
    #expect(editor.text == "# Day\n- [ ] Book a table for two\n- [ ] Renew passport\nNotes")
    editor.undo()
    #expect(editor.text == "# Day\n- [ ] Book a table\n- [ ] Renew passport\nNotes")
  }
}
