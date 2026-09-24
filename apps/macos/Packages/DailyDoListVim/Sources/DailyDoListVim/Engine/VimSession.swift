// Ported from the vim view plugin of @replit/codemirror-vim 6.4.0 (`vimPlugin`: `handleKey`,
// `update`; MIT, © Marijn Haverbeke and others): how key presses and editor updates reach vim.js.

/// Vim attached to one editor: feed it keys, observe its mode, and report the edits the host
/// makes on its own (typing in insert mode, mouse selections) so `.` and marks keep working.
///
/// This plays the role of the web app's vim view plugin (`@replit/codemirror-vim`'s `vimPlugin`).
@MainActor
public final class VimSession {
  /// The mode as the web app reports it.
  public enum Mode: String, Sendable {
    case normal, insert, replace, visual
    case visualLine = "visual-line"
    case visualBlock = "visual-block"
  }

  public let vim: Vim
  /// The editor, not retained: the host keeps it alive while the session is in use.
  public unowned let editor: any VimEditor
  let cm: EditorAdapter
  private let modeToken = HandlerToken()
  private let commandDoneToken = HandlerToken()
  private let keypressToken = HandlerToken()
  /// False once `detach()` was called.
  public private(set) var isAttached = true

  /// Called when the mode changes ("normal", "insert", "replace", "visual" with sub-mode
  /// "linewise" / "blockwise"): vim.js's `vim-mode-change` event.
  public var onModeChange: ((_ mode: String, _ subMode: String?) -> Void)?
  /// Called for every key vim handled (`vim-keypress`).
  public var onKeypress: ((String) -> Void)?
  /// Called when a command finished and the pending keys were cleared (`vim-command-done`).
  public var onCommandDone: (() -> Void)?
  /// Called when a command throws. vim then resets this editor's vim state; the default logs
  /// nothing.
  public var onError: ((JSException) -> Void)?
  /// The text of the last notification vim showed (for tests and status bars).
  public internal(set) var lastMessage: String?

  init(vim: Vim, editor: any VimEditor) {
    self.vim = vim
    self.editor = editor
    cm = EditorAdapter(host: editor, scheduler: vim.scheduler)
    cm.session = self
    vim.enterVimMode(cm)
    cm.on(.vimCommandDone, commandDoneToken) { [unowned self] _ in
      self.cm.vim?.status = ""
      self.onCommandDone?()
    }
    cm.on(.vimModeChange, modeToken) { [unowned self] payload in
      guard let state = self.cm.vim, case .modeChange(let mode, let subMode) = payload else { return }
      state.mode = mode + (subMode.map { $0.isEmpty ? "" : $0 == "linewise" ? " line" : " block" } ?? "")
      state.status = ""
      self.onModeChange?(mode, subMode)
    }
    cm.on(.vimKeypress, keypressToken) { [unowned self] payload in
      if case .keypress(let key) = payload { self.onKeypress?(key) }
    }
  }

  /// Detaches vim (`leaveVimMode`). The session can't be used afterwards.
  public func detach() {
    guard isAttached else { return }
    isAttached = false
    cm.off(.vimCommandDone, commandDoneToken)
    cm.off(.vimModeChange, modeToken)
    cm.off(.vimKeypress, keypressToken)
    vim.leaveVimMode(cm)
  }

  // MARK: Keys

  /// Handles a key in vim notation ("a", "A", "<C-d>", "<Esc>", "<CR>", "<S-Tab>") the way the web
  /// app's editor does:
  ///
  /// - while a prompt is open (`activePrompt`), the key goes to the prompt (`VimPanel.handleKey`);
  /// - otherwise vim handles it; in replace mode a key vim doesn't handle overwrites the next
  ///   character (when its DOM `key` is one character) or, for Backspace, moves left;
  /// - a key still unhandled in insert or replace mode is the host's to perform: `nativeEdit` is
  ///   called (type the character, delete…), and the host reports the edit with
  ///   `editorDidChange`. Vim then records Backspace and Delete for `.`.
  ///
  /// Afterwards the key's release goes to the prompt that is open, if any (a search prompt
  /// updates its incremental search). Returns false when nobody handled the key.
  @discardableResult
  public func handleKey(_ key: String, nativeEdit: (() -> Bool)? = nil) -> Bool {
    guard isAttached else { return false }
    let event = DOMKeyEvent(vimKey: key)
    var handled = true
    if let prompt = cm.activePrompt {
      if !prompt.keyDown(event) { prompt.performDefaultAction(event) }
    } else {
      handled = sendToEditor(key, event, nativeEdit: nativeEdit)
    }
    cm.activePrompt?.keyUp(event)
    return handled
  }

