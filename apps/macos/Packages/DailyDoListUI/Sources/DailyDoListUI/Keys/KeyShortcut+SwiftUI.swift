import SwiftUI

extension KeyShortcut {
  /// The shortcut as a SwiftUI key equivalent (menus); nil for keys SwiftUI can't bind (F-keys).
  public var keyboardShortcut: KeyboardShortcut? {
    var flags: EventModifiers = []
    if modifiers.contains(.command) { flags.insert(.command) }
    if modifiers.contains(.shift) { flags.insert(.shift) }
    if modifiers.contains(.option) { flags.insert(.option) }
    if modifiers.contains(.control) { flags.insert(.control) }
    let equivalent: KeyEquivalent
    switch key {
    case .character(let character): equivalent = KeyEquivalent(character)
    case .return: equivalent = .return
    case .escape: equivalent = .escape
    case .tab: equivalent = .tab
    case .delete: equivalent = .delete
    case .forwardDelete: equivalent = .deleteForward
    case .space: equivalent = .space
    case .upArrow: equivalent = .upArrow
    case .downArrow: equivalent = .downArrow
    case .leftArrow: equivalent = .leftArrow
    case .rightArrow: equivalent = .rightArrow
    case .function: return nil
    }
    return KeyboardShortcut(equivalent, modifiers: flags)
  }
}
