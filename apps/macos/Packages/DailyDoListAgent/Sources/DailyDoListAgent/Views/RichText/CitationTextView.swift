import AppKit
import DailyDoListModels
import SwiftUI

/// What a link's hover card shows.
enum LinkPreviewContent: Hashable {
  case page(LinkPreview)
  /// A `[[wikilink]]` target, previewed by the host.
  case note(String)
}

/// A read-only, selectable text view for one block of agent text. Unlike SwiftUI's `Text`, it
/// knows which link is under the pointer: hovering one shows its preview card after a moment, and
/// clicks go through the link policy (wikilinks open the note). Citation chips are drawn by its
/// layout manager.
@MainActor
final class CitationTextView: NSTextView, NSTextViewDelegate {
  var sources: [CitedSource] = []
  var noteLinks: AgentNoteLinks = .none
  /// How long the pointer rests on a link before its card shows.
  static let hoverDelay: Duration = .milliseconds(350)

  private(set) var hoveredLink: (range: NSRange, url: URL)?
  private(set) var popover: NSPopover?
  private var hoverTask: Task<Void, Never>?
  private var hoverArea: NSTrackingArea?
  private var source: (text: AttributedString, style: RichTextStyle)?
  /// A second text system that measures the content at any width without resizing the view.
  private let measuring = (
    storage: NSTextStorage(), layout: NSLayoutManager(), container: NSTextContainer()
  )
  private var measured: (width: CGFloat, height: CGFloat)?

  init() {
    let storage = NSTextStorage()
    let layoutManager = CitationLayoutManager()
    let container = NSTextContainer(
      size: NSSize(width: 300, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)
    storage.addLayoutManager(layoutManager)
    super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 20), textContainer: container)
    measuring.container.lineFragmentPadding = 0
    measuring.layout.addTextContainer(measuring.container)
    measuring.storage.addLayoutManager(measuring.layout)
    isEditable = false
    isSelectable = true
    isRichText = true
    drawsBackground = false
    textContainerInset = .zero
    isVerticallyResizable = false
    isHorizontallyResizable = false
    displaysLinkToolTips = false
    linkTextAttributes = [.cursor: NSCursor.pointingHand]
    delegate = self
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Sets the text (a no-op when it didn't change, so a selection survives re-renders).
  func setContent(_ text: AttributedString, style: RichTextStyle) {
    if let source, source.text == text, source.style == style { return }
    source = (text, style)
    let attributed = AgentRichText.attributed(text, style: style)
    textStorage?.setAttributedString(attributed)
    measuring.storage.setAttributedString(attributed)
    measured = nil
    closePreview()
  }

  /// The height the text needs at `width`.
  func height(forWidth width: CGFloat) -> CGFloat {
    if let measured, measured.width == width { return measured.height }
    measuring.container.size = NSSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude)
    measuring.layout.ensureLayout(for: measuring.container)
    let height = ceil(measuring.layout.usedRect(for: measuring.container).height)
    measured = (width, height)
    return height
  }

  /// The width of the text on one line.
  var naturalWidth: CGFloat {
    measuring.container.size = NSSize(width: 100_000, height: CGFloat.greatestFiniteMagnitude)
    measuring.layout.ensureLayout(for: measuring.container)
    return ceil(measuring.layout.usedRect(for: measuring.container).width)
  }

  // MARK: Links

