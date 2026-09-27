#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListEditorCore
  import UIKit

  /// Owns mutable text outside SwiftUI. Local edits report UTF-16 deltas; the repository reads a
  /// snapshot on its debounce, never by rebuilding a SwiftUI String binding on every keystroke.
  @MainActor
  public final class MobileMarkdownController: NSObject {
    public let input = MarkdownInputView()
    public var onBadgeTap: ((EditorBadge) -> Void)?
    public var onAgentMarkerTap: ((String?) -> Void)?
    public var onUserEdit: (() -> Void)?
    lazy var annotations = MobileBadgeCoordinator(owner: self)
    public var badges: [EditorBadge] {
      annotations.store.currentBadges(lineIndex: parser.lineIndex)
    }
    public func setBadges(_ badges: [EditorBadge]) { annotations.set(badges) }
    public var selectedLine: Int { parser.lineIndex.line(containing: selection.location) }
    public var onTextChange: ((EditorTextChange) -> Void)?
    public var onSelectionChange: ((NSRange) -> Void)?
    public var onScrollChange: ((Double) -> Void)?
    var restoredScrollY: Double?
    public private(set) var configuration: EditorConfiguration
    let parser = MarkdownParseCache()
    lazy var embeds = MobileEmbedCoordinator(owner: self)
    lazy var lineNumberGutter = MobileLineNumberGutter(owner: self)
    let preview = LivePreviewState(isEnabled: true)
    private var style: MobileMarkdownStyle
    private var glyphs: MobileGlyphDelegate!
    private var suppressChanges = false
    private var applyingCommand = false
    private var pendingStyle: NSRange?
    private var styleScheduled = false
    private var deferredExternalText: (base: String, remote: String)?
    public var onCompositionEnd: (() -> Void)?
    public var onMergeConflict: ((String) -> Void)?

    public init(configuration: EditorConfiguration = EditorConfiguration()) {
      self.configuration = configuration
      style = MobileMarkdownStyle(fontSize: configuration.fontSize)
      super.init()
      glyphs = MobileGlyphDelegate(storage: input.textStorage, livePreview: preview, theme: style)
      glyphs.embedFragment = { [weak self] offset, rect in
        self?.embeds.fragment(at: offset, proposed: rect)
      }
      preview.drawsEmbed = { [weak self] offset in self?.embeds.draws(at: offset) == true }
      input.layoutManager.delegate = glyphs
      input.textStorage.delegate = self
      input.delegate = self
      input.commandController = self
      (input.layoutManager as? MobileLayoutManager)?.preview = preview
      let tap = UITapGestureRecognizer(target: self, action: #selector(tapMarker(_:)))
      tap.cancelsTouchesInView = false
      tap.delegate = self
      input.addGestureRecognizer(tap)
      updateConfiguration(configuration)
      load("")
    }

    public var text: String { input.textStorage.string }
    public func restoreScrollPosition(_ y: Double) {
      restoredScrollY = y.isFinite ? max(0, y) : 0
      input.setNeedsLayout()
    }
    public var selection: NSRange {
      get { input.selectedRange }
      set { input.selectedRange = newValue.clamped(to: input.textStorage.length) }
    }

    /// A document switch, after the previous document has been checkpointed by its owner.
    public func load(_ text: String) {
      suppressChanges = true
      embeds.reset()
      annotations.reset()
      deferredExternalText = nil
      pendingStyle = nil
      input.textStorage.delegate = nil
      input.textStorage.setAttributedString(
        NSAttributedString(string: TextDiff.normalizeLineEndings(text)))
      input.textStorage.beginEditing()
      parser.rebuild(input.textStorage.mutableString, consume: applyStyle)
      input.textStorage.endEditing()
      input.textStorage.delegate = self
      selection = NSRange(location: 0, length: 0)
      input.undoManager?.removeAllActions()
      suppressChanges = false
      updatePreview()
    }

    public func updateConfiguration(_ configuration: EditorConfiguration) {
      self.configuration = configuration
      if !configuration.isEditable || !configuration.livePreview { embeds.endEditing() }
      updateMobileGeometry()
      style = MobileMarkdownStyle(fontSize: configuration.fontSize)
      glyphs.theme = style
      preview.isEnabled = configuration.livePreview
      input.isEditable = configuration.isEditable
      input.spellCheckingType = configuration.spellcheck ? .yes : .no
      input.autocorrectionType = configuration.spellcheck ? .default : .no
      input.smartQuotesType = .no
      input.smartDashesType = .no
      input.typingAttributes = style.attributes(kind: .paragraph, style: [], marker: nil)
      input.textStorage.beginEditing()
      parser.rebuild(input.textStorage.mutableString, consume: applyStyle)
      input.textStorage.endEditing()
      updatePreview()
    }

    /// Apply a remote merge as an edit, never during marked-text composition. It must not be reported
    /// as local typing. The repository already owns both the remote snapshot and the local draft.
    public func applyExternalText(_ value: String) {
      guard input.markedTextRange == nil else {
        deferredExternalText = (deferredExternalText?.base ?? text, value)
        return
      }
      guard let change = TextDiff.minimalChange(from: text, to: value) else { return }
      let old = selection
      let edit = TextEdit(
        replacements: [.init(range: change.range, text: change.replacement)], selection: [])
      suppressChanges = true
      if input.isEditable {
        perform(edit)
      } else {
        input.textStorage.replaceCharacters(in: change.range, with: change.replacement)
        input.undoManager?.removeAllActions()
      }
      let start = edit.map(old.location, forward: true)
      let end = edit.map(old.end, forward: true)
      selection = NSRange(start, end)
      suppressChanges = false
      flushStyling()
      updatePreview()
    }

    public enum Command: Sendable {
      case bold, italic, code, strike, highlight, link, checklist, indent, outdent, undo, redo
    }

    @discardableResult
    public func run(_ command: Command) -> Bool {
      guard configuration.isEditable, input.markedTextRange == nil else { return false }
      let text = input.textStorage.mutableString
      let selections = [selection]
      let edit: TextEdit?
      switch command {
      case .bold: edit = FormattingCommands.toggle(.bold, in: text, selection: selections)
      case .italic: edit = FormattingCommands.toggle(.italic, in: text, selection: selections)
      case .code: edit = FormattingCommands.toggle(.inlineCode, in: text, selection: selections)
      case .strike:
        edit = FormattingCommands.toggle(.strikethrough, in: text, selection: selections)
      case .highlight: edit = FormattingCommands.toggle(.highlight, in: text, selection: selections)
      case .link: edit = FormattingCommands.insertLink(in: text, selection: selections)
      case .checklist: edit = TaskCommands.toggleChecklist(in: text, selection: selections)
      case .indent: edit = ListCommands.indent(in: text, selection: selections)
      case .outdent: edit = ListCommands.outdent(in: text, selection: selections)
      case .undo:
        input.undoManager?.undo()
        return true
      case .redo:
        input.undoManager?.redo()
        return true
      }
      guard let edit else { return false }
      perform(edit)
      return true
    }

    func handleNewline() -> Bool {
      guard !applyingCommand, input.markedTextRange == nil, configuration.isEditable,
        let edit = ListCommands.newline(
          in: input.textStorage.mutableString, selection: [selection],
          isLiteralLine: { [self] offset in
            parser.isLiteralLine(parser.lineIndex.line(containing: offset))
          })
      else { return false }
      perform(edit)
      return true
    }

    @discardableResult
    public func toggleTask(atLine line: Int) -> Bool {
      guard configuration.isEditable, input.markedTextRange == nil,
        line >= 0, line < parser.lineIndex.count, !parser.isLiteralLine(line),
        let replacement = TaskCommands.toggleTask(
          in: input.textStorage.mutableString,
          lineContaining: parser.lineIndex.start(ofLine: line))
      else { return false }
      perform(TextEdit(replacements: [replacement], selection: [selection]))
      return true
    }

    @objc private func tapMarker(_ recognizer: UITapGestureRecognizer) {
      let point = recognizer.location(in: input)
      if let line = taskLine(at: point) {
        _ = toggleTask(atLine: line)
      } else if let marker = agentMarker(at: point) {
        onAgentMarkerTap?(marker.threadId)
      } else if let offset = linkAtPoint(point) {
        _ = openLink(atUTF16: offset)
      }
    }

    private func agentMarker(at point: CGPoint) -> AgentMarkerToken? {
      guard configuration.livePreview, let layout = input.layoutManager as? MobileLayoutManager
      else { return nil }
      let location = CGPoint(
        x: point.x - input.textContainerInset.left, y: point.y - input.textContainerInset.top)
      let character = layout.characterIndex(
        for: location, in: input.textContainer,
        fractionOfDistanceBetweenInsertionPoints: nil)
      guard character < input.textStorage.length else { return nil }
      var range = NSRange()
      guard
        let raw = input.textStorage.attribute(.ddlMarker, at: character, effectiveRange: &range)
          as? Int,
        MarkerKind(rawValue: raw) == .agent, preview.isHidden(.agent, range: range),
        let rect = layout.markerRect(at: range.location),
        rect.insetBy(dx: -8, dy: -6).contains(location)
      else { return nil }
      let line = parser.lineIndex.contentRange(
        ofLine: parser.lineIndex.line(containing: character), textLength: input.textStorage.length)
      return AgentMarker.scan(Array(input.textStorage.mutableString.substring(with: line).utf16))
    }

    private func taskLine(at point: CGPoint) -> Int? {
      guard configuration.livePreview, let layout = input.layoutManager as? MobileLayoutManager
      else { return nil }
      let location = CGPoint(
        x: point.x - input.textContainerInset.left, y: point.y - input.textContainerInset.top)
      let character = layout.characterIndex(
        for: location, in: input.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
      guard character < input.textStorage.length else { return nil }
      var range = NSRange()
      guard
        let raw = input.textStorage.attribute(.ddlMarker, at: character, effectiveRange: &range)
          as? Int,
        MarkerKind(rawValue: raw) == .task, preview.isHidden(.task, range: range),
        let rect = layout.markerRect(at: range.location),
        rect.insetBy(dx: -8, dy: -4).contains(location)
      else { return nil }
      return parser.lineIndex.line(containing: range.location)
    }

    func perform(_ edit: TextEdit) {
      applyingCommand = true
      input.undoManager?.beginUndoGrouping()
      for replacement in edit.replacements.reversed() {
        input.selectedRange = replacement.range
        input.insertText(replacement.text)
      }
      input.undoManager?.endUndoGrouping()
      if let selection = edit.selection.first { self.selection = selection }
      applyingCommand = false
      updatePreview()
    }

    private func applyStyle(
      _ tokens: LineTokens, _ units: [UInt16], _ range: NSRange, _ hasNewline: Bool
    ) {
      var tokens = tokens
      if tokens.attachment != nil {
        tokens.markers = [SyntaxMarker(range: NSRange(0, range.length), kind: .embed)]
      }
      var position = range.location
      for segment in StyleSegments.build(tokens, length: range.length) {
        input.textStorage.setAttributes(
          style.attributes(kind: tokens.kind, style: segment.style, marker: segment.marker),
          range: NSRange(location: position, length: segment.length))
        position += segment.length
      }
      if hasNewline {
        input.textStorage.setAttributes(
          style.attributes(kind: tokens.kind, style: [], marker: nil),
          range: NSRange(location: range.end, length: 1))
      }
    }

    private func flushStyling() {
      guard let range = pendingStyle else { return }
      pendingStyle = nil
      // UIKit can retain a stale fallback font when attributes change inside didProcessEditing
      // (colored emoji disappears). Style in a separate attributes-only transaction after input.
      input.textStorage.beginEditing()
      parser.restyle(covering: range, text: input.textStorage.mutableString, consume: applyStyle)
      input.textStorage.endEditing()
      updatePreview()
    }

    func updatePreview() {
      let invalid = preview.update(
        selection: [selection], focused: input.isFirstResponder,
        lineIndex: parser.lineIndex, storage: input.textStorage)
      for range in invalid {
        input.layoutManager.invalidateGlyphs(
          forCharacterRange: range, changeInLength: 0, actualCharacterRange: nil)
      }
      input.setNeedsDisplay()
      lineNumberGutter.setNeedsDisplay()
      embeds.schedule()
      annotations.schedule()
    }
  }

  extension MobileMarkdownController: UIGestureRecognizerDelegate {
    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      // A recognizer over the whole text view prevents UIKit's caret/selection gestures even with
      // cancelsTouchesInView=false. Only participate when the user actually touched a checkbox.
      let point = gestureRecognizer.location(in: input)
      return taskLine(at: point) != nil || agentMarker(at: point) != nil
        || linkAtPoint(point) != nil
    }
  }

  extension MobileMarkdownController: @preconcurrency NSTextStorageDelegate {
    public func textStorage(
      _ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorage.EditActions,
      range editedRange: NSRange, changeInLength delta: Int
    ) {
      guard editedMask.contains(.editedCharacters) else { return }
      parser.textDidChange(
        in: editedRange, changeInLength: delta, text: textStorage.mutableString,
        consume: { _, _, _, _ in }
      )
      annotations.edited(
        location: editedRange.location, oldLength: editedRange.length - delta,
        newLength: editedRange.length)
      let change = TextEdit(
        replacements: [
          .init(
            range: NSRange(location: editedRange.location, length: editedRange.length - delta),
            text: textStorage.mutableString.substring(with: editedRange))
        ], selection: [])
      let remapped = pendingStyle.map {
        NSRange(change.map($0.location, forward: false), change.map($0.end, forward: true))
      }
      pendingStyle =
        remapped.map { NSUnionRange($0, parser.lastRestyledRange) } ?? parser.lastRestyledRange
      if !styleScheduled {
        styleScheduled = true
        Task { @MainActor [weak self] in
          self?.styleScheduled = false
          self?.flushStyling()
        }
      }
      if embeds.editedLine != nil { embeds.endEditing() }
      preview.textDidChange(
        location: editedRange.location, oldLength: editedRange.length - delta,
        newLength: editedRange.length)
      guard !suppressChanges else { return }
      onUserEdit?()
      onTextChange?(
        EditorTextChange(
          range: NSRange(location: editedRange.location, length: editedRange.length - delta),
          text: textStorage.mutableString.substring(with: editedRange)))
    }
  }

  extension MobileMarkdownController: UITextViewDelegate {
    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
      onScrollChange?(scrollView.contentOffset.y)
      updateMobileGeometry()
      embeds.schedule()
      annotations.schedule()
    }
    public func textViewDidChangeSelection(_ textView: UITextView) {
      updatePreview()
      onSelectionChange?(selection)
    }
    public func textViewDidBeginEditing(_ textView: UITextView) { updatePreview() }
    public func textViewDidEndEditing(_ textView: UITextView) { updatePreview() }
    public func textViewDidChange(_ textView: UITextView) {
      flushStyling()
      compositionDidEnd()
      updatePreview()
    }

    func compositionDidEnd() {
      if input.markedTextRange == nil, let deferred = deferredExternalText {
        deferredExternalText = nil
        let merged = TextMerge.merge(base: deferred.base, local: text, remote: deferred.remote)
        if merged.conflict { onMergeConflict?(deferred.remote) }
        applyExternalText(merged.text)
      }
      if input.markedTextRange == nil { onCompositionEnd?() }
      updatePreview()
    }
  }
#endif
