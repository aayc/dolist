// `vimKeyFromEvent` is ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn
// Haverbeke and others).

/// A key press as the host sees it, platform-neutral (what a DOM `KeyboardEvent` carries).
public struct VimKeyInput: Hashable, Sendable {
  /// The key's value: the character it types ("a", "A", "é", "{", " ") or a named key
  /// ("Enter", "Escape", "Backspace", "Delete", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft",
  /// "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "F1"…). Modifier-only keys
  /// ("Shift", "Control", "Alt", "Meta", "CapsLock") produce no vim key.
  ///
  /// On macOS: the named key for the key code, else `charactersIgnoringModifiers` when Control or
  /// Command is held (so Control-D is "d"), else `characters` (so Option-8 is "•" and
  /// Shift-A is "A").
  public var key: String
  public var control: Bool
  /// Option on macOS.
  public var alt: Bool
  /// Command on macOS.
  public var meta: Bool
  public var shift: Bool
  /// The physical key's letter on a US layout ("KeyQ" → "Q"), used by vim to map non-Latin
  /// keyboard layouts to Latin commands. Optional.
  public var code: String?

  public init(
    key: String, control: Bool = false, alt: Bool = false, meta: Bool = false, shift: Bool = false,
    code: String? = nil
  ) {
    self.key = key
    self.control = control
    self.alt = alt
    self.meta = meta
    self.shift = shift
    self.code = code
  }
}

public enum VimKeyNotation {
  /// The vim key name for a key press ("a", "A", "<C-d>", "<Esc>", "<CR>", "<S-Tab>", "<A-x>"),
  /// or nil for modifier-only keys. With `isMac`, a lone Option modifier is dropped for keys that
  /// type a character (Option-8 types "{" on a Swiss layout). This is vim.js's `vimKeyFromEvent`.
  public static func vimKey(for input: VimKeyInput, isMac: Bool = true) -> String? {
    vimKeyFromEvent(
      DOMKeyEvent(
        key: input.key, ctrlKey: input.control, altKey: input.alt, metaKey: input.meta,
        shiftKey: input.shift, code: input.code), isMac: isMac, langmap: nil)
  }

  /// vim.js's `specialKey`, in its declaration order (which `vimToCmKeyMap` depends on).
  static let specialKeyOrder: [(String, String)] = [
    ("Return", "CR"), ("Backspace", "BS"), ("Delete", "Del"), ("Escape", "Esc"), ("Insert", "Ins"),
    ("ArrowLeft", "Left"), ("ArrowRight", "Right"), ("ArrowUp", "Up"), ("ArrowDown", "Down"),
    ("Enter", "CR"), (" ", "Space"),
  ]

  static let specialKey: [String: String] = Dictionary(
    specialKeyOrder, uniquingKeysWith: { a, _ in a })

  static let ignoredKeys: Set<String> = [
    "Shift", "Alt", "Command", "Control", "CapsLock", "AltGraph", "Dead", "Unidentified",
  ]

  /// `vimToCmKeyMap`: lower-cased vim and DOM names → DOM key names.
  static let vimToCmKeyMap: [String: String] = {
    var map: [String: String] = [:]
    for x in ["Left", "Right", "Up", "Down", "End", "Home"] + specialKeyOrder.map(\.0) {
      map[(specialKey[x] ?? "").lowercased()] = x
      map[x.lowercased()] = x
    }
    return map
  }()

  /// Context the key translation needs from the vim state (langmap and literal input).
  struct LangmapContext {
    var expectLiteralNext: Bool
    var keymap: [VimText: VimText]
    var remapCtrl: Bool?
    var usedKeys: [VimText: Int]
  }

  /// vim.js's `vimKeyFromEvent(e, vim)`.
  static func vimKeyFromEvent(_ e: DOMKeyEvent, isMac: Bool, langmap: LangmapContext?) -> String? {
    var key = e.key
    if ignoredKeys.contains(key) { return nil }
    if key.utf16.count > 1, key.hasPrefix("n") {
      key = key.replacingOccurrences(of: "Numpad", with: "")
    }
    key = specialKey[key] ?? key
    var name = ""
    if e.ctrlKey { name += "C-" }
    if e.altKey { name += "A-" }
    if e.metaKey { name += "M-" }
    if isMac && name == "A-" && key.utf16.count == 1 { name = "" }
    if (!name.isEmpty || key.utf16.count > 1) && e.shiftKey { name += "S-" }
    if let context = langmap, !context.expectLiteralNext, key.utf16.count == 1 {
      let k = VimText(key)
      if let mapped = context.keymap[k] {
        if context.remapCtrl != false || name.isEmpty { key = mapped.string }
      } else if k[0] > 128 {
        if (context.usedKeys[k] ?? 0) == 0 {
          var code = String(e.code?.suffix(1) ?? "")
          if !e.shiftKey { code = code.lowercased() }
          if !code.isEmpty {
            key = code
            if name.isEmpty && e.altKey { name = "A-" }
          }
        }
      }
    }
    name += key
    if name.utf16.count > 1 { name = "<" + name + ">" }
    return name
  }

  /// A key in vim notation split into its name and modifiers: "<C-S-x>" → ("x", ctrl, shift),
  /// "<CR>" → ("CR"), "a" → ("a").
  struct Parsed: Equatable {
    var name: String
    var ctrl = false
    var alt = false
    var meta = false
    var shift = false
  }

  static func parse(_ key: String) -> Parsed {
    let units = Array(key.utf16)
    guard units.count > 2, units.first == 0x3C, units.last == 0x3E else { return Parsed(name: key) }
    var inner = String(decoding: units[1..<(units.count - 1)], as: UTF16.self)
    var parsed = Parsed(name: "")
    while inner.utf16.count > 2, Array(inner.utf16)[1] == 0x2D {
      switch inner.first!.uppercased() {
      case "C": parsed.ctrl = true
      case "A": parsed.alt = true
      case "M", "D": parsed.meta = true
      case "S": parsed.shift = true
      default:
        parsed.name = inner
        return parsed
      }
      inner.removeFirst(2)
    }
    parsed.name = inner
    return parsed
  }
}
