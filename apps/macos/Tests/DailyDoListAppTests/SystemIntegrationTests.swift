import Carbon.HIToolbox
import Foundation
import Testing

@testable import DailyDoListApp

@Suite("Global shortcut")
struct GlobalShortcutTests {
  @Test(arguments: [
    ("⌥⌘D", "⌥⌘D"),
    ("⌘⌥d", "⌥⌘D"),
    ("opt+cmd+d", "⌥⌘D"),
    ("Option-Command-D", "⌥⌘D"),
    ("command option d", "⌥⌘D"),
    ("alt+cmd+D", "⌥⌘D"),
    ("⌃⇧Space", "⌃⇧Space"),
    ("ctrl shift space", "⌃⇧Space"),
    ("Control+Shift+F5", "⌃⇧F5"),
    ("F12", "F12"),
    ("⌘-", "⌘-"),
    ("cmd+-", "⌘-"),
    ("⌘ ,", "⌘,"),
    ("⌃⌥←", "⌃⌥←"),
    ("ctrl+opt+left", "⌃⌥←"),
    ("⌘return", "⌘↩"),
    ("⌥⌘Esc", "⌥⌘⎋"),
    ("  ⌥⌘D  ", "⌥⌘D"),
  ])
  func parsesAndFormats(_ text: String, _ display: String) throws {
    let shortcut = try #require(GlobalShortcut(parsing: text))
    #expect(shortcut.displayString == display)
    #expect(GlobalShortcut(parsing: display) == shortcut, "the display form parses back")
  }

  @Test(arguments: ["", "⌘", "⌥⌘", "shift", "Hyper+D", "⌘banana", "cmd+", "F21", "⌘DD"])
  func rejectsNonShortcuts(_ text: String) {
    #expect(GlobalShortcut(parsing: text) == nil)
  }

  @Test func globalShortcutsNeedARealModifier() throws {
    #expect(try #require(GlobalShortcut(parsing: "⌥⌘D")).isValidGlobalShortcut)
    #expect(try #require(GlobalShortcut(parsing: "⌃D")).isValidGlobalShortcut)
    #expect(try #require(GlobalShortcut(parsing: "F5")).isValidGlobalShortcut, "function keys may stand alone")
    #expect(try !#require(GlobalShortcut(parsing: "D")).isValidGlobalShortcut)
    #expect(try !#require(GlobalShortcut(parsing: "⇧D")).isValidGlobalShortcut)
  }

  @Test func defaultOpensTodaysNoteWithControlOptionCommandD() {
    let shortcut = GlobalShortcut.openTodaysNote
    #expect(shortcut.displayString == "⌃⌥⌘D")
    #expect(shortcut.key.keyCode == UInt32(kVK_ANSI_D))
    #expect(shortcut.carbonModifiers == UInt32(controlKey | optionKey | cmdKey))
  }

  @Test func carbonCodes() throws {
    let shortcut = try #require(GlobalShortcut(parsing: "⌃⌥⇧⌘Space"))
    #expect(shortcut.key.keyCode == UInt32(kVK_Space))
    #expect(shortcut.carbonModifiers == UInt32(controlKey | optionKey | shiftKey | cmdKey))
    #expect(try #require(GlobalShortcut(parsing: "F5")).key.keyCode == UInt32(kVK_F5))
    #expect(try #require(GlobalShortcut(parsing: "⌘5")).key.keyCode == UInt32(kVK_ANSI_5))
  }

  @Test func codableAsItsDisplayString() throws {
    let data = try JSONEncoder().encode([GlobalShortcut.openTodaysNote])
    #expect(String(decoding: data, as: UTF8.self) == #"["⌃⌥⌘D"]"#)
    #expect(try JSONDecoder().decode([GlobalShortcut].self, from: Data(#"["ctrl+opt+n"]"#.utf8)).first?.displayString == "⌃⌥N")
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode([GlobalShortcut].self, from: Data(#"["nope"]"#.utf8))
    }
  }
}

@Suite("System shortcut conflicts")
struct SystemShortcutConflictTests {
  @Test func defaultShortcutIsFreeOnAStockMac() {
    #expect(SystemShortcutConflicts.conflict(for: .openTodaysNote, symbolicHotKeys: [:]) == nil)
  }

