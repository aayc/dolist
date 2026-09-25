import Foundation

/// Key combos (`cmd+k`, `shift+tab`, `return`, `cmd-shift-4`) → keyboard events. A port of
/// `packages/agent/src/execution/local/computer-keys.ts`: the same key names, aliases and ANSI
/// keycodes, and the same parsing (`KeyComboTests` checks the tables against that file).
public struct KeyCombo: Equatable, Sendable {
  public enum Modifier: String, CaseIterable, Sendable {
    case cmd, shift, alt, ctrl, fn

    /// The left-hand key's virtual keycode.
    public var keyCode: UInt16 {
      switch self {
      case .cmd: 55
      case .shift: 56
      case .alt: 58
      case .ctrl: 59
      case .fn: 63
      }
    }

    /// The `CGEventFlags` mask.
    public var flag: UInt64 {
      switch self {
      case .cmd: 0x10_0000
      case .shift: 0x2_0000
      case .alt: 0x8_0000
      case .ctrl: 0x4_0000
      case .fn: 0x80_0000
      }
    }
  }

  public var modifiers: [Modifier]
  /// The normalized name of the one non-modifier key.
  public var key: String
  public var code: UInt16
  /// The combined flags of the modifiers.
  public var flags: UInt64

  static let modifierAliases: [String: Modifier] = [
    "cmd": .cmd, "command": .cmd, "meta": .cmd, "super": .cmd, "win": .cmd, "shift": .shift,
    "alt": .alt, "option": .alt, "opt": .alt, "ctrl": .ctrl, "control": .ctrl, "fn": .fn,
  ]

  /// Letters in keycode order 0–17 (`?` is 10, an ISO-only key).
  static let letters = "asdfhgzxcv?bqweryt"

  static let keyCodes: [String: UInt16] = {
    var codes: [String: UInt16] = [
      "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
      "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47,
      "`": 50, "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
      "escape": 53, "esc": 53, "forwarddelete": 117, "del": 117, "home": 115, "end": 119,
      "pageup": 116, "pagedown": 121, "left": 123, "arrowleft": 123, "right": 124,
      "arrowright": 124, "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126, "f1": 122,
      "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
      "f10": 109, "f11": 103, "f12": 111, "minus": 27, "equal": 24, "plus": 24,
    ]
    for (index, letter) in letters.enumerated() where letter != "?" {
      codes[String(letter)] = UInt16(index)
    }
    return codes
  }()

  /// Parses `cmd+shift+4`, `Enter`, `ctrl+alt+delete`, `cmd-c`, `f5`…
  public static func parse(_ combo: String) throws(KeyComboError) -> KeyCombo {
    let parts = split(combo)
    guard !parts.isEmpty, !parts.contains("") else {
      throw KeyComboError("Invalid key combo: \"\(combo)\"")
    }
    var modifiers: [Modifier] = []
    var key: String?
    for (index, part) in parts.enumerated() {
      let modifier = modifierAliases[part]
      if let modifier, index < parts.count - 1 {
        if !modifiers.contains(modifier) { modifiers.append(modifier) }
        continue
      }
      if key != nil || modifier != nil {
        throw KeyComboError(
          "Invalid key combo \"\(combo)\": use modifiers (cmd, ctrl, alt, shift, fn) plus exactly "
            + "one key.")
      }
      key = part == "+" ? "plus" : part
    }
    guard let key else { throw KeyComboError("Invalid key combo: \"\(combo)\"") }
    guard let code = keyCodes[key] else {
      throw KeyComboError(
        "Unknown key \"\(key)\" in \"\(combo)\". Use letters, digits, punctuation, return, tab, "
          + "space, escape, delete, arrows, home/end, pageup/pagedown or f1–f12.")
    }
    if key == "plus" && !modifiers.contains(.shift) { modifiers.append(.shift) }
    let flags = modifiers.reduce(UInt64(0)) { $0 | $1.flag }
    return KeyCombo(modifiers: modifiers, key: key, code: code, flags: flags)
  }

  /// Modifier downs, the key down and up with all flags, modifier ups in reverse: what a physical
  /// keyboard sends.
  public var events: [KeyEventStep] {
    var steps: [KeyEventStep] = []
    var flags: UInt64 = 0
    for modifier in modifiers {
      flags |= modifier.flag
      steps.append(KeyEventStep(code: modifier.keyCode, down: true, flags: flags))
    }
    steps.append(KeyEventStep(code: code, down: true, flags: self.flags))
    steps.append(KeyEventStep(code: code, down: false, flags: self.flags))
    for modifier in modifiers.reversed() {
      flags &= ~modifier.flag
      steps.append(KeyEventStep(code: modifier.keyCode, down: false, flags: flags))
    }
    return steps
  }

  /// `cmd+k` → ["cmd", "k"]; `cmd++` → ["cmd", "+"]; `cmd-shift-4` (macOS notation) →
  /// ["cmd", "shift", "4"], though a lone `-` is the minus key; `cmd k` → ["cmd", "k"].
  static func split(_ combo: String) -> [String] {
    let trimmed = combo.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if trimmed == "+" { return ["+"] }
    if trimmed.contains("+") {
      if trimmed.hasSuffix("++") {
        return pieces(String(trimmed.dropLast(2)), by: "+") + ["+"]
      }
      return pieces(trimmed, by: "+").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
    let macNotation = ["cmd", "command", "ctrl", "control", "alt", "option", "opt", "shift", "fn"]
      .contains { trimmed.hasPrefix("\($0)-") && trimmed.count > $0.count + 1 }
    if macNotation {
      if trimmed.hasSuffix("--") {
        return pieces(String(trimmed.dropLast(2)), by: "-") + ["-"]
      }
      return pieces(trimmed, by: "-")
    }
    guard !trimmed.isEmpty else { return [""] }
    return trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
  }

  private static func pieces(_ string: String, by separator: Character) -> [String] {
    string.split(separator: separator, omittingEmptySubsequences: false).map(String.init)
  }
}

public struct KeyEventStep: Equatable, Sendable {
  public var code: UInt16
  public var down: Bool
  public var flags: UInt64

  public init(code: UInt16, down: Bool, flags: UInt64) {
    self.code = code
    self.down = down
    self.flags = flags
  }
}

public struct KeyComboError: Error, Equatable, Sendable {
  public var message: String

  init(_ message: String) {
    self.message = message
  }
}
