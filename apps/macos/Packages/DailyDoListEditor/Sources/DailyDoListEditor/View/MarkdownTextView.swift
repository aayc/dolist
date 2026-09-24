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
  /// After the background, before the text and the selection.
  func textView(_ textView: MarkdownTextView, drawBackgroundIn rect: NSRect)
  func textView(_ textView: MarkdownTextView, drawOverlaysIn dirtyRect: NSRect)
  func textViewDidChangeWidth(_ textView: MarkdownTextView)
  func textViewDidChangeFocus(_ textView: MarkdownTextView)
  /// The window was hidden (minimized, covered) or shown again.
  func textViewDidChangeOcclusion(_ textView: MarkdownTextView)

  // MARK: Vim

  /// A key press, before the text view interprets it: true when vim took it.
  func textView(_ textView: MarkdownTextView, handleKeyDown event: NSEvent) -> Bool
  /// Whether a key equivalent (a Ctrl key) belongs to vim rather than to a menu.
  func textView(_ textView: MarkdownTextView, claimsKeyEquivalent event: NSEvent) -> Bool
  /// The text view is about to replace `ranges` (pre-edit offsets) with `strings`. True when the
  /// editor records the undo step itself (the text view must not register one).
  func textView(_ textView: MarkdownTextView, willReplace ranges: [NSRange], with strings: [String]) -> Bool
  /// The change announced last was refused (nothing was replaced).
  func textViewDidRefuseChange(_ textView: MarkdownTextView)
  /// Runs `body`, an edit the text view makes for a key or command, labeled with CodeMirror's
  /// user event ("input.type", "delete.backward", "input.paste"…).
  func textView(_ textView: MarkdownTextView, edit userEvent: String, _ body: () -> Void)
  /// Types `text` at every cursor of a multiple selection (vim's block insert); false otherwise.
  func textView(_ textView: MarkdownTextView, insertAtEveryCursor text: String) -> Bool
  /// Deletes backward/forward at every cursor of a multiple selection; false otherwise.
  func textView(_ textView: MarkdownTextView, deleteAtEveryCursor forward: Bool) -> Bool
  /// Before a paste: true when the editor took it (vim's command line has the paste).
  func textViewWillPaste(_ textView: MarkdownTextView) -> Bool
  /// Whether the text view draws its own caret (vim draws a block in normal mode).
  func textViewDrawsInsertionPoint(_ textView: MarkdownTextView) -> Bool
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

  override func keyDown(with event: NSEvent) {
    if hooks?.textView(self, handleKeyDown: event) == true { return }
    super.keyDown(with: event)
  }

  /// NSTextView's own key handling (vim's "native edit" in insert mode).
  func interpretKeyDown(_ event: NSEvent) {
    super.keyDown(with: event)
  }

  override func insertText(_ string: Any, replacementRange: NSRange) {
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    if !hasMarkedText(), replacementRange.location == NSNotFound, hooks?.textView(self, insertAtEveryCursor: text) == true {
      return
    }
    edit("input.type") { super.insertText(string, replacementRange: replacementRange) }
  }

  override func insertNewline(_ sender: Any?) {
    if hooks?.textView(self, insertAtEveryCursor: "\n") == true { return }
    if hooks?.textViewHandleNewline(self) == true { return }
    edit("input") { super.insertNewline(sender) }
  }

  override func insertTab(_ sender: Any?) {
    if hooks?.textView(self, insertAtEveryCursor: "\t") == true { return }
    if hooks?.textViewHandleTab(self, backwards: false) == true { return }
    edit("input") { super.insertTab(sender) }
  }

  override func insertBacktab(_ sender: Any?) {
    if hooks?.textViewHandleTab(self, backwards: true) == true { return }
    edit("input") { super.insertBacktab(sender) }
  }

  override func deleteBackward(_ sender: Any?) {
    if hooks?.textView(self, deleteAtEveryCursor: false) == true { return }
    if hooks?.textViewHandleDeleteBackward(self) == true { return }
    edit("delete.backward") { super.deleteBackward(sender) }
  }

  override func deleteForward(_ sender: Any?) {
    if hooks?.textView(self, deleteAtEveryCursor: true) == true { return }
    edit("delete.forward") { super.deleteForward(sender) }
  }

  /// Other key commands (⌥⌫, ⌘⌫, ⌃K, transpose…) keep CodeMirror's labels for vim's undo history.
  override func doCommand(by selector: Selector) {
    let name = NSStringFromSelector(selector)
    guard name.hasPrefix("delete") || name.hasPrefix("transpose") || name.hasPrefix("yank") || name.hasPrefix("insert") else {
      return super.doCommand(by: selector)
    }
    let forward = name.contains("Forward") || name.contains("ToEnd")
    let userEvent = name.hasPrefix("delete") ? (forward ? "delete.forward" : "delete.backward") : "input"
    edit(userEvent) { super.doCommand(by: selector) }
  }

  /// An IME composition: vim hears about it once it's committed (its steps aren't typed text).
  override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    edit("input.type") { super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange) }
  }

  override func unmarkText() {
    edit("input.type") { super.unmarkText() }
  }

  override func paste(_ sender: Any?) {
    if hooks?.textViewWillPaste(self) == true { return }
    edit("input.paste") { super.paste(sender) }
  }

  override func pasteAsPlainText(_ sender: Any?) {
    if hooks?.textViewWillPaste(self) == true { return }
    edit("input.paste") { super.pasteAsPlainText(sender) }
  }

  override func cut(_ sender: Any?) {
    edit("delete.cut") { super.cut(sender) }
  }

  override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    var accepted = false
    edit("input.drop") { accepted = super.performDragOperation(sender) }
    return accepted
  }

  private func edit(_ userEvent: String, _ body: () -> Void) {
    if let hooks { hooks.textView(self, edit: userEvent, body) } else { body() }
  }

  /// Vim records the undo steps of the edits it sees (CodeMirror's history, which `u` walks), so
  /// the text view must not register its own for them.
  override func shouldChangeText(inRanges affectedRanges: [NSValue], replacementStrings: [String]?) -> Bool {
    guard let hooks, let replacementStrings, replacementStrings.count == affectedRanges.count,
      hooks.textView(self, willReplace: affectedRanges.map(\.rangeValue), with: replacementStrings)
    else { return super.shouldChangeText(inRanges: affectedRanges, replacementStrings: replacementStrings) }
    let manager = undoManager
    manager?.disableUndoRegistration()
    let allowed = super.shouldChangeText(inRanges: affectedRanges, replacementStrings: replacementStrings)
    manager?.enableUndoRegistration()
    if !allowed { hooks.textViewDidRefuseChange(self) }
    return allowed
  }

  /// Editor shortcuts (⌘B, ⌘I, ⌘K, ⌘L, ⌘↩, ⌘S, ⌘F, …) win over menu items with the same key while
  /// the editor has focus. Key equivalents reach every view in the window, hence the check. In
  /// vim's normal and visual mode the Ctrl keys vim binds go to vim instead of a menu.
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if event.type == .keyDown, window?.firstResponder === self {
      if hooks?.textView(self, claimsKeyEquivalent: event) == true {
        keyDown(with: event)
        return true
      }
      if hooks?.textView(self, performShortcut: event) == true { return true }
    }
    return super.performKeyEquivalent(with: event)
  }

  // MARK: Scrolling

  /// Set while vim measures text: filling non-contiguous layout holes resizes the text view, which
  /// then scrolls the selection into view on its own, but vim decides what scrolls.
  var suppressesAutomaticScrolling = false

  override func scrollToVisible(_ rect: NSRect) -> Bool {
    if suppressesAutomaticScrolling { return false }
    return super.scrollToVisible(rect)
  }

  // MARK: Insertion point

  override var shouldDrawInsertionPoint: Bool {
    guard hooks?.textViewDrawsInsertionPoint(self) ?? true else { return false }
    return super.shouldDrawInsertionPoint
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

  override func drawBackground(in rect: NSRect) {
    super.drawBackground(in: rect)
    hooks?.textView(self, drawBackgroundIn: rect)
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
      NotificationCenter.default.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: window)
      NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: window)
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
      let center = NotificationCenter.default
      center.addObserver(
        self, selector: #selector(windowDidChangeOcclusion(_:)), name: NSWindow.didChangeOcclusionStateNotification,
        object: window)
      center.addObserver(self, selector: #selector(windowDidChangeKey(_:)), name: NSWindow.didBecomeKeyNotification, object: window)
      center.addObserver(self, selector: #selector(windowDidChangeKey(_:)), name: NSWindow.didResignKeyNotification, object: window)
    }
  }

  /// Whether the text view is first responder in the key window (vim's block cursor is solid then).
  var isKeyFocus: Bool { hasFocus && (window?.isKeyWindow ?? false) }

  @objc private func windowDidChangeOcclusion(_ notification: Notification) {
    hooks?.textViewDidChangeOcclusion(self)
  }

  @objc private func windowDidChangeKey(_ notification: Notification) {
    hooks?.textViewDidChangeFocus(self)
  }
}
