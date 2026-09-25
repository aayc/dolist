import AppKit
import DailyDoListUI
import DailyDoListVim

/// Imperative handle on one editor instance: a TextKit 1 text system (`NSTextStorage` →
/// `NSLayoutManager` → `NSTextContainer` → `NSTextView` in an `NSScrollView`) with incremental
/// markdown styling, Obsidian-style live preview, task checkboxes, agent badges and list commands.
///
/// The text is plain markdown; all styling lives in text-storage attributes. Delegate callbacks
/// report user changes only (never `setText`).
@MainActor
public final class MarkdownEditorController {
  public weak var delegate: MarkdownEditorDelegate?
  /// The view to embed: the scroll view with vim's command-line panel under it.
  public let view: NSView
  public let scrollView: NSScrollView
  public let textView: NSTextView
  public private(set) var configuration: EditorConfiguration
  /// The app's vim engine (global state shared by every editor: registers, history, macros,
  /// mappings). With `configuration.vimMode` on, the editor attaches a `VimSession` to it.
  public var vim: Vim? {
    didSet { if vim !== oldValue { updateVimAttachment() } }
  }
  /// Where badges, sparkles and links report the pointer for their tooltips (the app's one
  /// tooltip; tests use their own).
  public var tooltipCenter: TooltipCenter = .shared

  /// Current badges, with their lines mapped through every edit since `setBadges`.
  public var badges: [EditorBadge] { badgeStore.currentBadges(lineIndex: highlighter.lineIndex) }

  public var text: String { textView.string }

  let storage: NSTextStorage
  let layoutManager: MarkdownLayoutManager
  let textContainer: NSTextContainer
  let markdownTextView: MarkdownTextView
  private(set) var theme: EditorTheme
  /// Test-only plain-text metrics (see `EditorTheme.Uniform`), also dropping paddings and wrapping.
  private(set) var uniformMetrics: EditorTheme.Uniform?
  /// Vim's view of this editor (a session is attached while vim mode is on).
  private(set) lazy var vimHost = TextViewVimHost(controller: self)
  let containerView: EditorContainerView
  let highlighter: MarkdownHighlighter
  let livePreview: LivePreviewState
  let glyphDelegate: GlyphLayoutDelegate
  let decorations: DecorationRenderer
  let badgeRenderer: BadgeRenderer
  /// Badges fading in and crossfading, the triaging pulse, checkmarks popping in.
  let motion: EditorMotion
  /// Drawing embeds: the host's drawings, floats, previews, selection and editing in place.
  let embeds = EmbedState()
  private(set) var badgeStore = BadgeStore()
  private let bridge = TextSystemBridge()
  private var lineNumberRuler: LineNumberRulerView?
  /// Undo history of the current note (swapped by `restore(_:)`).
  private(set) var noteUndoManager = UndoManager()
  var applyingProgrammaticChange = false
  /// Set while the editor replaces text itself: NSTextView's interim selection fix-ups aren't cursor
  /// moves (the final selection is reported).
  var replacingText = false
  /// Set while a note switch replaces the whole document (vim starts over afterwards).
  var replacingDocument = false
  var suppressSelectionAdjustment = false
  var lastReportedLine = 0
  var hoveredBadgeID: String?
  var drawnBadgeRects: [NSRect] = []
  var drawnSparkleRects: [NSRect] = []
  /// The badge, sparkle or link under the pointer, as the tooltip center knows it.
  var hoveredTooltip: (key: TooltipAnchor.Key, region: TooltipRegion)?
  var hoveredLinkRange: NSRange?
  private var badgeReserve: CGFloat = 0

  public convenience init(configuration: EditorConfiguration = EditorConfiguration()) {
    self.init(configuration: configuration, uniformMetrics: nil)
  }

