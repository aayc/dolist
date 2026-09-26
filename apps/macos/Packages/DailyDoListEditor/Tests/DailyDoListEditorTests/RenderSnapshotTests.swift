import AppKit
import DailyDoListUI
import DailyDoListUITestSupport
import Testing

@testable import DailyDoListEditor

/// Renders the sample note offscreen in light and dark appearance and writes PNGs to the package's
/// `.build/editor-snapshots/` for manual review (never committed).
@Suite("Offscreen rendering")
@MainActor
struct RenderSnapshotTests {
  static var outputDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // DailyDoListEditorTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // package root
      .appendingPathComponent(".build/editor-snapshots", isDirectory: true)
  }

  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersSampleNote(name: String, appearance: NSAppearance.Name) throws {
    let editor = EditorHarness(text: SampleNote.text, size: NSSize(width: 900, height: 1200))
    editor.controller.scrollView.appearance = NSAppearance(named: appearance)
    editor.controller.setBadges(SampleNote.badges(for: editor.text))
    // Caret on the formatting line: its syntax shows raw, everything else renders.
    editor.select(NSRange(location: editor.offset(of: "Plan for today") + 5, length: 0))
    let png = try render(editor)
    #expect(png.count > 10_000)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("sample-\(name).png"))
  }

  @Test func rendersBadgesInTheReservedMargin() throws {
    let text = [
      "- [ ] Research the best espresso machines under $500",
      "- [ ] Book a table for 4 at Nopa on Friday at 7pm",
      "- [ ] How many grams is 2 cups of flour?",
    ].joined(separator: "\n")
    let editor = EditorHarness(text: text, size: NSSize(width: 600, height: 300))
    editor.controller.scrollView.appearance = NSAppearance(named: .darkAqua)
    editor.controller.setBadges([
      EditorBadge(id: "a", line: 0, status: "done", label: "Done · Summary ready", unread: 4),
      EditorBadge(id: "b", line: 1, status: "waiting_approval", label: "Needs approval", unread: 4),
      EditorBadge(id: "c", line: 2, status: "done", label: "Done · About 250 g", unread: 1),
    ])
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("badges-narrow.png"))

    // A pill that starts inside the text column and ends in the margin is drawn in full.
    let column = editor.textView.textContainerOrigin.x + editor.controller.textContainer.size.width
    let layouts = editor.controller.currentBadgeLayouts()
    let crossing = try #require(
      layouts.first { $0.rect.minX < column && $0.rect.maxX > column + 24 })
    let rep = try snapshot(editor.textView)
    let scale = CGFloat(rep.pixelsWide) / editor.textView.bounds.width
    var colors = Set<UInt32>()
    for x in stride(from: column + 4, to: crossing.rect.maxX - 2, by: 1) {
      guard
        let color = rep.colorAt(x: Int(x * scale), y: Int(crossing.rect.midY * scale))?
          .usingColorSpace(.sRGB)
      else { continue }
      colors.insert(
        UInt32(color.redComponent * 255) << 16 | UInt32(color.greenComponent * 255) << 8
          | UInt32(color.blueComponent * 255))
    }
    #expect(
      colors.count > 2, "the part of badge \(crossing.badge.id) right of the text column is blank")
  }

  /// Every drawn status, light and dark: only "needs you" and "failed" are tinted, working badges
  /// are neutral pills, finished ones are bare text (checked on pixels right of the label).
  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersBadgesInEveryStatus(name: String, appearance: NSAppearance.Name) throws {
    let statuses: [(status: String, label: String, unread: Int)] = [
      ("waiting_approval", "Needs approval", 0), ("waiting_user", "Needs your input", 1),
      ("failed", "Failed · Site down", 0),
      ("triaging", "Triaging…", 0), ("queued", "Queued", 0), ("working", "Comparing fares", 2),
      ("done", "Done · 3 options", 0),
      ("done", "Done · Summary ready", 3), ("cancelled", "Stopped", 0),
    ]
    let text = statuses.map { "- [ ] Task \($0.status)" }.joined(separator: "\n")
    let editor = EditorHarness(text: "Tasks\n" + text, size: NSSize(width: 720, height: 360))
    editor.controller.scrollView.appearance = NSAppearance(named: appearance)
    editor.controller.setBadges(
      statuses.enumerated().map { index, item in
        EditorBadge(
          id: "b\(index)", line: index + 1, status: item.status, label: item.label,
          unread: item.unread)
      })
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("badges-\(name).png"))

    let rep = try snapshot(editor.textView)
    let scale = CGFloat(rep.pixelsWide) / editor.textView.bounds.width
    func color(_ point: NSPoint) throws -> NSColor {
      try #require(
        rep.colorAt(x: Int(point.x * scale), y: Int(point.y * scale))?.usingColorSpace(.sRGB))
    }
    func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
      abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent)
        + abs(a.blueComponent - b.blueComponent)
    }
    /// How far from gray a color is.
    func saturation(_ c: NSColor) -> CGFloat {
      max(c.redComponent, c.greenComponent, c.blueComponent)
        - min(c.redComponent, c.greenComponent, c.blueComponent)
    }
    let layouts = editor.controller.currentBadgeLayouts()
    #expect(layouts.count == statuses.count)
    for layout in layouts {
      // Right of the pill, and inside it between the label (or unread dot) and the edge.
      let background = try color(NSPoint(x: layout.rect.maxX + 6, y: layout.rect.midY))
      let inside = try color(NSPoint(x: layout.rect.maxX - 4, y: layout.rect.midY))
      let status = layout.badge.status
      switch BadgeTier(status: status) {
      case .needsYou, .failed:
        #expect(saturation(inside) > 0.04, "\(status) is tinted")
      case .working:
        #expect(distance(inside, background) > 0.03, "\(status) is a pill")
        // Neutral: no more tinted than the palette's (slightly blue) surfaces.
        #expect(abs(saturation(inside) - saturation(background)) < 0.04, "\(status) is neutral")
      case .quiet:
        #expect(distance(inside, background) < 0.01, "\(status) has no fill")
      }
    }
  }

  /// The orchestrator's chips in every state, light and dark, next to a task's triage badge: a
  /// quiet dot, neutral pills while it looks and acts, quiet outcomes, a warning pill when it
  /// needs the user (checked on pixels like the badges).
  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersOrchestratorChips(name: String, appearance: NSAppearance.Name) throws {
    typealias Chip = EditorBadge.OrchestratorStatus
    let chips: [(line: String, status: String, label: String)] = [
      ("find a quiet dishwasher", Chip.noticed, ""),
      ("What's a good desk height?", Chip.looking, "Orchestrator is looking…"),
      ("plan the offsite for October", Chip.acting, "Working…"),
      ("call mom tomorrow", Chip.done, "Added a task ↗"),
      ("look up flights to Lisbon", Chip.done, "Added 3 tasks ↗"),
      ("How tall is Ridge Tower?", Chip.done, "Replied ↗"),
      ("book the dentist", Chip.needsYou, "Needs your approval ↗"),
      ("Had a long walk by the river", Chip.nothing, "Nothing to do"),
    ]
    let text = (["Thursday"] + chips.map(\.line) + ["- [ ] Renew the passport"])
      .joined(separator: "\n")
    let editor = EditorHarness(
      text: text, selection: NSRange(location: 0, length: 0), size: NSSize(width: 760, height: 360))
    editor.controller.scrollView.appearance = NSAppearance(named: appearance)
    editor.controller.setBadges(
      chips.enumerated().map { index, chip in
        EditorBadge(
          id: "orchestrator:\(index)", line: index + 1, status: chip.status, label: chip.label,
          anchorText: chip.line)
      } + [
        EditorBadge(id: "t", line: chips.count + 1, status: "triaging", label: "Triaging…")
      ])
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("chips-\(name).png"))

    let rep = try snapshot(editor.textView)
    let scale = CGFloat(rep.pixelsWide) / editor.textView.bounds.width
    func color(_ point: NSPoint) throws -> NSColor {
      try #require(
        rep.colorAt(x: Int(point.x * scale), y: Int(point.y * scale))?.usingColorSpace(.sRGB))
    }
    func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
      abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent)
        + abs(a.blueComponent - b.blueComponent)
    }
    let layouts = editor.controller.currentBadgeLayouts()
    #expect(layouts.count == chips.count + 1)
    for layout in layouts {
      let background = try color(NSPoint(x: layout.rect.maxX + 6, y: layout.rect.midY))
      let inside = try color(NSPoint(x: layout.rect.maxX - 3, y: layout.rect.midY))
      switch BadgeTier(status: layout.badge.status) {
      case .working, .needsYou:
        #expect(distance(inside, background) > 0.03, "\(layout.badge.status) is a pill")
      case .quiet, .failed:
        #expect(distance(inside, background) < 0.01, "\(layout.badge.status) has no fill")
      }
    }
    let dot = try #require(layouts.first { $0.badge.status == Chip.noticed })
    let center = try color(
      NSPoint(x: editor.controller.badgeRenderer.dotRect(in: dot.rect).midX, y: dot.rect.midY))
    let beside = try color(NSPoint(x: dot.rect.maxX + 6, y: dot.rect.midY))
    #expect(distance(center, beside) > 0.3, "the noticed dot is drawn")
  }

  /// A frame in the middle of every kind of motion (for review): a badge fading in, one
  /// crossfading from working to done, a triaging dot at its faintest, a checkmark popping in.
  @Test func rendersAFrameOfMotion() throws {
    let text = "- [ ] Appearing\n- [ ] Crossfading\n- [ ] Triaging\n- [ ] Checked\nEnd"
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0),
      size: NSSize(width: 640, height: 220))
    editor.controller.scrollView.appearance = NSAppearance(named: .aqua)
    let motion = ManualMotion(editor)
    editor.controller.setBadges([
      EditorBadge(id: "b", line: 1, status: "working", label: "Working…"),
      EditorBadge(id: "c", line: 2, status: "triaging", label: "Triaging…"),
    ])
    editor.layout()
    editor.willDraw()
    motion.now += 0.53
    editor.controller.setBadges([
      EditorBadge(id: "a", line: 0, status: "queued", label: "Queued"),
      EditorBadge(id: "b", line: 1, status: "done", label: "Done · 3 options", unread: 1),
      EditorBadge(id: "c", line: 2, status: "triaging", label: "Triaging…"),
    ])
    let checkbox = try #require(editor.controller.checkboxRects().first { $0.line == 3 })
    #expect(
      editor.controller.handleClick(
        at: NSPoint(x: checkbox.rect.midX, y: checkbox.rect.midY), modifiers: []))
    motion.frame(after: 0.07)
    #expect(motion.isTicking)
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("motion-frame.png"))
  }

  static let agentNote = [
    "# Thursday",
    "- [ ] Book a table for Friday dinner",
    "  - Trattoria Sole has a table for 2 at 7:00 PM ([Sole bookings](https://sole.example/book)) %%agent:thr_ab12%%",
    "- [ ] Call the restaurant to confirm %%agent:thr_ab12%%",
    "What's the tallest building downtown?",
    "- [x] Renew the library books",
    "## Trip ideas %%agent:thr_2%%",
    "Notes from the [[Launch Plan]] review.",
  ].joined(separator: "\n")

  static func agentBadges(_ text: String) -> [EditorBadge] {
    [
      EditorBadge(
        id: "t1", line: 1, status: "done", label: "Done · Table held", unread: 1,
        threadId: "thr_ab12"),
      EditorBadge(
        id: "anc_q", line: 4, status: "done", label: "Done · Ridge Tower, 1,250 ft",
        threadId: "thr_q", highlightsLine: true),
    ]
  }

  /// Agent lines (sparkles, agent text color) and a line a thread is anchored to (band, bar,
  /// badge), light and dark; the caret sits on the last line.
  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersAgentLinesAndAnAnchoredLine(name: String, appearance: NSAppearance.Name) throws {
    let text = Self.agentNote
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0),
      size: NSSize(width: 900, height: 360))
    editor.controller.scrollView.appearance = NSAppearance(named: appearance)
    editor.controller.setBadges(Self.agentBadges(text))
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("agent-lines-\(name).png"))

    // The band is drawn: accent-tinted pixels left of the question's text, over the background.
    let rep = try snapshot(editor.textView)
    let scale = CGFloat(rep.pixelsWide) / editor.textView.bounds.width
    let band = try #require(
      editor.controller.anchoredLineBands(in: editor.textView.visibleRect).first)
    func color(_ point: NSPoint) throws -> NSColor {
      try #require(
        rep.colorAt(x: Int(point.x * scale), y: Int(point.y * scale))?.usingColorSpace(.sRGB))
    }
    let bar = try color(NSPoint(x: band.minX + 1, y: band.midY))
    let fill = try color(NSPoint(x: band.minX + 5, y: band.midY))
    let outside = try color(NSPoint(x: band.minX + 5, y: band.maxY + 6))
    #expect(bar.blueComponent - bar.redComponent > 0.3, "the bar is accent blue")
    #expect(
      fill.blueComponent - fill.redComponent > outside.blueComponent - outside.redComponent + 0.02,
      "the band is tinted")
    // A sparkle is drawn in each hidden marker's slot.
    #expect(editor.controller.agentSparkles().count == 3)
  }

  /// The shared tooltip over a badge and over the agent's sparkle, where the app shows them: the
  /// real bubble, placed by the app's rules (the panel itself can't be captured offscreen).
  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersTooltipsOverABadgeAndTheSparkle(name: String, appearance: NSAppearance.Name) throws {
    let text = Self.agentNote
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0),
      size: NSSize(width: 900, height: 360))
    editor.controller.scrollView.appearance = NSAppearance(named: appearance)
    editor.textView.appearance = NSAppearance(named: appearance)
    editor.controller.setBadges(Self.agentBadges(text))
    editor.controller.scrollView.layoutSubtreeIfNeeded()
    editor.layout()
    let badge = try #require(editor.controller.currentBadgeLayouts().first)
    let sparkle = try #require(editor.controller.agentSparkles().first)
    let bounds = editor.textView.bounds
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    for (shot, rect) in [("tooltip-badge", badge.rect), ("tooltip-sparkle", sparkle.rect)] {
      let rep = try snapshot(editor.textView)
      let said = try #require(
        editor.controller.textView(editor.textView, toolTipAt: NSPoint(x: rect.midX, y: rect.midY))
      )
      let content = try #require(TooltipContent(multilineText: said))
      // The text view is flipped; the capture is drawn into bottom-up.
      let anchor = NSRect(
        x: rect.minX, y: bounds.height - rect.maxY, width: rect.width, height: rect.height)
      try TooltipSnapshot(content: content, anchor: anchor, prefersBelow: false).draw(
        into: rep, windowSize: bounds.size)
      let png = try #require(rep.representation(using: .png, properties: [:]))
      try png.write(to: Self.outputDirectory.appendingPathComponent("\(shot)-\(name).png"))
    }
  }

  @Test func rendersAgentLinesInSourceMode() throws {
    let text = Self.agentNote
    let configuration = EditorConfiguration(livePreview: false, readableLineLength: false)
    let editor = EditorHarness(
      text: text, configuration: configuration, size: NSSize(width: 1000, height: 320))
    editor.controller.scrollView.appearance = NSAppearance(named: .darkAqua)
    editor.controller.setBadges(Self.agentBadges(text))
    let png = try render(editor)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("agent-lines-source-mode.png"))
  }

  @Test func rendersSourceModeWithLineNumbers() throws {
    let configuration = EditorConfiguration(
      livePreview: false, readableLineLength: false, showLineNumbers: true)
    let editor = EditorHarness(
      text: SampleNote.text, configuration: configuration, size: NSSize(width: 900, height: 1200))
    editor.controller.scrollView.appearance = NSAppearance(named: .aqua)
    let png = try render(editor, includeRuler: true)
    #expect(png.count > 10_000)
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("sample-source-mode.png"))
  }

  /// Renders the text view (and the line-number ruler to its left when requested) to PNG data.
  private func render(_ editor: EditorHarness, includeRuler: Bool = false) throws -> Data {
    let scrollView = editor.controller.scrollView
    scrollView.layoutSubtreeIfNeeded()
    editor.layout()
    editor.textView.appearance = scrollView.appearance
    let text = try snapshot(editor.textView)
    #expect(distinctColors(try #require(text.cgImage)) > 8, "rendered image looks blank")
    guard includeRuler, let ruler = scrollView.verticalRulerView else {
      return try #require(text.representation(using: .png, properties: [:]))
    }
    ruler.appearance = scrollView.appearance
    ruler.frame.size.height = editor.textView.bounds.height
    let gutter = try snapshot(ruler)
    let composite = try #require(
      NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: gutter.pixelsWide + text.pixelsWide,
        pixelsHigh: text.pixelsHigh,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: composite)
    let height = CGFloat(text.pixelsHigh)
    gutter.draw(
      in: NSRect(
        x: 0, y: height - CGFloat(gutter.pixelsHigh), width: CGFloat(gutter.pixelsWide),
        height: CGFloat(gutter.pixelsHigh)))
    text.draw(
      in: NSRect(
        x: CGFloat(gutter.pixelsWide), y: 0, width: CGFloat(text.pixelsWide), height: height))
    NSGraphicsContext.restoreGraphicsState()
    return try #require(composite.representation(using: .png, properties: [:]))
  }

  private func snapshot(_ view: NSView) throws -> NSBitmapImageRep {
    let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: rep)
    return rep
  }
}
