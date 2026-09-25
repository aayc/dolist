import Carbon.HIToolbox
import DailyDoListUI
import Foundation

/// A system-wide keyboard shortcut: one key plus modifiers, written the way macOS menus show it
/// (`⌥⌘D`, `⌃⇧Space`, `F5`). Parsing also accepts words (`opt+cmd+d`, `Option-Command-D`).
public struct GlobalShortcut: Hashable, Sendable {
  public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = Modifiers(rawValue: 1 << 0)
    public static let option = Modifiers(rawValue: 1 << 1)
    public static let shift = Modifiers(rawValue: 1 << 2)
    public static let command = Modifiers(rawValue: 1 << 3)

    /// Apple's display order.
    static let ordered: [(Modifiers, String)] = [
      (.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘"),
    ]
  }

  public struct Key: Hashable, Sendable {
    /// Display form: `D`, `5`, `Space`, `F5`, `←`.
    public let name: String
    /// Carbon virtual key code (`kVK_…`).
    public let keyCode: UInt32

    public var isFunctionKey: Bool { GlobalShortcut.functionKeyCodes.contains(keyCode) }
  }

  public var key: Key
  public var modifiers: Modifiers

  public init(key: Key, modifiers: Modifiers) {
    self.key = key
    self.modifiers = modifiers
  }

  /// ⌃⌥⌘D: open today's note. (⌥⌘D is macOS's own "Turn Dock hiding on/off".)
  public static let openTodaysNote = GlobalShortcut(
    key: Key(name: "D", keyCode: UInt32(kVK_ANSI_D)), modifiers: [.control, .option, .command])

  /// `⌥⌘D`.
  public var displayString: String {
    Modifiers.ordered.filter { modifiers.contains($0.0) }.map(\.1).joined() + key.name
  }

  /// A global shortcut must not steal plain typing: it needs ⌘, ⌥ or ⌃, unless it is a
  /// function key.
  public var isValidGlobalShortcut: Bool {
    key.isFunctionKey || !modifiers.isDisjoint(with: [.command, .option, .control])
  }

  /// Parses `⌥⌘D`, `⌃⇧Space`, `cmd+opt+d`, `Option-Command-D`, `ctrl shift f5`, `⌘-`, … Returns nil
  /// when the key is unknown or missing. (Validity as a global shortcut is `isValidGlobalShortcut`.)
  public init?(parsing text: String) {
    var rest = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
    var modifiers: Modifiers = []
    while true {
      rest = rest.drop { $0 == " " || $0 == "+" }
      if let first = rest.first, let symbol = Self.modifierSymbols[first] {
        modifiers.insert(symbol)
        rest = rest.dropFirst()
        continue
      }
      let lowered = rest.lowercased()
      if let match = Self.modifierWords.first(where: { lowered.hasPrefix($0.word) }),
        let separator = rest.dropFirst(match.word.count).first, " +-".contains(separator)
      {
        modifiers.insert(match.modifier)
        rest = rest.dropFirst(match.word.count + 1)
        continue
      }
      break
    }
    let name = rest.trimmingCharacters(in: .whitespaces)
    guard let key = Self.key(named: name) else { return nil }
    self.init(key: key, modifiers: modifiers)
  }

  /// `RegisterEventHotKey` modifier mask.
  var carbonModifiers: UInt32 {
    var mask = 0
    if modifiers.contains(.command) { mask |= cmdKey }
    if modifiers.contains(.option) { mask |= optionKey }
    if modifiers.contains(.control) { mask |= controlKey }
    if modifiers.contains(.shift) { mask |= shiftKey }
    return UInt32(mask)
  }

  // MARK: - Key table

  private static let modifierSymbols: [Character: Modifiers] = [
    "⌘": .command, "⌥": .option, "⌃": .control, "⇧": .shift,
  ]

  /// `command`/`control` come before `cmd`/`ctrl`… so the longer spelling is consumed whole.
  private static let modifierWords: [(word: String, modifier: Modifiers)] = [
    ("command", .command), ("control", .control), ("option", .option), ("shift", .shift),
    ("ctrl", .control), ("cmd", .command), ("opt", .option), ("alt", .option),
  ]

  static let functionKeyCodes: Set<UInt32> = Set(functionKeys.map(\.code))

  private static let functionKeys: [(name: String, code: UInt32)] = {
    let codes: [Int] = [
      kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
      kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ]
    return codes.enumerated().map { ("F\($0.offset + 1)", UInt32($0.element)) }
  }()