  init(configuration: EditorConfiguration, uniformMetrics: EditorTheme.Uniform?) {
    self.configuration = configuration
    self.uniformMetrics = uniformMetrics
    let theme = EditorTheme(fontSize: CGFloat(configuration.fontSize), uniform: uniformMetrics)
    self.theme = theme
    storage = NSTextStorage()
    layoutManager = MarkdownLayoutManager()
    layoutManager.allowsNonContiguousLayout = true
    textContainer = NSTextContainer(
      size: NSSize(width: 480, height: CGFloat.greatestFiniteMagnitude))
    textContainer.widthTracksTextView = false
    textContainer.heightTracksTextView = false
    textContainer.lineFragmentPadding = 0
    layoutManager.addTextContainer(textContainer)
    storage.addLayoutManager(layoutManager)
    scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
    markdownTextView = MarkdownTextView(
      frame: NSRect(origin: .zero, size: scrollView.contentSize), textContainer: textContainer)
    textView = markdownTextView
    containerView = EditorContainerView(scrollView: scrollView)
    view = containerView
    livePreview = LivePreviewState(isEnabled: configuration.livePreview)
    highlighter = MarkdownHighlighter(storage: storage, theme: theme)
    glyphDelegate = GlyphLayoutDelegate(storage: storage, livePreview: livePreview, theme: theme)
    decorations = DecorationRenderer(theme: theme, livePreview: livePreview)
    badgeRenderer = BadgeRenderer(theme: theme)
    motion = EditorMotion(environment: .live(for: markdownTextView))

    layoutManager.delegate = glyphDelegate
    layoutManager.renderer = decorations
    decorations.motion = motion
    motion.onFrame = { [weak self] in self?.motionFrame() }
    storage.delegate = bridge
    bridge.controller = self
    markdownTextView.delegate = bridge
    markdownTextView.hooks = self
    livePreview.drawsEmbed = { [weak self] offset in self?.drawsEmbed(at: offset) ?? false }
    glyphDelegate.embedFragment = { [weak self] index, proposed in
      self?.embedFragment(at: index, proposed: proposed)
    }
    configureTextView()
    configureScrollView()
    applyConfiguration(configuration, previous: nil)
  }

  private func configureTextView() {
    let view = markdownTextView
    view.isRichText = false
    view.importsGraphics = false
    view.allowsImageEditing = false
    view.usesFontPanel = false
    view.usesRuler = false
    view.allowsUndo = true
    view.isSelectable = true
    view.usesFindBar = true
    view.isIncrementalSearchingEnabled = true
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    view.isAutomaticTextReplacementEnabled = false
    view.isAutomaticSpellingCorrectionEnabled = false
    view.isAutomaticLinkDetectionEnabled = false
    view.isAutomaticDataDetectionEnabled = false
    view.isAutomaticTextCompletionEnabled = false
    view.isGrammarCheckingEnabled = false
    view.smartInsertDeleteEnabled = false
    view.displaysLinkToolTips = false
    view.inlinePredictionType = .no
    if #available(macOS 15.0, *) { view.mathExpressionCompletionType = .no }
    view.drawsBackground = true
    view.backgroundColor = EditorColors.background
    view.insertionPointColor = EditorColors.accent
    view.selectedTextAttributes = [.backgroundColor: EditorColors.selection]
    view.isVerticallyResizable = true
    view.isHorizontallyResizable = false
    view.autoresizingMask = [.width]
    view.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
    view.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
  }

  private func configureScrollView() {
    scrollView.documentView = markdownTextView
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = EditorColors.background
    scrollView.autoresizingMask = [.width, .height]
    bridge.observe(clipView: scrollView.contentView)
  }

  // MARK: Text

  /// Replaces the document without notifying the delegate. Without `resetUndo` the change is applied
  /// as one minimal replacement (common prefix/suffix, aligned to whole lines), so the selection,
  /// scroll position and badge anchors survive; it is undoable like any edit. With `resetUndo` (note
  /// switch) the document is replaced, undo history and badges are cleared, and the caret moves to
  /// the start (reported as a cursor line change). Line endings are normalized to `\n`.
  public func setText(_ text: String, resetUndo: Bool = false) {
    let next = TextDiff.normalizeLineEndings(text)
    if resetUndo {
      replaceDocument(with: next)
      return
    }
    guard let change = TextDiff.minimalChange(from: storage.string, to: next) else { return }
    let selection = textView.selectedRanges.map(\.rangeValue)
    applyingProgrammaticChange = true
    defer { applyingProgrammaticChange = false }
    replacingText = true
    applyExternalChange(change)
    replacingText = false
    setSelection(
      selection.map { Self.map($0, through: change, in: storage.mutableString) }, adjust: false)
  }

