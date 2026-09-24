import AppKit

/// Receives AppKit delegate callbacks and notifications for a controller (which isn't an
/// `NSObject`, keeping those conformances out of the public API).
@MainActor
final class TextSystemBridge: NSObject, NSTextViewDelegate {
  weak var controller: MarkdownEditorController?

  func observe(clipView: NSClipView) {
    clipView.postsBoundsChangedNotifications = true
    clipView.postsFrameChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(clipViewDidChange(_:)), name: NSView.boundsDidChangeNotification,
      object: clipView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(clipViewDidChange(_:)), name: NSView.frameDidChangeNotification,
      object: clipView)
  }

  @objc private func clipViewDidChange(_ notification: Notification) {
    controller?.clipViewDidChange()
  }

  func textDidChange(_ notification: Notification) {
    controller?.textViewDidChangeText()
  }

  func undoManager(for view: NSTextView) -> UndoManager? {
    controller?.noteUndoManager
  }
}

extension TextSystemBridge: @preconcurrency NSTextStorageDelegate {
  /// Restyling happens here, not in `willProcessEditing`: attribute changes made there are merged
  /// into the storage's edited range, and NSTextView then puts the caret at the end of that range
  /// (the end of the restyled line) instead of after the typed character. Changes made here are not
  /// reported to the layout manager, so it invalidates the restyled lines itself once it has
  /// processed the edit (`MarkdownLayoutManager.invalidateAfterEdit`).
  func textStorage(
    _ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions,
    range editedRange: NSRange,
    changeInLength delta: Int
  ) {
    guard editedMask.contains(.editedCharacters) else { return }
    controller?.storageDidEditCharacters(in: editedRange, changeInLength: delta)
  }
}
