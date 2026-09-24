import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// What vim shows: the command-line panel, search highlights, the block cursor and the status.
@MainActor
@Suite("Vim interface", .serialized)
struct VimInterfaceTests {
  @Test func thePromptRendersUnderTheEditorAndKeysKeepGoingToIt() throws {
    let editor = VimEditorHarness("alpha beta\ngamma")
    let scrollHeight = editor.controller.scrollView.frame.height
    editor.press(":")
    let panel = try #require(editor.host.panelView)
    #expect(editor.controller.containerView.panel === panel)
    #expect(panel.displayedText == ":")
    #expect(editor.controller.scrollView.frame.height < scrollHeight)
    editor.type("s/a/o")
    #expect(panel.displayedText == ":s/a/o")
    editor.press("<BS>")
    #expect(panel.displayedText == ":s/a/")
    editor.type("o/g")
    editor.press("<CR>")
    #expect(editor.text == "olpho beto\ngamma")
    // vim's report replaces the prompt, then closes by itself.
    #expect(editor.host.panelView?.kind == .message)
    #expect(editor.host.panelView?.displayedText.hasPrefix("Found 4 matches") == true)
    editor.scheduler.advance(by: 20)
    #expect(editor.host.panelView == nil)
    #expect(editor.controller.scrollView.frame.height == scrollHeight)
  }

  @Test func commandVPastesIntoThePrompt() throws {
    let editor = VimEditorHarness("find the needle here")
    let pasteboard = NSPasteboard.general
    let saved = pasteboard.string(forType: .string)
    defer {
      pasteboard.clearContents()
      if let saved { pasteboard.setString(saved, forType: .string) }
    }
    pasteboard.clearContents()
    pasteboard.setString("nee\ndle", forType: .string)
    editor.press("/")
    editor.textView.paste(nil)
    #expect(editor.session?.activePrompt?.value.string == "needle")
    #expect(editor.host.panelView?.displayedText.hasPrefix("/needle  (") == true)
    #expect(editor.text == "find the needle here")
    editor.press("<CR>")
    #expect(editor.cursor == 9)
  }

  @Test func escapeClosesThePromptAndMessagesShowInRed() throws {
    let editor = VimEditorHarness("text")
    editor.press(":")
    editor.press("<Esc>")
    #expect(editor.host.panelView == nil)
    #expect(editor.mode == .normal)
    editor.press(":")
    editor.type("nosuchcommand")
    editor.press("<CR>")
    let panel = try #require(editor.host.panelView)
    #expect(panel.kind == .message)
    #expect(panel.displayedText.contains("Not an editor command"))
    // Messages close on their own.
    editor.scheduler.advance(by: 20)
    #expect(editor.host.panelView == nil)
  }