  @Test func optionCommandDClashesWithDockHidingUntilTheUserTurnsItOff() throws {
    let shortcut = try #require(GlobalShortcut(parsing: "⌥⌘D"))
    let warning = try #require(SystemShortcutConflicts.warning(for: shortcut, symbolicHotKeys: [:]))
    #expect(warning.contains("Turn Dock hiding on/off"))
    #expect(warning.contains("Launchpad & Dock"))

    let disabled: [String: Any] = ["52": ["enabled": false]]
    #expect(SystemShortcutConflicts.conflict(for: shortcut, symbolicHotKeys: disabled) == nil)
  }

  @Test func userRemappedShortcutsAreHonored() throws {
    // Dock hiding moved to ⌃⌥⌘D: ⌥⌘D is free, ⌃⌥⌘D (the default) is taken.
    let remapped: [String: Any] = [
      "52": ["enabled": true, "value": ["type": "standard", "parameters": [100, 2, 0x1C0000]]]
    ]
    let optionCommandD = try #require(GlobalShortcut(parsing: "⌥⌘D"))
    #expect(SystemShortcutConflicts.conflict(for: optionCommandD, symbolicHotKeys: remapped) == nil)
    #expect(SystemShortcutConflicts.conflict(for: .openTodaysNote, symbolicHotKeys: remapped)?.id == "52")
  }

  @Test func otherShortcutsAreFree() throws {
    #expect(SystemShortcutConflicts.conflict(for: try #require(GlobalShortcut(parsing: "⌃⌥⌘T")), symbolicHotKeys: [:]) == nil)
    #expect(SystemShortcutConflicts.conflict(for: try #require(GlobalShortcut(parsing: "⌘Space")), symbolicHotKeys: [:])?.id == "64")
  }

  @Test func eventFlagsMapToModifiers() {
    #expect(SystemShortcutConflicts.modifiers(fromEventFlags: 0x180000) == [.option, .command])
    #expect(SystemShortcutConflicts.modifiers(fromEventFlags: 0x840000) == [.control], "the arrow-key flag is ignored")
  }
}

@MainActor
@Suite("System integration")
struct SystemIntegrationTests {
  @Test func launchAtLoginExplainsWhyItIsUnavailable() {
    #expect(LaunchAtLoginService.unavailableReason(isAppBundle: false, bundleIdentifier: nil, isSigned: false)?.contains("build-app.sh") == true)
    #expect(LaunchAtLoginService.unavailableReason(isAppBundle: true, bundleIdentifier: nil, isSigned: true)?.contains("CFBundleIdentifier") == true)
    #expect(LaunchAtLoginService.unavailableReason(isAppBundle: true, bundleIdentifier: "app.dailydolist.mac", isSigned: false)?.contains("code-signed") == true)
    #expect(LaunchAtLoginService.unavailableReason(isAppBundle: true, bundleIdentifier: "app.dailydolist.mac", isSigned: true) == nil)
  }

  @Test func outsideAnAppBundleLaunchAtLoginIsUnavailable() {
    let system = SystemIntegration(bundle: .main, symbolicHotKeys: { [:] })
    guard case .unavailable(let reason) = system.launchAtLoginStatus else {
      Issue.record("the test runner isn't an app bundle, got \(system.launchAtLoginStatus)")
      return
    }
    #expect(reason.contains("packaged app"))
    #expect(throws: LaunchAtLoginError.unavailable(reason)) { try system.setLaunchAtLogin(true) }

    let bridge: any SystemIntegrationBridge = system
    #expect(bridge.launchAtLoginAvailability == .unavailable(reason))
    #expect(!bridge.isLaunchAtLoginEnabled)
    #expect(bridge.defaultGlobalShortcut == "⌃⌥⌘D")
  }

  @Test func bridgeRejectsBadShortcutsBeforeRegistering() {
    let bridge: any SystemIntegrationBridge = SystemIntegration(bundle: .main, symbolicHotKeys: { [:] })
    #expect(throws: GlobalShortcutError.unrecognized("nonsense")) {
      try bridge.setGlobalHotkey("nonsense") {}
    }
    #expect(throws: GlobalShortcutError.needsModifier("D")) {
      try bridge.setGlobalHotkey("d") {}
    }
    #expect(bridge.globalHotkeyAvailability == .available)
  }
}