  /// Applies changes someone else made (e.g. the remote side of a merge) without notifying the
  /// delegate. Ranges are non-overlapping, in the current text; changes at the same place apply in
  /// the order given. Each change is its own storage edit, so the selection, badge anchors and the
  /// user's undo history move with the text around it; together they are one undoable step
  /// (read-only editors clear undo instead).
  public func applyRemoteChanges(_ changes: [EditorTextChange]) {
    let length = storage.length
    let ordered = changes.enumerated()
      .filter { $0.element.range.location >= 0 && $0.element.range.end <= length }
      .sorted { ($0.element.range.location, $0.offset) < ($1.element.range.location, $1.offset) }
      .map(\.element)
    let sorted = Array(ordered.reversed())
    guard !sorted.isEmpty else { return }
    var selection = textView.selectedRanges.map(\.rangeValue)
    applyingProgrammaticChange = true
    defer { applyingProgrammaticChange = false }
    replacingText = true
    beginEditorOperation(userEvent: "input.remote")
    var applied = false
    if textView.isEditable, textView.allowsUndo {
      markdownTextView.breakUndoCoalescing()
      withUndoGroup {
        guard
          textView.shouldChangeText(
            inRanges: ordered.map { NSValue(range: $0.range) },
            replacementStrings: ordered.map(\.text))
        else { return }
        for change in sorted { storage.replaceCharacters(in: change.range, with: change.text) }
        textView.didChangeText()
        applied = true
      }
      markdownTextView.breakUndoCoalescing()
    }
    if !applied {
      for change in sorted { storage.replaceCharacters(in: change.range, with: change.text) }
      noteUndoManager.removeAllActions()
    }
    endEditorOperation()
    replacingText = false
    for change in sorted {
      let diff = TextDiff.Change(range: change.range, replacement: change.text)
      selection = selection.map { Self.map($0, through: diff) }
    }
    setSelection(selection.map { $0.clamped(to: storage.length) }, adjust: false)
  }

  /// Replaces the document like a note switch, with `text` exactly as given (tests: the vim vectors
  /// contain lone surrogates, which `String` can't hold).
  func replaceDocument(withExactly text: NSString) {
    replaceDocument(with: text as String)
  }

  private func replaceDocument(with text: String) {
    applyingProgrammaticChange = true
    defer { applyingProgrammaticChange = false }
    markdownTextView.breakUndoCoalescing()
    dropHoveredTooltip()
    badgeStore.removeAll()
    resetEmbeds()
    motion.documentReplaced()
    replacingDocument = true
    replacingText = true
    storage.replaceCharacters(in: NSRange(location: 0, length: storage.length), with: text)
    replacingText = false
    noteUndoManager.removeAllActions()
    lastReportedLine = -1  // a new document: always report its caret line
    setSelection([NSRange(location: 0, length: 0)], adjust: false)
    replacingDocument = false
    scroll(to: .zero)
    vimHost.documentDidReset()
  }

  /// Applies an external change as an undoable edit when possible; otherwise (read-only) replaces
  /// the text directly and clears the undo history, which could no longer be applied safely.
  private func applyExternalChange(_ change: TextDiff.Change) {
    beginEditorOperation(userEvent: "input.remote")
    defer { endEditorOperation() }
    if textView.isEditable, textView.allowsUndo {
      markdownTextView.breakUndoCoalescing()
      var applied = false
      withUndoGroup {
        guard textView.shouldChangeText(in: change.range, replacementString: change.replacement)
        else { return }
        storage.replaceCharacters(in: change.range, with: change.replacement)
        textView.didChangeText()
        applied = true
      }
      markdownTextView.breakUndoCoalescing()
      if applied { return }
    }
    storage.replaceCharacters(in: change.range, with: change.replacement)
    noteUndoManager.removeAllActions()
  }

  /// Maps a selection range through an external change. Whole lines inserted at a line start
  /// belong above it, so a caret at that line start stays on its line.
  static func map(_ range: NSRange, through change: TextDiff.Change, in text: NSString) -> NSRange {
    map(range, through: change).clamped(to: text.length)
  }

  /// `map(_:through:in:)` without clamping (the positions of a text other changes still edit).
  static func map(_ range: NSRange, through change: TextDiff.Change) -> NSRange {
    let from = change.range.location
    let to = change.range.end
    let inserted = (change.replacement as NSString).length
    let linesAbove = change.range.length == 0 && change.replacement.hasSuffix("\n")
    func map(_ offset: Int) -> Int {
      if offset == from, linesAbove { return offset + inserted }
      if offset <= from { return offset }
      if offset >= to { return offset + inserted - change.range.length }
      return from + inserted
    }
    let start = map(range.location)
    let end = range.length == 0 ? start : max(start, map(range.end))
    return NSRange(start, end)
  }

  // MARK: Badges

