// Ported from the dialog of @replit/codemirror-vim 6.4.0 (`openDialog`, `openNotification`; MIT,
// © Marijn Haverbeke and others): the prompt input's key handling, without the DOM.

/// What vim shows at the bottom of the editor: a prompt with a text input (`:`, `/`, `?`, the
/// `:s///c` confirmation) or a message (a notification, or the "recording @q" indicator).
///
/// A host renders the current panel (`VimEditor.vimShowPanel`) and routes every key typed while a
/// prompt is shown to `handleKey(_:)`, which behaves like the text input of the web app's dialog:
/// the prompt's key hooks run first, then printable keys are appended and `<BS>` deletes, `<CR>`
/// submits and `<Esc>` cancels unless a hook consumed the key.
@MainActor
public final class VimPanel {
  public enum Kind: Sendable {
    /// A command line with a text input.
    case prompt
    /// A notification (an error, "3 lines yanked", the output of `:registers`).
    case message
    /// A status line without input ("recording @q").
    case status
  }

  public let kind: Kind
  /// For a prompt, the text before the input (":", "/", "?", "replace with … (y/n/a/q/l)"); for
  /// a message, its text.
  public let text: String
  /// A hint shown after a search prompt ("(JavaScript regexp: set pcre)").
  public internal(set) var detail: String?
  /// The prompt's input text.
  public internal(set) var value: VimText
  public private(set) var isClosed = false
  /// How long a message stays up, in seconds (nil: until replaced or closed).
  public let duration: Double?
  /// A message that stays until the next key: show "Press ENTER or type command to continue"
  /// after it (`<CR>` then only dismisses it).
  public internal(set) var isLong = false

  /// Called when the host should re-render (the value or detail changed).
  public var onUpdate: (() -> Void)?

  typealias KeyHook = (DOMKeyEvent, VimText, @escaping (VimText?) -> Void) -> Bool
  var onKeyDown: KeyHook?
  var onKeyUp: KeyHook?
  var onInput: KeyHook?
  /// openDialog's callback: called with the value on <CR> (unless a hook consumed it).
  var onSubmit: ((VimText) throws -> Void)?
  /// Where a command that throws while submitting is reported (the prompt then stays open, like
  /// in the web app).
  var reportError: ((any Error) -> Void)?
  /// Closes the panel (set by the adapter).
  var closeAction: (() -> Void)?
  var onDetailClick: (() -> Void)?

  init(kind: Kind, text: String, value: VimText = VimText(), detail: String? = nil, duration: Double? = nil) {
    self.kind = kind
    self.text = text
    self.value = value
    self.detail = detail
    self.duration = duration
  }

  /// Types a key (vim notation: "a", " ", "<CR>", "<Esc>", "<BS>", "<Up>", "<C-u>", …) into the
  /// prompt as the package's own text field, whose caret is always at the end: `keyDown`, the
  /// field's default action (printable keys are appended, `<BS>` deletes the last grapheme
  /// cluster), then `keyUp` if the prompt is still open. `VimSession.handleKey` routes keys here
  /// while the prompt is open.
  public func handleKey(_ key: String) {
    let event = DOMKeyEvent(vimKey: key)
    if !keyDown(event) { performDefaultAction(event) }
    keyUp(event)
  }

  /// A key pressed in a host's own prompt field, before the field handles it: vim's key hook runs,
  /// then the dialog's handling of Enter (submit, then close) and Escape (close). Returns true when
  /// the field must not handle the key itself (it was consumed, or the prompt closed). Afterwards
  /// report text changes with `setValue(_:)` and call `keyUp(_:)`.
  @discardableResult
  public func keyDown(_ key: String) -> Bool { keyDown(DOMKeyEvent(vimKey: key)) }

  /// The key's release, delivered to the prompt that is open after the key (a search prompt runs
  /// incremental search here).
  public func keyUp(_ key: String) { keyUp(DOMKeyEvent(vimKey: key)) }

  /// The text of a host's own prompt field changed.
  public func setValue(_ text: String) {
    value = VimText(text)
  }

  /// The dialog's keydown listener. An exception thrown by the submitted command ends it, like an
  /// exception in a DOM event listener: the prompt stays open (vim has shown the error).
  func keyDown(_ event: DOMKeyEvent) -> Bool {
    guard kind == .prompt, !isClosed else { return true }
    let before = value
    defer { if value != before { onUpdate?() } }
    if !(onKeyDown?(event, value, closeHandler) ?? false) {
      var threw = false
      if event.keyCode == 13 {
        do {
          try onSubmit?(value)
        } catch {
          reportError?(error)
          threw = true
        }
      }
      if !threw && (event.keyCode == 27 || event.keyCode == 13) {
        event.preventDefault()
        close()
      }
    }
    return isClosed || event.defaultPrevented
  }

  /// The emulated text field's default action for a key nothing prevented.
  func performDefaultAction(_ event: DOMKeyEvent) {
    guard kind == .prompt, !isClosed, !event.defaultPrevented else { return }
    let before = value
    if let text = event.insertedText, text != "\n", text != "\t" {
      value += text
    } else if event.token == "<BS>", !value.isEmpty {
      value = value.slice(0, graphemeBoundary(value, value.length, forward: false))
    }
    if value != before { _ = onInput?(event, value, closeHandler) }
  }

