import AppKit

/// A catalog command as an AppKit menu item (the editor's context menu): its title, the keys from
/// ``CommandID/shortcut``, and running the command when chosen.
@MainActor
final class CommandMenuItem: NSMenuItem {
  private let run: @MainActor () -> Void

  init(_ id: CommandID, title: String, run: @escaping @MainActor () -> Void) {
    self.run = run
    super.init(title: title, action: #selector(perform(_:)), keyEquivalent: "")
    target = self
    identifier = NSUserInterfaceItemIdentifier(id.rawValue)
    if let shortcut = id.shortcut, case .character(let character) = shortcut.key {
      keyEquivalent = String(character).lowercased()
      var mask: NSEvent.ModifierFlags = []
      if shortcut.modifiers.contains(.command) { mask.insert(.command) }
      if shortcut.modifiers.contains(.shift) { mask.insert(.shift) }
      if shortcut.modifiers.contains(.option) { mask.insert(.option) }
      if shortcut.modifiers.contains(.control) { mask.insert(.control) }
      keyEquivalentModifierMask = mask
    }
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  @objc private func perform(_ sender: Any?) { run() }
}