  /// Single characters (display name = the character, letters uppercased).
  private static let characterKeys: [Character: UInt32] = {
    let codes: [Character: Int] = [
      "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E,
      "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J,
      "K": kVK_ANSI_K, "L": kVK_ANSI_L, "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O,
      "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
      "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X, "Y": kVK_ANSI_Y,
      "Z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
      "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
      "9": kVK_ANSI_9, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket,
      "]": kVK_ANSI_RightBracket, ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote,
      ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash,
      "`": kVK_ANSI_Grave,
    ]
    return codes.mapValues { UInt32($0) }
  }()

  /// Named keys: display name, then the spellings accepted when parsing.
  private static let namedKeys: [(display: String, code: UInt32, aliases: [String])] = [
    ("Space", UInt32(kVK_Space), ["space", "spacebar", "␣"]),
    ("↩", UInt32(kVK_Return), ["return", "enter", "↩", "⏎"]),
    ("⇥", UInt32(kVK_Tab), ["tab", "⇥"]),
    ("⎋", UInt32(kVK_Escape), ["esc", "escape", "⎋"]),
    ("⌫", UInt32(kVK_Delete), ["delete", "backspace", "⌫"]),
    ("⌦", UInt32(kVK_ForwardDelete), ["forwarddelete", "fwddelete", "⌦"]),
    ("↖", UInt32(kVK_Home), ["home", "↖"]),
    ("↘", UInt32(kVK_End), ["end", "↘"]),
    ("⇞", UInt32(kVK_PageUp), ["pageup", "pgup", "⇞"]),
    ("⇟", UInt32(kVK_PageDown), ["pagedown", "pgdn", "⇟"]),
    ("←", UInt32(kVK_LeftArrow), ["left", "leftarrow", "←"]),
    ("→", UInt32(kVK_RightArrow), ["right", "rightarrow", "→"]),
    ("↑", UInt32(kVK_UpArrow), ["up", "uparrow", "↑"]),
    ("↓", UInt32(kVK_DownArrow), ["down", "downarrow", "↓"]),
  ]

  static func key(named name: String) -> Key? {
    guard !name.isEmpty else { return nil }
    if name.count == 1, let character = name.uppercased().first,
      let code = characterKeys[character]
    {
      return Key(name: String(character), keyCode: code)
    }
    let lowered = name.lowercased().replacingOccurrences(of: " ", with: "")
    if let function = functionKeys.first(where: { $0.name.lowercased() == lowered }) {
      return Key(name: function.name, keyCode: function.code)
    }
    if let named = namedKeys.first(where: { $0.aliases.contains(lowered) }) {
      return Key(name: named.display, keyCode: named.code)
    }
    return nil
  }
}

extension GlobalShortcut: CustomStringConvertible {
  public var description: String { displayString }
}

extension GlobalShortcut {
  /// The shortcut as keycaps.
  var keyShortcut: KeyShortcut {
    var caps: KeyShortcut.Modifiers = []
    if modifiers.contains(.control) { caps.insert(.control) }
    if modifiers.contains(.option) { caps.insert(.option) }
    if modifiers.contains(.shift) { caps.insert(.shift) }
    if modifiers.contains(.command) { caps.insert(.command) }
    return KeyShortcut(Self.capKey(key), caps)
  }

  private static func capKey(_ key: Key) -> KeyShortcut.Key {
    if key.isFunctionKey { return .function(Int(key.name.dropFirst()) ?? 0) }
    switch key.keyCode {
    case UInt32(kVK_Space): return .space
    case UInt32(kVK_Return): return .return
    case UInt32(kVK_Tab): return .tab
    case UInt32(kVK_Escape): return .escape
    case UInt32(kVK_Delete): return .delete
    case UInt32(kVK_ForwardDelete): return .forwardDelete
    case UInt32(kVK_LeftArrow): return .leftArrow
    case UInt32(kVK_RightArrow): return .rightArrow
    case UInt32(kVK_UpArrow): return .upArrow
    case UInt32(kVK_DownArrow): return .downArrow
    default: return .character(key.name.first ?? "?")
    }
  }
}

/// Stored as its display string (`"⌥⌘D"`).
extension GlobalShortcut: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let text = try container.decode(String.self)
    guard let shortcut = GlobalShortcut(parsing: text) else {
      throw DecodingError.dataCorruptedError(
        in: container, debugDescription: "Not a keyboard shortcut: \(text)")
    }
    self = shortcut
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(displayString)
  }
}