  func keyUp(_ event: DOMKeyEvent) {
    guard kind == .prompt, !isClosed else { return }
    _ = onKeyUp?(event, value, closeHandler)
    onUpdate?()
  }

  /// The host's click on `detail` (the search prompt toggles `pcre`).
  public func clickDetail() {
    onDetailClick?()
    onUpdate?()
  }

  /// Closes the panel (for a prompt: cancels it without running the command).
  public func close() {
    guard !isClosed else { return }
    closeAction?()
  }

  /// `close(newValue)` of openDialog: a string replaces the input value, nil closes.
  private var closeHandler: (VimText?) -> Void {
    { [weak self] newValue in
      guard let self else { return }
      if let newValue {
        self.value = newValue
      } else {
        self.close()
      }
    }
  }

  func markClosed() {
    isClosed = true
  }
}

/// The keyboard event vim.js's key hooks inspect (a DOM `KeyboardEvent`).
final class DOMKeyEvent {
  let key: String
  let keyCode: Int
  let ctrlKey: Bool
  let altKey: Bool
  let metaKey: Bool
  let shiftKey: Bool
  let code: String?
  /// The key in vim notation the event was made for, if any.
  let token: String?
  private(set) var defaultPrevented = false

  init(
    key: String, keyCode: Int = 0, ctrlKey: Bool = false, altKey: Bool = false, metaKey: Bool = false, shiftKey: Bool = false,
    code: String? = nil, token: String? = nil
  ) {
    self.key = key
    self.keyCode = keyCode
    self.ctrlKey = ctrlKey
    self.altKey = altKey
    self.metaKey = metaKey
    self.shiftKey = shiftKey
    self.code = code
    self.token = token
  }

  private static let namedKeys: [String: (key: String, keyCode: Int)] = [
    "esc": ("Escape", 27), "cr": ("Enter", 13), "bs": ("Backspace", 8), "del": ("Delete", 46), "tab": ("Tab", 9),
    "space": (" ", 32), "up": ("ArrowUp", 38), "down": ("ArrowDown", 40), "left": ("ArrowLeft", 37),
    "right": ("ArrowRight", 39), "home": ("Home", 36), "end": ("End", 35), "pageup": ("PageUp", 33),
    "pagedown": ("PageDown", 34), "ins": ("Insert", 45), "lt": ("<", 188),
  ]

  /// Whether a key in vim notation is a named key (`<Esc>`, `<C-a>`) rather than a character.
  static func isNamed(_ token: String) -> Bool {
    VimText(token).length > 2 && token.hasPrefix("<") && token.hasSuffix(">")
  }

  /// Letters and digits get their legacy key code; nothing reads the others.
  private static func legacyKeyCode(_ char: String) -> Int {
    let upper = VimText(units: JSCase.uppercase(VimText(char).units))
    guard upper.length == 1, let u = upper.code(at: 0), (0x41...0x5A).contains(u) || (0x30...0x39).contains(u) else { return 0 }
    return Int(u)
  }

  /// The event a real key press carries for a key in vim notation (the vectors' `keySpecOf`): a
  /// named key gets its DOM `key` and key code and its modifiers; `<C-a>` is `key: "a"` with Ctrl.
  convenience init(vimKey token: String) {
    var key = token
    var keyCode = DOMKeyEvent.legacyKeyCode(token)
    var ctrl = false, shift = false, alt = false, meta = false
    if DOMKeyEvent.isNamed(token) {
      var parts = String(token.dropFirst().dropLast()).components(separatedBy: "-")
      var name = parts.popLast() ?? ""
      // `<C-->` splits into ["C", "", ""]: the key itself is "-".
      if name.isEmpty && parts.last == "" {
        parts.removeLast()
        name = "-"
      }
      for modifier in parts {
        switch modifier {
        case "C": ctrl = true
        case "S": shift = true
        case "A": alt = true
        case "M": meta = true
        default: break
        }
      }
      if let named = DOMKeyEvent.namedKeys[name.lowercased()] {
        key = named.key
        keyCode = named.keyCode
      } else {
        key = name
        keyCode = DOMKeyEvent.legacyKeyCode(name)
      }
    }
    self.init(key: key, keyCode: keyCode, ctrlKey: ctrl, altKey: alt, metaKey: meta, shiftKey: shift, token: token)
  }

  func preventDefault() { defaultPrevented = true }

  /// The text a native key press inserts in insert mode or a text field (the vectors'
  /// `insertedText`): a character types itself, `<Space>`/`<S-Space>` a space, `<CR>` a line
  /// break, `<Tab>` a tab; other named keys nothing.
  var insertedText: VimText? {
    guard let token else { return nil }
    if !DOMKeyEvent.isNamed(token) { return VimText(token) }
    switch token {
    case "<Space>", "<S-Space>": return " "
    case "<CR>": return "\n"
    case "<Tab>": return "\t"
    default: return nil
    }
  }

  /// What replace mode overwrites with when vim doesn't handle the key: the event's `key` when it
  /// is one UTF-16 code unit other than a line break (`<C-a>` overwrites with "a").
  var overwriteText: VimText? {
    let text = VimText(key)
    return text.length == 1 && text != "\n" ? text : nil
  }
}
