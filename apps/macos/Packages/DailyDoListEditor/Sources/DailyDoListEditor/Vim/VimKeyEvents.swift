import AppKit
import DailyDoListVim

/// Key presses (`NSEvent`) as vim sees them (`VimKeyInput`, what a DOM `KeyboardEvent` carries).
enum VimKeyEvents {
  /// The key press for `event`, or nil when it types nothing vim can name (a modifier, a dead key
  /// waiting for the next one, an unknown function key).
  ///
  /// Named keys come from the key code. Otherwise the key is `charactersIgnoringModifiers` with
  /// Control or Command held (Control-D is "d") and `characters` without (Option-8 types "•",
  /// Shift-A "A"). `code` is the US-layout name of the physical key ("KeyQ"), which vim uses to
  /// run Latin commands from non-Latin layouts.
  static func input(for event: NSEvent) -> VimKeyInput? {
    guard event.type == .keyDown else { return nil }
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let control = flags.contains(.control)
    let command = flags.contains(.command)
    let key: String
    if let named = namedKeys[event.keyCode] {
      key = named
    } else {
      guard let characters = control || command ? event.charactersIgnoringModifiers : event.characters,
        !characters.isEmpty, !isFunctionKeyCharacter(characters)
      else { return nil }
      key = characters
    }
    return VimKeyInput(
      key: key, control: control, alt: flags.contains(.option), meta: command, shift: flags.contains(.shift),
      code: codes[event.keyCode])
  }

  /// AppKit's private-use characters for function keys (arrows, F-keys) without a known code.
  private static func isFunctionKeyCharacter(_ characters: String) -> Bool {
    guard let scalar = characters.unicodeScalars.first else { return false }
    return (0xF700...0xF8FF).contains(scalar.value)
  }

  /// DOM `key` names of keys that don't type a character, by macOS virtual key code.
  static let namedKeys: [UInt16: String] = [
    53: "Escape", 36: "Enter", 76: "Enter", 51: "Backspace", 117: "Delete", 48: "Tab",
    123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
    115: "Home", 119: "End", 116: "PageUp", 121: "PageDown", 114: "Insert",
    122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
    103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15", 106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
  ]

  /// DOM `code` names (US layout positions) by macOS virtual key code.
  static let codes: [UInt16: String] = [
    0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG", 6: "KeyZ", 7: "KeyX", 8: "KeyC", 9: "KeyV",
    11: "KeyB", 12: "KeyQ", 13: "KeyW", 14: "KeyE", 15: "KeyR", 16: "KeyY", 17: "KeyT", 31: "KeyO", 32: "KeyU",
    34: "KeyI", 35: "KeyP", 37: "KeyL", 38: "KeyJ", 40: "KeyK", 45: "KeyN", 46: "KeyM",
    18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 23: "Digit5", 22: "Digit6", 26: "Digit7", 28: "Digit8",
    25: "Digit9", 29: "Digit0",
    24: "Equal", 27: "Minus", 30: "BracketRight", 33: "BracketLeft", 39: "Quote", 41: "Semicolon", 42: "Backslash",
    43: "Comma", 44: "Slash", 47: "Period", 50: "Backquote", 49: "Space", 10: "IntlBackslash",
  ]
}