  @Test func clickingTheTextLeavesThePrompt() throws {
    let editor = VimEditorHarness("some text")
    editor.press(":")
    editor.type("s/x")
    #expect(editor.session?.activePrompt != nil)
    let click = try #require(
      NSEvent.mouseEvent(
        with: .leftMouseDown, location: editor.textView.convert(NSPoint(x: 40, y: 30), to: nil),
        modifierFlags: [], timestamp: 0,
        windowNumber: editor.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
        pressure: 1))
    _ = editor.controller.textView(
      editor.textView, mouseDownAt: editor.textView.convert(click.locationInWindow, from: nil),
      modifiers: [])
    #expect(editor.session?.activePrompt == nil)
    #expect(editor.host.panelView == nil)
    #expect(editor.text == "some text")
  }

  @Test func recordingAMacroShowsAStatusLine() throws {
    let editor = VimEditorHarness("x")
    editor.press("q", "a")
    let panel = try #require(editor.host.panelView)
    #expect(panel.kind == .status)
    #expect(panel.displayedText == "recording @a")
    editor.press("q")
    #expect(editor.host.panelView == nil)
  }

  @Test func searchMatchesAreHighlightedInTheVisibleLinesUntilNohlsearch() {
    let editor = VimEditorHarness("cat dog cat\nbird cat")
    editor.press("/")
    editor.type("cat")
    editor.press("<CR>")
    editor.scheduler.advance(by: 0.1)
    let highlighted = editor.host.searchHighlighter.markedRanges
    #expect(
      highlighted == [
        NSRange(location: 0, length: 3), NSRange(location: 8, length: 3),
        NSRange(location: 17, length: 3),
      ])
    let color = editor.controller.layoutManager.temporaryAttribute(
      .backgroundColor, atCharacterIndex: 8, effectiveRange: nil)
    #expect(color as? NSColor == VimSearchHighlighter.matchColor)
    editor.press(":")
    editor.type("noh")
    editor.press("<CR>")
    #expect(editor.host.searchHighlighter.markedRanges.isEmpty)
    #expect(
      editor.controller.layoutManager.temporaryAttribute(
        .backgroundColor, atCharacterIndex: 8, effectiveRange: nil) == nil)
  }

  @Test func incrementalSearchHighlightsWhileTyping() {
    let editor = VimEditorHarness("one two one")
    editor.press("/")
    editor.type("on")
    editor.scheduler.advance(by: 0.1)
    #expect(!editor.host.searchHighlighter.markedRanges.isEmpty)
    editor.press("<Esc>")
  }

  @Test func theStatusIsReportedOnlyWhenItChanges() {
    let editor = VimEditorHarness("one two\nthree")
    let summary = {
      editor.delegate.statuses.compactMap { $0 }.map {
        "\($0.mode.rawValue):\($0.pending):\($0.recording ?? "")"
      }
    }
    editor.press("i")
    editor.type("hello")
    editor.press("<Esc>", "v", "<Esc>", "V", "<Esc>", "<C-v>", "<Esc>", "R", "<Esc>")
    editor.press("2", "d", "<Esc>", "\"", "a", "y", "y", "q", "q", "q")
    #expect(
      summary() == [
        "insert::", "normal::", "visual::", "normal::", "visual-line::", "normal::",
        "visual-block::", "normal::",
        "replace::", "normal::", "normal:2:", "normal:2d:", "normal::", "normal:\":", "normal:\"a:",
        "normal:\"ay:",
        "normal::", "normal:q:", "normal::q", "normal::",
      ])
    #expect(editor.controller.vimStatus == EditorVimStatus(mode: .normal))
    editor.controller.configure(EditorConfiguration(livePreview: false, vimMode: false))
    #expect(editor.delegate.statuses.last == .some(nil))
    #expect(editor.controller.vimStatus == nil)
  }

  @Test func theBlockCursorFollowsTheModeLikeTheWebApp() throws {
    let editor = VimEditorHarness("abc def")
    #expect(editor.host.drawsBlockCursor)
    #expect(!editor.textView.shouldDrawInsertionPoint)
    let block = try #require(editor.host.cursor.blocks.first)
    let glyph = editor.controller.layoutManager.boundingRect(
      forGlyphRange: NSRange(location: 0, length: 1), in: editor.controller.textContainer)
    #expect(abs(block.rect.minX - (glyph.minX + editor.textView.textContainerOrigin.x)) < 0.5)
    #expect(abs(block.rect.width - glyph.width) < 0.5)
    #expect(block.glyphs != nil)
    // Pending command: the lower half.
    editor.press("d")
    let half = try #require(editor.host.cursor.blocks.first)
    #expect(abs(half.rect.height - block.rect.height / 2) < 0.5)
    #expect(abs(half.rect.maxY - block.rect.maxY) < 0.5)
    editor.press("<Esc>")
    // Replace mode: a fifth; insert mode: the text view's own caret.
    editor.press("R")
    #expect(
      abs((editor.host.cursor.blocks.first?.rect.height ?? 0) - block.rect.height * 0.2) < 0.5)
    editor.press("<Esc>", "a")
    #expect(editor.host.cursor.blocks.isEmpty)
    #expect(!editor.host.drawsBlockCursor)
    editor.press("<Esc>")
    // A forward visual selection shows it on its last character.
    editor.press("0", "v", "l", "l")
    let visual = try #require(editor.host.cursor.blocks.first)
    let third = editor.controller.layoutManager.boundingRect(
      forGlyphRange: NSRange(location: 2, length: 1), in: editor.controller.textContainer)
    #expect(abs(visual.rect.minX - (third.minX + editor.textView.textContainerOrigin.x)) < 0.5)
  }

  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func theBlockCursorIsDrawnInTheAccentColor(name: String, appearance: NSAppearance.Name) throws {
    let editor = VimEditorHarness(
      "Plan the week\n- [ ] Book flights", size: NSSize(width: 520, height: 160))
    editor.window.appearance = NSAppearance(named: appearance)
    editor.window.reportsKey = true
    #expect(editor.textView.isKeyFocus)
    editor.press("w")
    let block = try #require(editor.host.cursor.blocks.first)
    // Above the glyph's strokes and clear of the block's edge.
    let inside = NSPoint(x: block.rect.midX, y: block.rect.minY + 2)
    let focused = try render(editor)
    let pixel = try #require(focused.color(at: inside, in: editor.textView))
    let background = try #require(
      focused.color(at: NSPoint(x: block.rect.maxX + 30, y: inside.y), in: editor.textView))
    #expect(distance(pixel, background) > 0.3, "the block is filled on \(name)")
    #expect(
      pixel.blueComponent > pixel.greenComponent, "the block has the accent's blue on \(name)")
    try FileManager.default.createDirectory(
      at: RenderSnapshotTests.outputDirectory, withIntermediateDirectories: true)
    if let png = focused.representation(using: .png, properties: [:]) {
      try png.write(
        to: RenderSnapshotTests.outputDirectory.appendingPathComponent(
          "vim-block-cursor-\(name).png"))
    }
    // An inactive window shows only the outline.
    editor.window.reportsKey = false
    let inactive = try render(editor)
    #expect(
      distance(try #require(inactive.color(at: inside, in: editor.textView)), background) < 0.1)
    // In insert mode the text view draws its own caret, and there's no block.
    editor.window.reportsKey = true
    editor.press("i")
    #expect(editor.host.cursor.blocks.isEmpty)
    let insert = try render(editor)
    #expect(distance(try #require(insert.color(at: inside, in: editor.textView)), background) < 0.1)
  }

  @Test func theBlockCursorIsAnOutlineWhenTheEditorIsntFocused() throws {
    let editor = VimEditorHarness("abc")
    editor.window.reportsKey = true
    let block = try #require(editor.host.cursor.blocks.first)
    let inside = NSPoint(x: block.rect.midX, y: block.rect.minY + 2)
    let focused = try #require(try render(editor).color(at: inside, in: editor.textView))
    #expect(focused.blueComponent - focused.greenComponent > 0.15)
    editor.window.makeFirstResponder(nil)
    let unfocused = try #require(try render(editor).color(at: inside, in: editor.textView))
    // No fill inside, just the text background.
    #expect(unfocused.blueComponent - unfocused.greenComponent < 0.15)
  }

  private func render(_ editor: VimEditorHarness) throws -> NSBitmapImageRep {
    editor.controller.layoutManager.ensureLayout(for: editor.controller.textContainer)
    let rep = try #require(
      editor.textView.bitmapImageRepForCachingDisplay(in: editor.textView.bounds))
    editor.textView.cacheDisplay(in: editor.textView.bounds, to: rep)
    return rep
  }

  private func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
    abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent)
      + abs(a.blueComponent - b.blueComponent)
  }
}

extension NSBitmapImageRep {
  /// The sRGB color at `point` in the coordinates of the (flipped) `view` this rep caches.
  @MainActor func color(at point: NSPoint, in view: NSView) -> NSColor? {
    let scale = CGFloat(pixelsWide) / view.bounds.width
    return colorAt(x: Int(point.x * scale), y: Int(point.y * scale))?.usingColorSpace(.sRGB)
  }
}