  /// Replaces the badges. Lines are 0-based and refer to the current text; badges on lines that
  /// don't exist are ignored. Once the document has been drawn, a badge with a new id fades in and
  /// one whose look changed (status, label, unread dot) crossfades; the same badges set again don't
  /// move.
  public func setBadges(_ badges: [EditorBadge]) {
    badgeStore.set(badges, lineIndex: highlighter.lineIndex, text: storage.mutableString)
    motion.setBadges(badgeStore.items.map(\.badge))
    let drawn = badgeStore.items.contains { $0.badge.isDrawn }
    let reserve = drawn ? badgeRenderer.widestRow(badgeStore.items) + badgeRenderer.gap : 0
    if reserve != badgeReserve {
      badgeReserve = reserve
      updateTextGeometry()
    }
    if let hovered = hoveredBadgeID,
      !badgeStore.items.contains(where: { $0.badge.id == hovered && !$0.badge.isFading })
    {
      hoveredBadgeID = nil
    }
    badgesDidChangeUnderTooltip()
    markdownTextView.setNeedsDisplay(markdownTextView.visibleRect)
  }

  // MARK: Configuration

  public func configure(_ configuration: EditorConfiguration) {
    guard configuration != self.configuration else { return }
    let previous = self.configuration
    self.configuration = configuration
    applyConfiguration(configuration, previous: previous)
  }

  private func applyConfiguration(
    _ configuration: EditorConfiguration, previous: EditorConfiguration?
  ) {
    if previous?.fontSize != configuration.fontSize
      || previous?.livePreview != configuration.livePreview
    {
      if previous?.fontSize != configuration.fontSize {
        theme = EditorTheme(fontSize: CGFloat(configuration.fontSize), uniform: uniformMetrics)
      }
      glyphDelegate.theme = theme
      decorations.theme = theme
      badgeRenderer.setTheme(theme)
      highlighter.restyleAll(theme: theme, livePreview: configuration.livePreview)
      markdownTextView.typingAttributes = theme.baseAttributes
      lineNumberRuler?.setFontSize(theme.fontSize)
      if !badgeStore.isEmpty {
        badgeReserve = badgeRenderer.widestRow(badgeStore.items) + badgeRenderer.gap
      }
    }
    if previous?.livePreview != configuration.livePreview {
      livePreview.isEnabled = configuration.livePreview
      if !configuration.livePreview { endEditingDrawing() }
      invalidateGlyphs(in: [NSRange(location: 0, length: storage.length)])
      refreshLivePreview()
    }
    if !configuration.isEditable { endEditingDrawing() }
    embedsNeedLayout()
    markdownTextView.isEditable = configuration.isEditable
    markdownTextView.isContinuousSpellCheckingEnabled = configuration.spellcheck
    if previous?.showLineNumbers != configuration.showLineNumbers {
      setLineNumbersVisible(configuration.showLineNumbers)
    }
    updateTextGeometry()
    if previous != nil,
      previous?.vimMode != configuration.vimMode || previous?.isEditable != configuration.isEditable
    {
      updateVimAttachment()
    }
  }

  /// Replaces the test-only plain-text metrics (restyles the document).
  func setUniformMetrics(_ metrics: EditorTheme.Uniform?) {
    guard metrics != uniformMetrics else { return }
    uniformMetrics = metrics
    theme = EditorTheme(fontSize: CGFloat(configuration.fontSize), uniform: metrics)
    glyphDelegate.theme = theme
    decorations.theme = theme
    badgeRenderer.setTheme(theme)
    highlighter.restyleAll(theme: theme, livePreview: configuration.livePreview)
    markdownTextView.typingAttributes = theme.baseAttributes
    updateTextGeometry()
    invalidateGlyphs(in: [NSRange(location: 0, length: storage.length)])
  }

  private func setLineNumbersVisible(_ visible: Bool) {
    if visible, lineNumberRuler == nil {
      let ruler = LineNumberRulerView(
        textView: markdownTextView, fontSize: theme.fontSize,
        lineIndex: { [weak self] in self?.highlighter.lineIndex ?? LineIndex() },
        caretLine: { [weak self] in self?.caretLine ?? 0 })
      scrollView.verticalRulerView = ruler
      lineNumberRuler = ruler
      ruler.updateThickness()
    }
    scrollView.hasVerticalRuler = visible
    scrollView.rulersVisible = visible
  }

