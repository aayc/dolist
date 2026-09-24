import AppKit
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
    try FileManager.default.createDirectory(at: Self.outputDirectory, withIntermediateDirectories: true)
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
    try FileManager.default.createDirectory(at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("badges-narrow.png"))

    // A pill that starts inside the text column and ends in the margin is drawn in full.
    let column = editor.textView.textContainerOrigin.x + editor.controller.textContainer.size.width
    let layouts = editor.controller.currentBadgeLayouts()
    let crossing = try #require(layouts.first { $0.rect.minX < column && $0.rect.maxX > column + 24 })
    let rep = try snapshot(editor.textView)
    let scale = CGFloat(rep.pixelsWide) / editor.textView.bounds.width
    var colors = Set<UInt32>()
    for x in stride(from: column + 4, to: crossing.rect.maxX - 2, by: 1) {
      guard let color = rep.colorAt(x: Int(x * scale), y: Int(crossing.rect.midY * scale))?.usingColorSpace(.sRGB)
      else { continue }
      colors.insert(UInt32(color.redComponent * 255) << 16 | UInt32(color.greenComponent * 255) << 8 | UInt32(color.blueComponent * 255))
    }
    #expect(colors.count > 2, "the part of badge \(crossing.badge.id) right of the text column is blank")
  }

  @Test func rendersSourceModeWithLineNumbers() throws {
    let configuration = EditorConfiguration(livePreview: false, readableLineLength: false, showLineNumbers: true)
    let editor = EditorHarness(text: SampleNote.text, configuration: configuration, size: NSSize(width: 900, height: 1200))
    editor.controller.scrollView.appearance = NSAppearance(named: .aqua)
    let png = try render(editor, includeRuler: true)
    #expect(png.count > 10_000)
    try FileManager.default.createDirectory(at: Self.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: Self.outputDirectory.appendingPathComponent("sample-source-mode.png"))
  }

  /// Renders the text view (and the line-number ruler to its left when requested) to PNG data.
  private func render(_ editor: EditorHarness, includeRuler: Bool = false) throws -> Data {
    let scrollView = editor.controller.scrollView
    scrollView.layoutSubtreeIfNeeded()
    editor.layout()
    editor.textView.appearance = scrollView.appearance
    let text = try snapshot(editor.textView)
    #expect(Self.distinctColors(text) > 8, "rendered image looks blank")
    guard includeRuler, let ruler = scrollView.verticalRulerView else {
      return try #require(text.representation(using: .png, properties: [:]))
    }
    ruler.appearance = scrollView.appearance
    ruler.frame.size.height = editor.textView.bounds.height
    let gutter = try snapshot(ruler)
    let composite = try #require(
      NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: gutter.pixelsWide + text.pixelsWide, pixelsHigh: text.pixelsHigh,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: composite)
    let height = CGFloat(text.pixelsHigh)
    gutter.draw(in: NSRect(x: 0, y: height - CGFloat(gutter.pixelsHigh), width: CGFloat(gutter.pixelsWide), height: CGFloat(gutter.pixelsHigh)))
    text.draw(in: NSRect(x: CGFloat(gutter.pixelsWide), y: 0, width: CGFloat(text.pixelsWide), height: height))
    NSGraphicsContext.restoreGraphicsState()
    return try #require(composite.representation(using: .png, properties: [:]))
  }

  private func snapshot(_ view: NSView) throws -> NSBitmapImageRep {
    let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: rep)
    return rep
  }

  /// Number of distinct colors on a coarse grid (a blank render has one or two).
  static func distinctColors(_ rep: NSBitmapImageRep) -> Int {
    var colors = Set<UInt32>()
    let stepX = max(1, rep.pixelsWide / 60)
    let stepY = max(1, rep.pixelsHigh / 120)
    for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
      for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        let r = UInt32(color.redComponent * 255), g = UInt32(color.greenComponent * 255)
        let b = UInt32(color.blueComponent * 255)
        colors.insert(r << 16 | g << 8 | b)
      }
    }
    return colors.count
  }
}
