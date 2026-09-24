import Carbon.HIToolbox
import Foundation

/// Why a global shortcut couldn't be registered.
public enum GlobalShortcutError: Error, Equatable, Sendable {
  /// The text isn't a shortcut (`GlobalShortcut(parsing:)` failed).
  case unrecognized(String)
  /// Plain keys (or ⇧ alone) would steal typing; ⌘, ⌥ or ⌃ is required.
  case needsModifier(String)
  /// Another app already registered these keys.
  case alreadyInUse(String)
  case registrationFailed(String, status: Int32)
}

extension GlobalShortcutError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unrecognized(let text): "“\(text)” isn't a keyboard shortcut. Use something like ⌃⌥⌘D."
    case .needsModifier(let shortcut):
      "\(shortcut) would interfere with typing. Include ⌘, ⌥ or ⌃ (or use a function key)."
    case .alreadyInUse(let shortcut): "\(shortcut) is already used by another app."
    case .registrationFailed(let shortcut, let status):
      "macOS refused to register \(shortcut) (error \(status))."
    }
  }
}

/// Signature ("DDLH") of our `EventHotKeyID`s, to ignore other components' hotkeys.
private let hotKeySignature: OSType = 0x4444_4C48

/// Global hotkeys through Carbon's `RegisterEventHotKey`: no Accessibility permission needed; the
/// keys are reserved system-wide while registered, and presses arrive on the main thread.
@MainActor
final class GlobalHotKeyCenter {
  static let shared = GlobalHotKeyCenter()

  private var eventHandler: EventHandlerRef?
  private var registrations: [UInt32: (ref: EventHotKeyRef, action: @MainActor () -> Void)] = [:]
  private var nextID: UInt32 = 1

  /// Registers `shortcut`; returns an id for `unregister(_:)`.
  func register(
    _ shortcut: GlobalShortcut, action: @escaping @MainActor () -> Void
  ) throws(GlobalShortcutError) -> UInt32 {
    try installEventHandler(for: shortcut)
    let id = nextID
    nextID += 1
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(
      shortcut.key.keyCode, shortcut.carbonModifiers,
      EventHotKeyID(signature: hotKeySignature, id: id), GetApplicationEventTarget(), 0, &ref)
    guard status == noErr, let ref else {
      if status == eventHotKeyExistsErr { throw .alreadyInUse(shortcut.displayString) }
      throw .registrationFailed(shortcut.displayString, status: status)
    }
    registrations[id] = (ref, action)
    return id
  }

  /// Replaces the action of a registration (same keys, new handler).
  func updateAction(_ id: UInt32, action: @escaping @MainActor () -> Void) {
    guard let registration = registrations[id] else { return }
    registrations[id] = (registration.ref, action)
  }

  func unregister(_ id: UInt32) {
    guard let registration = registrations.removeValue(forKey: id) else { return }
    UnregisterEventHotKey(registration.ref)
  }

  fileprivate func handlePress(id: UInt32) {
    registrations[id]?.action()
  }

  private func installEventHandler(for shortcut: GlobalShortcut) throws(GlobalShortcutError) {
    guard eventHandler == nil else { return }
    var pressed = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let status = InstallEventHandler(
      GetApplicationEventTarget(), hotKeyPressed, 1, &pressed, nil, &eventHandler)
    guard status == noErr else {
      throw .registrationFailed(shortcut.displayString, status: status)
    }
  }
}

/// Carbon event callback (a C function: no captures).
private func hotKeyPressed(
  _ next: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
  guard let event else { return OSStatus(eventNotHandledErr) }
  var hotKeyID = EventHotKeyID()
  let status = GetEventParameter(
    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
    MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
  guard status == noErr, hotKeyID.signature == hotKeySignature else {
    return OSStatus(eventNotHandledErr)
  }
  let id = hotKeyID.id
  if Thread.isMainThread {
    MainActor.assumeIsolated { GlobalHotKeyCenter.shared.handlePress(id: id) }
  } else {
    Task { @MainActor in GlobalHotKeyCenter.shared.handlePress(id: id) }
  }
  return noErr
}