  /// Positions the text column: readable width centered, badge room on the right.
  func updateTextGeometry() {
    let width = markdownTextView.frame.width
    guard width > 0 else { return }
    if uniformMetrics != nil {
      if markdownTextView.textContainerInset != .zero {
        markdownTextView.textContainerInset = .zero
      }
      textContainer.size = NSSize(
        width: TextGeometry.unwrappedWidth, height: CGFloat.greatestFiniteMagnitude)
      return
    }
    let geometry = TextGeometry.compute(
      viewWidth: width, readable: configuration.readableLineLength,
      horizontalPadding: (theme.fontSize * 1.75).rounded(),
      topPadding: (theme.fontSize * 1.25).rounded(),
      badgeReserve: badgeReserve)
    if markdownTextView.textContainerInset != geometry.inset {
      markdownTextView.textContainerInset = geometry.inset
    }
    if abs(textContainer.size.width - geometry.columnWidth) > 0.5 {
      textContainer.size = NSSize(
        width: geometry.columnWidth, height: CGFloat.greatestFiniteMagnitude)
    }
  }

  func lineNumberRulerNeedsDisplay() {
    lineNumberRuler?.needsDisplay = true
  }

  func clipViewDidChange() {
    let height = scrollView.contentView.bounds.height
    if abs(markdownTextView.minSize.height - height) > 0.5 {
      markdownTextView.minSize = NSSize(width: 0, height: height)
    }
    lineNumberRuler?.needsDisplay = true
    vimHost.viewportDidChange()
  }

  // MARK: Focus, scrolling, snapshots

  public func focus() {
    if let window = textView.window {
      window.makeFirstResponder(textView)
    } else {
      markdownTextView.focusWhenInWindow = true
    }
  }

  /// Puts the caret at the end of the document and scrolls it into view.
  public func moveCaretToEnd() {
    let end = NSRange(location: storage.length, length: 0)
    setSelection([end], adjust: false)
    markdownTextView.scrollRangeToVisible(end)
  }

  /// Moves the caret to the start of a 0-based line and centers it.
  public func scrollToLine(_ line: Int) {
    let index = highlighter.lineIndex
    let target = index.start(ofLine: max(0, min(line, index.count - 1)))
    setSelection([NSRange(location: target, length: 0)], adjust: false)
    // Lays out (and sizes the view) up to the line; line geometry before that is only estimated.
    markdownTextView.scrollRangeToVisible(NSRange(location: target, length: 0))
    let lineRect = lineRectInTextView(at: target)
    let visibleHeight = scrollView.contentView.bounds.height
    let maxY = max(0, markdownTextView.frame.height - visibleHeight)
    scroll(to: NSPoint(x: 0, y: max(0, min(lineRect.midY - visibleHeight / 2, maxY))))
  }

  public func snapshot() -> EditorSnapshot {
    EditorSnapshot(
      text: text, selectedRange: textView.selectedRange(),
      scrollOffset: scrollView.contentView.bounds.origin,
      undoManager: noteUndoManager)
  }

  /// Restores a note: its text, selection, scroll position and undo history, and reports its caret
  /// line. Badges are cleared; send the note's badges afterwards.
  public func restore(_ snapshot: EditorSnapshot) {
    markdownTextView.breakUndoCoalescing()
    noteUndoManager = snapshot.undoManager ?? UndoManager()
    dropHoveredTooltip()
    badgeStore.removeAll()
    resetEmbeds()
    motion.documentReplaced()
    replacingDocument = true
    let next = TextDiff.normalizeLineEndings(snapshot.text)
    if next != storage.string {
      applyingProgrammaticChange = true
      replacingText = true
      storage.replaceCharacters(in: NSRange(location: 0, length: storage.length), with: next)
      replacingText = false
      applyingProgrammaticChange = false
    }
    lastReportedLine = -1  // a new document: always report its caret line
    setSelection([snapshot.selectedRange.clamped(to: storage.length)], adjust: false)
    replacingDocument = false
    vimHost.documentDidReset()
    let origin = markdownTextView.textContainerOrigin
    let visible = NSRect(origin: snapshot.scrollOffset, size: scrollView.contentView.bounds.size)
    layoutManager.ensureLayout(
      forBoundingRect: visible.offsetBy(dx: -origin.x, dy: -origin.y), in: textContainer)
    scroll(to: snapshot.scrollOffset)
  }

  func scroll(to point: NSPoint) {
    scrollView.contentView.scroll(to: point)
    scrollView.reflectScrolledClipView(scrollView.contentView)
  }

