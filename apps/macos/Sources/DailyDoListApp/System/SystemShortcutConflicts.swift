import Carbon.HIToolbox
import Foundation

/// macOS's own keyboard shortcuts (System Settings → Keyboard → Keyboard Shortcuts) win over a
/// registered global hotkey, so a clash means ours silently never fires. This checks the common
/// defaults (⌥⌘D is "Turn Dock hiding on/off" out of the box), honoring the user's changes.
enum SystemShortcutConflicts {
  struct SystemShortcut {
    /// Key in `AppleSymbolicHotKeys` of the `com.apple.symbolichotkeys` preferences.
    let id: String
    let name: String
    let settingsPane: String
    let keyCode: UInt32
    let modifiers: GlobalShortcut.Modifiers
  }

  /// Well-known system shortcuts, with their factory settings (used until the user edits them).
  static let knownDefaults: [SystemShortcut] = [
    .init(id: "52", name: "Turn Dock hiding on/off", settingsPane: "Launchpad & Dock",
          keyCode: UInt32(kVK_ANSI_D), modifiers: [.option, .command]),
    .init(id: "64", name: "Show Spotlight search", settingsPane: "Spotlight",
          keyCode: UInt32(kVK_Space), modifiers: [.command]),
    .init(id: "65", name: "Show Finder search window", settingsPane: "Spotlight",
          keyCode: UInt32(kVK_Space), modifiers: [.option, .command]),
    .init(id: "60", name: "Select the previous input source", settingsPane: "Input Sources",
          keyCode: UInt32(kVK_Space), modifiers: [.control]),
    .init(id: "61", name: "Select next source in Input menu", settingsPane: "Input Sources",
          keyCode: UInt32(kVK_Space), modifiers: [.control, .option]),
    .init(id: "28", name: "Save picture of screen as a file", settingsPane: "Screenshots",
          keyCode: UInt32(kVK_ANSI_3), modifiers: [.shift, .command]),
    .init(id: "29", name: "Copy picture of screen to the clipboard", settingsPane: "Screenshots",
          keyCode: UInt32(kVK_ANSI_3), modifiers: [.control, .shift, .command]),
    .init(id: "30", name: "Save picture of selected area as a file", settingsPane: "Screenshots",
          keyCode: UInt32(kVK_ANSI_4), modifiers: [.shift, .command]),
    .init(id: "31", name: "Copy picture of selected area to the clipboard",
          settingsPane: "Screenshots", keyCode: UInt32(kVK_ANSI_4),
          modifiers: [.control, .shift, .command]),
    .init(id: "184", name: "Screenshot and recording options", settingsPane: "Screenshots",
          keyCode: UInt32(kVK_ANSI_5), modifiers: [.shift, .command]),
    .init(id: "32", name: "Mission Control", settingsPane: "Mission Control",
          keyCode: UInt32(kVK_UpArrow), modifiers: [.control]),
    .init(id: "33", name: "Application windows", settingsPane: "Mission Control",
          keyCode: UInt32(kVK_DownArrow), modifiers: [.control]),
    .init(id: "79", name: "Move left a space", settingsPane: "Mission Control",
          keyCode: UInt32(kVK_LeftArrow), modifiers: [.control]),
    .init(id: "81", name: "Move right a space", settingsPane: "Mission Control",
          keyCode: UInt32(kVK_RightArrow), modifiers: [.control]),
  ]

  /// The enabled system shortcut that uses the same keys as `shortcut`, if any. `symbolicHotKeys`
  /// is the `AppleSymbolicHotKeys` dictionary; entries missing from it keep their defaults.
  static func conflict(
    for shortcut: GlobalShortcut, symbolicHotKeys: [String: Any]
  ) -> SystemShortcut? {
    knownDefaults.first { known in
      let entry = symbolicHotKeys[known.id] as? [String: Any]
      let enabled = (entry?["enabled"] as? NSNumber)?.boolValue ?? true
      guard enabled else { return false }
      var keyCode = known.keyCode
      var modifiers = known.modifiers
      if let value = entry?["value"] as? [String: Any],
        let parameters = value["parameters"] as? [NSNumber], parameters.count == 3
      {
        keyCode = parameters[1].uint32Value
        modifiers = Self.modifiers(fromEventFlags: parameters[2].uintValue)
      }
      return keyCode == shortcut.key.keyCode && modifiers == shortcut.modifiers
    }
  }

  /// A sentence for the user, or nil when there is no clash.
  static func warning(for shortcut: GlobalShortcut, symbolicHotKeys: [String: Any]) -> String? {
    guard let clash = conflict(for: shortcut, symbolicHotKeys: symbolicHotKeys) else { return nil }
    return """
      \(shortcut.displayString) is also the macOS shortcut for “\(clash.name)”, which takes \
      precedence. Turn it off in System Settings → Keyboard → Keyboard Shortcuts → \
      \(clash.settingsPane), or choose another shortcut.
      """
  }

  /// The current user's `AppleSymbolicHotKeys` (empty when unreadable).
  static func currentSymbolicHotKeys() -> [String: Any] {
    CFPreferencesCopyAppValue(
      "AppleSymbolicHotKeys" as CFString, "com.apple.symbolichotkeys" as CFString)
      as? [String: Any] ?? [:]
  }

  /// `NSEvent.ModifierFlags` raw bits as stored in the preferences (other bits ignored).
  static func modifiers(fromEventFlags flags: UInt) -> GlobalShortcut.Modifiers {
    var modifiers: GlobalShortcut.Modifiers = []
    if flags & 0x20000 != 0 { modifiers.insert(.shift) }
    if flags & 0x40000 != 0 { modifiers.insert(.control) }
    if flags & 0x80000 != 0 { modifiers.insert(.option) }
    if flags & 0x100000 != 0 { modifiers.insert(.command) }
    return modifiers
  }
}
