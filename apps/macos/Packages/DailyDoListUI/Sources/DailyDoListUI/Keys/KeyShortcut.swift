import Foundation

/// A keyboard shortcut as the user reads it: modifiers in Apple's order (⌃⌥⇧⌘), then the key.
/// Tooltips, the palette and settings draw it as ``Keycaps``, one cap per key.
public struct KeyShortcut: Hashable, Sendable {
  public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = Modifiers(rawValue: 1 << 0)
    public static let option = Modifiers(rawValue: 1 << 1)
    public static let shift = Modifiers(rawValue: 1 << 2)
    public static let command = Modifiers(rawValue: 1 << 3)

    /// Apple's order, with each modifier's glyph and spoken name.
    static let ordered: [(modifier: Modifiers, glyph: String, name: String)] = [
      (.control, "⌃", "Control"), (.option, "⌥", "Option"), (.shift, "⇧", "Shift"),
      (.command, "⌘", "Command"),
    ]
  }

  public enum Key: Hashable, Sendable {
    /// A printable key (letters are shown uppercased).
    case character(Character)
    case `return`, escape, tab, delete, forwardDelete, space
    case upArrow, downArrow, leftArrow, rightArrow
    /// F1…F20.
    case function(Int)

    /// The key's cap: `D`, `↩`, `⎋`, `⇥`, `⌫`, `←`…
    public var cap: String {
      switch self {
      case .character(let character): String(character).uppercased()
      case .return: "↩"
      case .escape: "⎋"
      case .tab: "⇥"
      case .delete: "⌫"
      case .forwardDelete: "⌦"
      case .space: "Space"
      case .upArrow: "↑"
      case .downArrow: "↓"
      case .leftArrow: "←"
      case .rightArrow: "→"
      case .function(let number): "F\(number)"
      }
    }

    /// How VoiceOver should say it.
    var spokenName: String {
      switch self {
      case .character(let character): Self.spokenCharacters[character] ?? cap
      case .return: "Return"
      case .escape: "Escape"
      case .tab: "Tab"
      case .delete: "Delete"
      case .forwardDelete: "Forward Delete"
      case .space: "Space"
      case .upArrow: "Up Arrow"
      case .downArrow: "Down Arrow"
      case .leftArrow: "Left Arrow"
      case .rightArrow: "Right Arrow"
      case .function(let number): "F\(number)"
      }
    }

    private static let spokenCharacters: [Character: String] = [
      "[": "Left Bracket", "]": "Right Bracket", "\\": "Backslash", "+": "Plus", "-": "Minus",
      "=": "Equals", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote",
      "`": "Grave Accent",
    ]
  }

  public var key: Key
  public var modifiers: Modifiers

  public init(_ key: Key, _ modifiers: Modifiers = []) {
    self.key = key
    self.modifiers = modifiers
  }

  /// A character key, ⌘ unless told otherwise: `KeyShortcut("n")` is ⌘N. `"\t"` is Tab.
  public init(_ character: Character, _ modifiers: Modifiers = .command) {
    self.init(character == "\t" ? .tab : .character(character), modifiers)
  }

  /// One string per cap, modifiers first in Apple's order: `["⇧", "⌘", "D"]`.
  public var caps: [String] {
    Modifiers.ordered.filter { modifiers.contains($0.modifier) }.map(\.glyph) + [key.cap]
  }

  /// The caps run together, the way macOS menus print a shortcut: `⇧⌘D`.
  public var display: String { caps.joined() }

  /// `Shift-Command-D`, for VoiceOver.
  public var spokenDescription: String {
    (Modifiers.ordered.filter { modifiers.contains($0.modifier) }.map(\.name) + [key.spokenName])
      .joined(separator: "-")
  }
}

extension KeyShortcut {
  /// ↩ (send, run, open).
  public static let returnKey = KeyShortcut(.return)
  /// ⇧↩ (a new line in the composer, open in a new tab).
  public static let shiftReturn = KeyShortcut(.return, .shift)
  /// ⌘↩ (create).
  public static let commandReturn = KeyShortcut(.return, .command)
  /// ⎋ (cancel, close).
  public static let escapeKey = KeyShortcut(.escape)
  /// ↑ and ↓ are two keys; the palette shows them as two caps.
  public static let upArrow = KeyShortcut(.upArrow)
  public static let downArrow = KeyShortcut(.downArrow)
}
