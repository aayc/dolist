// Ported from vim.js (@replit/codemirror-vim-core 0.1.0) `showConfirm` / `showPrompt` and from
// `openDialog` / `openNotification` of @replit/codemirror-vim 6.4.0 (MIT, © Marijn Haverbeke and
// others), with the DOM replaced by `VimPanel`.

/// What vim passes to `showPrompt` (a prompt may be "virtual" while a mapping types into it).
@MainActor
final class PromptOptions {
  var prefix: String
  var desc: String?
  var value: VimText
  var onClose: ((VimText) throws -> Void)?
  var onKeyDown: VimPanel.KeyHook?
  var onKeyUp: VimPanel.KeyHook?
  var onDescClick: (() -> Void)?

  init(prefix: String, value: VimText = VimText()) {
    self.prefix = prefix
    self.value = value
  }
}

extension Vim {
  /// `showConfirm(cm, template, long, duration)`: a notification. Long ones stay until the next
  /// key (which `<CR>` only dismisses).
  func showConfirm(_ cm: EditorAdapter, _ text: String, long: Bool = false, duration: Double? = nil)
  {
    if long {
      cm.closeVimNotification?()
      cm.closeVimNotification = cm.openNotification(text, long: true, duration: 0)
    } else {
      cm.openNotification(text, long: false, duration: duration ?? 15)
    }
  }

  /// `showPrompt(cm, options)`: opens a prompt, or makes it virtual while a mapping runs.
  func showPrompt(_ cm: EditorAdapter, _ options: PromptOptions) {
    if !keyToKeyStack.isEmpty {
      virtualPrompt = options
      return
    }
    cm.openDialog(options)
  }

  /// `vimKeyFromEvent(e)` without langmap (what the prompt hooks use).
  func vimKeyFromEvent(_ e: DOMKeyEvent) -> String? {
    VimKeyNotation.vimKeyFromEvent(e, isMac: isMac, langmap: nil)
  }
}

extension EditorAdapter {
  /// `openDialog(template, callback, options)` for a prompt.
  @discardableResult
  func openDialog(_ options: PromptOptions) -> (VimText?) -> Void {
    closeNotification(nil)
    let panel = VimPanel(
      kind: .prompt, text: options.prefix, value: options.value, detail: options.desc)
    panel.onKeyDown = options.onKeyDown
    panel.onKeyUp = options.onKeyUp
    panel.onSubmit = options.onClose
    panel.onDetailClick = { [weak panel] in
      options.onDescClick?()
      panel?.detail = options.desc
    }
    panel.closeAction = { [weak self, weak panel] in
      guard let self, let panel, !panel.isClosed else { return }
      panel.markClosed()
      self.hideDialog(panel)
      if self.dialog == nil { self.focus() }
    }
    panel.reportError = { [weak self] error in self?.session?.report(error) }
    showDialog(panel)
    return { [weak panel] newValue in
      guard let panel else { return }
      if let newValue { panel.value = newValue } else { panel.close() }
    }
  }

  /// `openDialog(template)` for a status line without input ("recording @q").
  func openStatusDialog(_ text: String) -> () -> Void {
    closeNotification(nil)
    let panel = VimPanel(kind: .status, text: text)
    panel.closeAction = { [weak self, weak panel] in
      guard let self, let panel, !panel.isClosed else { return }
      panel.markClosed()
      self.hideDialog(panel)
      if self.dialog == nil { self.focus() }
    }
    showDialog(panel)
    return { [weak panel] in panel?.close() }
  }

  /// `openNotification(template, options)`: replaces the previous notification; closes itself
  /// after `duration` seconds (0: stays).
  @discardableResult
  func openNotification(_ text: String, long: Bool, duration: Double) -> () -> Void {
    let panel = VimPanel(kind: .message, text: text, duration: duration > 0 ? duration : nil)
    panel.isLong = long
    var timer: VimTimer?
    let close: () -> Void = { [weak self, weak panel] in
      guard let self, let panel, !panel.isClosed else { return }
      panel.markClosed()
      timer?.cancel()
      self.hideDialog(panel)
    }
    panel.closeAction = close
    closeNotification(close)
    showDialog(panel)
    session?.lastMessage = text
    if duration > 0 { timer = scheduler.schedule(after: duration, close) }
    return close
  }

  private func closeNotification(_ newValue: (() -> Void)?) {
    currentNotificationClose?()
    currentNotificationClose = newValue
  }

  private func showDialog(_ panel: VimPanel) {
    let old = dialog
    dialog = panel
    if old !== panel {
      if panel.kind == .prompt { activePrompt = panel }
      host.vimShowPanel(panel)
      signal(.dialog)
    }
  }

  private func hideDialog(_ panel: VimPanel) {
    if activePrompt === panel { activePrompt = nil }
    if dialog === panel {
      dialog = nil
      host.vimShowPanel(nil)
      signal(.dialog)
    }
  }
}
