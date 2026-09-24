import AppKit
import DailyDoListVim

/// Key routing: every key press goes to vim first (the web app's vim plugin runs before any
/// keymap).
///
/// - Marked text (an IME composition) bypasses vim.
/// - Keys vim leaves alone in insert and replace mode are the text view's (`nativeEdit`), so
///   typing, list continuation, Tab and Backspace behave as without vim; vim sees their edits.
/// - In normal and visual mode nothing reaches the text view or the input system (press-and-hold
///   accent popups never take `j` or `e`, key repeat works), except ⌘ keys vim doesn't bind.
/// - Ctrl keys vim binds win over menus in normal and visual mode (`claimsKeyEquivalent`).
extension TextViewVimHost {
  func handleKeyDown(_ event: NSEvent) -> Bool {
    guard let session, !textView.hasMarkedText() else { return false }
    guard let input = VimKeyEvents.input(for: event), let key = session.vimKey(for: input) else {
      // Nothing vim can name (a dead key): the text view composes it in insert mode, nobody does
      // elsewhere.
      return session.activePrompt != nil || (session.mode != .insert && session.mode != .replace)
    }
    route(key, input: input) { [unowned self] in
      textView.interpretKeyDown(event)
      flushToVim()
      return true
    }
    return true
  }

  /// Sends one vim key; `native` performs the text view's own handling of it.
  func route(_ key: String, input: VimKeyInput? = nil, native: @escaping () -> Bool) {
    guard let session else { return }
    flushToVim()
    prepareLayout()
    keyDepth += 1
    beginOperation(userEvent: "input")
    let handled = session.handleKey(key, nativeEdit: native)
    if !handled, input?.meta == true, session.isAttached, session.mode != .insert, session.mode != .replace {
      _ = native()
    }
    endOperation()
    keyDepth -= 1
    if keyDepth == 0, needsFreshSession {
      needsFreshSession = false
      let vim = session.vim
      detach()
      attach(vim)
    }
    applyPendingScroll()
    if statusIsStale { reportStatus() }
    cursorDidChange()
  }

  /// A Ctrl key (without ⌘) that vim binds in normal or visual mode, or any Ctrl key while vim's
  /// command line is open: it goes to vim, not to a menu with the same shortcut.
  func claimsKeyEquivalent(_ event: NSEvent) -> Bool {
    guard let session, !textView.hasMarkedText() else { return false }
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard flags.contains(.control), !flags.contains(.command) else { return false }
    if session.activePrompt != nil { return true }
    guard session.mode != .insert, session.mode != .replace, let input = VimKeyEvents.input(for: event),
      let key = session.vimKey(for: input)
    else { return false }
    return VimCtrlKeys.isClaimed(key, mapped: EditorVimIntegration.mappedCtrlKeys(for: session.vim))
  }
}