  /// The line fragment holding `offset`, in text-view coordinates.
  func lineRectInTextView(at offset: Int) -> NSRect {
    let origin = markdownTextView.textContainerOrigin
    var rect: NSRect
    if offset >= storage.length, !layoutManager.extraLineFragmentRect.isEmpty || storage.length == 0
    {
      layoutManager.ensureLayout(for: textContainer)
      rect = layoutManager.extraLineFragmentRect
    } else {
      let glyph = layoutManager.glyphIndexForCharacter(at: min(offset, max(0, storage.length - 1)))
      rect = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    }
    rect.origin.x += origin.x
    rect.origin.y += origin.y
    return rect
  }

  // MARK: Edit pipeline

  /// Every character edit, from `didProcessEditing`: update the line index and styles, remap badges
  /// and keep the revealed lines covering the edit.
  func storageDidEditCharacters(in editedRange: NSRange, changeInLength delta: Int) {
    let oldLength = editedRange.length - delta
    let linesBefore = highlighter.lineIndex.count
    highlighter.textDidChange(in: editedRange, changeInLength: delta)
    let restyled = highlighter.lastRestyledRange
    if restyled.length > 0 {
      // The storage fixed attributes (font fallback for emoji etc.) for the edited characters only,
      // before the restyle rewrote the fonts of whole lines.
      storage.fixAttributes(in: restyled)
      layoutManager.invalidateAfterEdit.append(restyled)
    }
    badgeStore.applyEdit(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length,
      lineIndex: highlighter.lineIndex, text: storage.mutableString)
    motion.textDidEdit(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length)
    livePreview.textDidChange(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length)
    embedsDidEdit(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length)
    if let ruler = lineNumberRuler {
      if highlighter.lineIndex.count != linesBefore { ruler.updateThickness() }
      ruler.needsDisplay = true
    }
    if !replacingDocument {
      vimHost.storageDidEdit(
        location: editedRange.location, oldLength: oldLength, newLength: editedRange.length)
    }
  }

  /// Runs `body` inside an undo group when the note's undo manager has none open and doesn't group
  /// by event (registering undo would otherwise raise).
  func withUndoGroup(_ body: () -> Void) {
    let manager = noteUndoManager
    // In vim mode the edits' undo steps are vim's (see `VimUndoRecorder`), which groups them itself.
    let opensGroup = !vimHost.isAttached && !manager.groupsByEvent && manager.groupingLevel == 0
    if opensGroup { manager.beginUndoGrouping() }
    body()
    if opensGroup { manager.endUndoGrouping() }
  }

  func textViewDidChangeText() {
    vimHost.textDidChange()
    guard !applyingProgrammaticChange else { return }
    delegate?.editorTextDidChange(self, text: textView.string)
  }

  /// 0-based line of the caret (start of the primary selection).
  var caretLine: Int {
    highlighter.lineIndex.line(containing: textView.selectedRange().location)
  }

  /// Sets the selection; `adjust: false` keeps it exactly as given (no snapping out of hidden syntax).
  func setSelection(_ ranges: [NSRange], adjust: Bool = true) {
    let length = storage.length
    let values = (ranges.isEmpty ? [NSRange(location: length, length: 0)] : ranges).map {
      NSValue(range: $0.clamped(to: length))
    }
    suppressSelectionAdjustment = !adjust
    textView.setSelectedRanges(values, affinity: .downstream, stillSelecting: false)
    suppressSelectionAdjustment = false
  }

  /// Regenerates the glyphs of `ranges` (live preview visibility changed) and redraws the visible
  /// text (revealing syntax can re-wrap lines and move everything below).
  func invalidateGlyphs(in ranges: [NSRange]) {
    var invalidated = false
    for range in ranges {
      let clamped = range.clamped(to: storage.length)
      guard clamped.length > 0 else { continue }
      layoutManager.invalidateGlyphs(
        forCharacterRange: clamped, changeInLength: 0, actualCharacterRange: nil)
      layoutManager.invalidateLayout(forCharacterRange: clamped, actualCharacterRange: nil)
      invalidated = true
    }
    if invalidated { markdownTextView.setNeedsDisplay(markdownTextView.visibleRect) }
  }

  /// Recomputes what live preview reveals for the current selection and focus.
  func refreshLivePreview() {
    let ranges = livePreview.update(
      selection: textView.selectedRanges.map(\.rangeValue),
      focused: markdownTextView.isEditorFocused,
      lineIndex: highlighter.lineIndex, storage: storage)
    if !ranges.isEmpty {
      invalidateGlyphs(in: ranges)
      embedsNeedLayout()
    }
  }
}
