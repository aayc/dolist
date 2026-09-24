import AppKit
import SwiftUI

// Public API of the native editor. (Initial baseline: a plain NSTextView — replaced by the full
// TextKit implementation with styling, live preview, checkboxes, badges and list commands.)

/// An agent badge drawn at the end of a task line.
public struct EditorBadge: Hashable, Sendable, Identifiable {
  /// Task id (stable across edits).
  public var id: String
  /// 0-based line.
  public var line: Int
  /// `TaskAgentStatus` raw value (`working`, `waiting_approval`, `done`, …).
  public var status: String
  /// Short pill text, e.g. "Researching…", "Needs approval".
  public var label: String
  public var unread: Int
  public var threadId: String?

  public init(id: String, line: Int, status: String, label: String, unread: Int = 0, threadId: String? = nil) {
    self.id = id
    self.line = line
    self.status = status
    self.label = label
    self.unread = unread
    self.threadId = threadId
  }
}

public struct EditorConfiguration: Hashable, Sendable {
  public var fontSize: Double
  /// Hide markdown syntax away from the cursor (Obsidian live preview); false = dim it.
  public var livePreview: Bool
  /// Center the text in a readable column.
  public var readableLineLength: Bool
  public var spellcheck: Bool
  public var showLineNumbers: Bool
  public var isEditable: Bool

  public init(
    fontSize: Double = 16, livePreview: Bool = true, readableLineLength: Bool = true,
    spellcheck: Bool = false, showLineNumbers: Bool = false, isEditable: Bool = true
  ) {
    self.fontSize = fontSize
    self.livePreview = livePreview
    self.readableLineLength = readableLineLength
    self.spellcheck = spellcheck
    self.showLineNumbers = showLineNumbers
    self.isEditable = isEditable
  }
}

@MainActor
public protocol MarkdownEditorDelegate: AnyObject {
  /// Every text change made by the user (not `setText`). Keep it cheap; the host debounces saves.
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String)
  func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge)
  /// A `[[wikilink]]` was clicked (⌘-click = `newWindow`).
  func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool)
  func editor(_ editor: MarkdownEditorController, didClickLink url: URL)
  /// The caret moved to another 0-based line (throttle before sending presence).
  func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int)
  /// ⌘S
  func editorDidRequestSave(_ editor: MarkdownEditorController)
}

extension MarkdownEditorDelegate {
  public func editorTextDidChange(_ editor: MarkdownEditorController, text: String) {}
  public func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge) {}
  public func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool) {}
  public func editor(_ editor: MarkdownEditorController, didClickLink url: URL) {}
  public func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int) {}
  public func editorDidRequestSave(_ editor: MarkdownEditorController) {}
}

/// Saved per-note editor state for instant tab switches (text, selection, scroll, undo).
public struct EditorSnapshot {
  public var text: String
  public var selectedRange: NSRange
  public var scrollOffset: CGPoint

  public init(text: String, selectedRange: NSRange = NSRange(location: 0, length: 0), scrollOffset: CGPoint = .zero) {
    self.text = text
    self.selectedRange = selectedRange
    self.scrollOffset = scrollOffset
  }
}

/// Imperative handle on one editor instance.
@MainActor
public final class MarkdownEditorController {
  public weak var delegate: MarkdownEditorDelegate?
  public let scrollView: NSScrollView
  public let textView: NSTextView
  public private(set) var configuration: EditorConfiguration
  public private(set) var badges: [EditorBadge] = []
  private var applyingProgrammaticChange = false

  public init(configuration: EditorConfiguration = EditorConfiguration()) {
    self.configuration = configuration
    scrollView = NSTextView.scrollableTextView()
    textView = scrollView.documentView as! NSTextView
    textView.isRichText = false
    textView.allowsUndo = true
    textView.font = .systemFont(ofSize: configuration.fontSize)
    NotificationCenter.default.addObserver(
      forName: NSText.didChangeNotification, object: textView, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, !self.applyingProgrammaticChange else { return }
        self.delegate?.editorTextDidChange(self, text: self.textView.string)
      }
    }
  }

  public var text: String { textView.string }

  /// Replaces the document (external change or note switch) without notifying the delegate.
  public func setText(_ text: String, resetUndo: Bool = false) {
    applyingProgrammaticChange = true
    textView.string = text
    applyingProgrammaticChange = false
    if resetUndo { textView.undoManager?.removeAllActions() }
  }

  public func setBadges(_ badges: [EditorBadge]) {
    self.badges = badges
  }

  public func configure(_ configuration: EditorConfiguration) {
    self.configuration = configuration
    textView.font = .systemFont(ofSize: configuration.fontSize)
    textView.isEditable = configuration.isEditable
    textView.isContinuousSpellCheckingEnabled = configuration.spellcheck
  }

  public func focus() {
    textView.window?.makeFirstResponder(textView)
  }

  public func scrollToLine(_ line: Int) {
    let lines = textView.string.components(separatedBy: "\n")
    let clamped = max(0, min(line, lines.count - 1))
    let offset = lines.prefix(clamped).reduce(0) { $0 + ($1 as NSString).length + 1 }
    textView.setSelectedRange(NSRange(location: offset, length: 0))
    textView.scrollRangeToVisible(NSRange(location: offset, length: 0))
  }

  public func snapshot() -> EditorSnapshot {
    EditorSnapshot(
      text: textView.string, selectedRange: textView.selectedRange(),
      scrollOffset: scrollView.contentView.bounds.origin)
  }

  public func restore(_ snapshot: EditorSnapshot) {
    setText(snapshot.text, resetUndo: true)
    let length = (snapshot.text as NSString).length
    textView.setSelectedRange(NSRange(location: min(snapshot.selectedRange.location, length), length: 0))
    scrollView.contentView.scroll(to: snapshot.scrollOffset)
  }
}

/// SwiftUI host for a controller.
public struct MarkdownEditorView: NSViewRepresentable {
  public let controller: MarkdownEditorController

  public init(controller: MarkdownEditorController) {
    self.controller = controller
  }

  public func makeNSView(context: Context) -> NSScrollView { controller.scrollView }
  public func updateNSView(_ nsView: NSScrollView, context: Context) {}
}