  /// The vim view plugin's `handleKey`, the host's native edit, then vim's own keydown listener
  /// (registered in insert mode), which sees Backspace and Delete if it was listening before the
  /// key and still is.
  private func sendToEditor(_ key: String, _ event: DOMKeyEvent, nativeEdit: (() -> Bool)?) -> Bool {
    let listening = cm.inputFieldKeydown.map(\.0)
    var state = vim.maybeInitVimState(cm)
    // The web app clears the search highlight on <Esc> in normal mode.
    if key == "<Esc>" && !state.insertMode && !state.visualMode && cm.searchHighlight != nil {
      cm.removeOverlay()
      state.searchState?.overlay = nil
      state.searchState?.hasOverlay = false
    }
    state.status += key
    var handled: Bool
    do {
      handled = try vim.multiSelectHandleKey(cm, VimText(key), "user")
    } catch {
      report(error)
      handled = true
    }
    // The state object is replaced when a command throws.
    state = vim.maybeInitVimState(cm)
    if !handled && state.insertMode && cm.overwrite {
      if let text = event.overwriteText {
        handled = true
        cm.overWriteSelection(text)
      } else if event.key == "Backspace" {
        handled = true
        cm.cursorCharLeft()
      }
    }
    if handled {
      cm.signal(.vimKeypress, .keypress(key))
    } else if state.insertMode, let nativeEdit {
      handled = nativeEdit()
    }
    if event.key == "Backspace" || event.key == "Delete" {
      for (token, listener) in cm.inputFieldKeydown where listening.contains(where: { $0 === token }) { listener(event) }
    }
    return handled
  }

  /// The vim key for a key press, with 'langmap' applied (vim.js's `vimKeyFromEvent(e, vim)`).
  public func vimKey(for input: VimKeyInput) -> String? {
    let state = vim.maybeInitVimState(cm)
    let context = VimKeyNotation.LangmapContext(
      expectLiteralNext: state.expectLiteralNext, keymap: vim.langmap.keymap, remapCtrl: vim.langmap.remapCtrl, usedKeys: vim.usedKeys)
    let event = DOMKeyEvent(key: input.key, ctrlKey: input.control, altKey: input.alt, metaKey: input.meta, shiftKey: input.shift, code: input.code)
    return VimKeyNotation.vimKeyFromEvent(event, isMac: vim.isMac, langmap: context)
  }

  /// Runs an ex command line, e.g. "s/foo/bar/g" (`Vim.handleEx`).
  public func handleEx(_ input: String) throws {
    try vim.exProcessCommand(cm, VimText(input))
  }

  // MARK: What the host does on its own

  /// Reports an edit the host made itself (typing, deleting, pasting in insert mode) after
  /// applying it, with the selection afterwards. Vim records insert-mode text for `.` from these.
  public func editorDidChange(_ transaction: VimTransaction) {
    guard isAttached else { return }
    cm.hostDidApply(transaction)
  }

  /// Reports a selection change the host made itself (a click, a drag): vim enters or leaves
  /// visual mode to match.
  public func editorSelectionDidChange() {
    guard isAttached else { return }
    cm.hostDidApply(VimTransaction(changes: [], selection: editor.vimSelection), selectionSet: true)
  }

  /// Reports a paste: in normal mode vim moves right and enters insert mode first.
  public func willPaste() {
    for (_, listener) in cm.inputFieldPaste { listener() }
  }

  // MARK: State

  public var mode: Mode {
    guard let state = cm.vim else { return .normal }
    if state.insertMode { return cm.overwrite ? .replace : .insert }
    if state.visualMode {
      if state.visualBlock { return .visualBlock }
      return state.visualLine ? .visualLine : .visual
    }
    return .normal
  }

  /// The keys typed since the last command finished ("2d", "\"a"), for a status bar.
  public var pendingKeys: String { cm.vim?.status ?? "" }

  /// The register picked with `"x` for the command being typed (vim.js keeps it in the input
  /// state after `"x` finished as a command of its own).
  public var pendingRegister: String? { cm.vim?.inputState.registerName }

  public var isRecordingMacro: Bool { vim.globalState.macroModeState.isRecording }

  /// The register a macro is being recorded into (`qa` → "a"), nil when not recording.
  public var recordingRegister: String? {
    let state = vim.globalState.macroModeState
    return state.isRecording ? state.latestRegister : nil
  }

  /// The open prompt (`:`, `/`, `?`, `:s///c`), if any; route keys to it.
  public var activePrompt: VimPanel? { cm.activePrompt }

  /// The panel on display (prompt, message or status), if any.
  public var panel: VimPanel? { cm.dialog }

  /// The main cursor.
  public var cursor: VimPosition { cm.getCursor() }

  /// The selections as positions.
  public var selections: [VimRange] { cm.listSelections() }

  /// Leaves insert mode (`Vim.exitInsertMode`).
  public func exitInsertMode() {
    do { try vim.exitInsertMode(cm) } catch { report(error) }
  }

  /// Leaves visual mode (`Vim.exitVisualMode`).
  public func exitVisualMode() {
    do { try vim.exitVisualMode(cm) } catch { report(error) }
  }

  /// Shows `message` in the panel like vim's own notifications (`openNotification`), for host
  /// commands ("`:quit` isn't available here"). It closes after `duration` seconds (nil: stays
  /// until replaced).
  public func notify(_ message: String, duration: Double? = 5) {
    guard isAttached else { return }
    cm.openNotification(message, long: false, duration: duration ?? 0)
  }

  func report(_ error: any Error) {
    let exception = JSException.from(error)
    onError?(exception)
    vim.onError?(exception)
  }
}