  /// The link whose glyphs are under `point` (view coordinates).
  func link(at point: NSPoint) -> (range: NSRange, url: URL)? {
    guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else {
      return nil
    }
    let local = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
    let glyph = layoutManager.glyphIndex(
      for: local, in: textContainer, fractionOfDistanceThroughGlyph: nil)
    guard glyph < layoutManager.numberOfGlyphs else { return nil }
    let bounds = layoutManager.boundingRect(
      forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
    guard bounds.insetBy(dx: -AgentRichText.citationPadding, dy: -1).contains(local) else {
      return nil
    }
    var range = NSRange()
    let value = storage.attribute(
      .link, at: layoutManager.characterIndexForGlyph(at: glyph), effectiveRange: &range)
    guard let url = (value as? URL) ?? (value as? String).flatMap(URL.init(string:)) else {
      return nil
    }
    return (range, url)
  }

  /// What the card of `link` shows: the note, or the page as the thread's sources know it.
  func previewContent(for link: (range: NSRange, url: URL)) -> LinkPreviewContent {
    if let target = WikiLinkURL.target(of: link.url) { return .note(target) }
    let label = textStorage?.attributedSubstring(from: link.range).string
    return .page(LinkPreview.make(url: link.url.absoluteString, label: label, sources: sources))
  }

  /// The first line-fragment piece of `range` (view coordinates), where the card points.
  func anchorRect(of range: NSRange) -> NSRect {
    guard let layoutManager, let textContainer else { return .zero }
    let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    var first = NSRect.zero
    layoutManager.enumerateEnclosingRects(
      forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
      in: textContainer
    ) { rect, stop in
      first = rect
      stop.pointee = true
    }
    return first.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
  }

  func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
    closePreview()
    guard let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) else {
      return true
    }
    if let target = WikiLinkURL.target(of: url) {
      noteLinks.open(target)
    } else {
      _ = LinkPolicy.handle(url) { NSWorkspace.shared.open($0) }
    }
    return true
  }

  // MARK: Hover cards

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let hoverArea, trackingAreas.contains(hoverArea) { return }
    let area = NSTrackingArea(
      rect: .zero,
      options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
      owner: self,
      userInfo: nil)
    addTrackingArea(area)
    hoverArea = area
  }

  override func mouseMoved(with event: NSEvent) {
    super.mouseMoved(with: event)
    hover(at: convert(event.locationInWindow, from: nil))
  }

  override func mouseExited(with event: NSEvent) {
    super.mouseExited(with: event)
    hover(at: nil)
  }

  override func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    if newWindow == nil { hover(at: nil) }
  }

  /// The pointer is at `point` (nil: it left): a new link schedules its card, leaving one closes it.
  func hover(at point: NSPoint?) {
    let link = point.flatMap(link(at:))
    guard link?.range != hoveredLink?.range || link?.url != hoveredLink?.url else { return }
    hoveredLink = link
    hoverTask?.cancel()
    closePreview()
    guard let link else { return }
    hoverTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.hoverDelay)
      guard !Task.isCancelled else { return }
      self?.showPreview(for: link)
    }
  }

  private func showPreview(for link: (range: NSRange, url: URL)) {
    guard window != nil else { return }
    let controller = NSHostingController(
      rootView: LinkPreviewCard(content: previewContent(for: link), noteLinks: noteLinks))
    controller.sizingOptions = .preferredContentSize
    let popover = NSPopover()
    popover.behavior = .applicationDefined
    popover.animates = false
    popover.contentViewController = controller
    popover.show(relativeTo: anchorRect(of: link.range), of: self, preferredEdge: .maxY)
    self.popover = popover
  }

  func closePreview() {
    popover?.close()
    popover = nil
  }
}

/// Draws citation chips behind their digits (the kerning around them leaves room).
final class CitationLayoutManager: NSLayoutManager {
  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let storage = textStorage else { return }
    let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    storage.enumerateAttribute(.agentCitation, in: chars) { value, run, _ in
      guard value != nil else { return }
      let glyphs = glyphRange(forCharacterRange: run, actualCharacterRange: nil)
      guard glyphs.length > 0 else { return }
      let fragment = lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
      let first = location(forGlyphAt: glyphs.location)
      let font =
        storage.attribute(.font, at: run.location, effectiveRange: nil) as? NSFont
        ?? .systemFont(ofSize: 9.5)
      let digits = (storage.attributedSubstring(from: run).string as NSString).size(
        withAttributes: [.font: font]).width
      // The glyph's location already includes its baseline offset.
      let baseline = fragment.minY + first.y
      let padding = AgentRichText.citationPadding - 0.5
      let chip = NSRect(
        x: fragment.minX + first.x - padding, y: baseline - font.capHeight - 2,
        width: digits + 2 * padding,
        height: font.capHeight + 3.5
      ).offsetBy(dx: origin.x, dy: origin.y)
      AgentPalette.accentSoft.setFill()
      NSBezierPath(roundedRect: chip, xRadius: chip.height / 2, yRadius: chip.height / 2).fill()
    }
  }
}
