import AppKit

/// Callbacks from the text view into the editor (implemented by `MarkdownEditorController`).
@MainActor
protocol MarkdownTextViewHooks: AnyObject {
  /// Lets the editor move a proposed caret out of hidden syntax.
  func textView(_ textView: MarkdownTextView, adjust proposed: [NSRange], previous: [NSRange]) -> [NSRange]
  func textViewDidChangeSelection(_ textView: MarkdownTextView, stillSelecting: Bool)
  func textViewHandleNewline(_ textView: MarkdownTextView) -> Bool
  func textViewHandleTab(_ textView: MarkdownTextView, backwards: Bool) -> Bool
  func textViewHandleDeleteBackward(_ textView: MarkdownTextView) -> Bool
  func textView(_ textView: MarkdownTextView, performShortcut event: NSEvent) -> Bool
  func textView(_ textView: MarkdownTextView, mouseDownAt point: NSPoint, modifiers: NSEvent.ModifierFlags) -> Bool
  func textView(_ textView: MarkdownTextView, mouseMovedTo point: NSPoint?, modifiers: NSEvent.ModifierFlags)
  func textView(_ textView: MarkdownTextView, toolTipAt point: NSPoint) -> String?
  func textViewWillDraw(_ textView: MarkdownTextView)
  func textView(_ textView: MarkdownTextView, drawOverlaysIn dirtyRect: NSRect)
  func textViewDidChangeWidth(_ textView: MarkdownTextView)
  func textViewDidChangeFocus(_ textView: MarkdownTextView)
  /// The window was hidden (minimized, covered) or shown again.
  func textViewDidChangeOcclusion(_ textView: MarkdownTextView)
}

/// The editor's `NSTextView` (TextKit 1). Deliberately thin: it forwards selection changes, key
/// commands, mouse events, overlay drawing, resizing and focus changes to `hooks`.
final class MarkdownTextView: NSTextView, NSViewToolTipOwner {
  weak var hooks: MarkdownTextViewHooks?
  /// Focus was requested before the view was in a window (the app's first note at launch).
  var focusWhenInWindow = false
  private var hoverArea: NSTrackingArea?
  private var lastWidth: CGFloat = -1
  private var hasFocus = false

  /// Whether the editor counts as focused for live preview. Offscreen (no window) counts as focused.
  var isEditorFocused: Bool { window == nil || hasFocus }

  override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
    var adjusted = ranges
    if let hooks, !ranges.isEmpty {
      let proposed = ranges.map(\.rangeValue)
      let result = hooks.textView(self, adjust: proposed, previous: selectedRanges.map(\.rangeValue))
      if result != proposed { adjusted = result.map { NSValue(range: $0) } }
    }
    super.setSelectedRanges(adjusted, affinity: affinity, stillSelecting: stillSelecting)
    hooks?.textViewDidChangeSelection(self, stillSelecting: stillSelecting)
  }

  // MARK: Keys

  override func insertNewline(_ sender: Any?) {
    if hooks?.textViewHandleNewline(self) == true { return }
    super.insertNewline(sender)
  }

  override func insertTab(_ sender: Any?) {
    if hooks?.textViewHandleTab(self, backwards: false) == true { return }
    super.insertTab(sender)
  }

  override func insertBacktab(_ sender: Any?) {
    if hooks?.textViewHandleTab(self, backwards: true) == true { return }
    super.insertBacktab(sender)
  }

  override func deleteBackward(_ sender: Any?) {
    if hooks?.textViewHandleDeleteBackward(self) == true { return }
    super.deleteBackward(sender)
  }

  /// Editor shortcuts (⌘B, ⌘I, ⌘K, ⌘L, ⌘↩, ⌘S, ⌘F, …) win over menu items with the same key while
  /// the editor has focus. Key equivalents reach every view in the window, hence the check.
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if event.type == .keyDown, window?.firstResponder === self, hooks?.textView(self, performShortcut: event) == true {
      return true
    }
    return super.performKeyEquivalent(with: event)
  }

  // MARK: Mouse

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    if hooks?.textView(self, mouseDownAt: point, modifiers: event.modifierFlags) == true { return }
    super.mouseDown(with: event)
  }

  override func mouseMoved(with event: NSEvent) {
    super.mouseMoved(with: event)
    hooks?.textView(self, mouseMovedTo: convert(event.locationInWindow, from: nil), modifiers: event.modifierFlags)
  }

  override func mouseExited(with event: NSEvent) {
    super.mouseExited(with: event)
    hooks?.textView(self, mouseMovedTo: nil, modifiers: event.modifierFlags)
  }

  override func flagsChanged(with event: NSEvent) {
    super.flagsChanged(with: event)
    guard let window, window.isKeyWindow else { return }
    let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
    if visibleRect.contains(point) {
      hooks?.textView(self, mouseMovedTo: point, modifiers: event.modifierFlags)
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let hoverArea, trackingAreas.contains(hoverArea) { return }
    let area = NSTrackingArea(
      rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self,
      userInfo: nil)
    addTrackingArea(area)
    hoverArea = area
  }

  func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?)
    -> String
  {
    hooks?.textView(self, toolTipAt: point) ?? ""
  }

  // MARK: Drawing, geometry, focus

  override func viewWillDraw() {
    super.viewWillDraw()
    hooks?.textViewWillDraw(self)
  }

  override func draw(_ dirtyRect: NSRect) {
    // NSTextView leaves the clip narrowed to the text container; badges live in the margin right
    // of it.
    NSGraphicsContext.saveGraphicsState()
    super.draw(dirtyRect)
    NSGraphicsContext.restoreGraphicsState()
    hooks?.textView(self, drawOverlaysIn: dirtyRect)
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    if newSize.width != lastWidth {
      lastWidth = newSize.width
      hooks?.textViewDidChangeWidth(self)
    }
  }

  override func becomeFirstResponder() -> Bool {
    let accepted = super.becomeFirstResponder()
    if accepted {
      hasFocus = true
      hooks?.textViewDidChangeFocus(self)
    }
    return accepted
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned {
      hasFocus = false
      hooks?.textViewDidChangeFocus(self)
    }
    return resigned
  }

  override func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    if let window {
      NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: window)
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if focusWhenInWindow, let window {
      focusWhenInWindow = false
      window.makeFirstResponder(self)
    }
    hasFocus = window?.firstResponder === self
    hooks?.textViewDidChangeFocus(self)
    if let window {
      NotificationCenter.default.addObserver(
        self, selector: #selector(windowDidChangeOcclusion(_:)), name: NSWindow.didChangeOcclusionStateNotification,
        object: window)
    }
  }

  @objc private func windowDidChangeOcclusion(_ notification: Notification) {
    hooks?.textViewDidChangeOcclusion(self)
  }
}
