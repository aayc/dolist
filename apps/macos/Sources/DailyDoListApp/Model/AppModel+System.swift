import AppKit
import DailyDoListAgent
import Foundation
import Observation

/// Window plumbing the model needs from the SwiftUI layer.
@MainActor
final class WindowHandles {
  static let shared = WindowHandles()
  /// The main window once it exists.
  weak var mainWindow: NSWindow?
  /// SwiftUI's `openWindow(id: "main")`, registered by a view.
  var openMainWindow: (@MainActor () -> Void)?
  let fullScreen = FullScreenObserver()
}

extension AppModel {
  var windows: WindowHandles { WindowHandles.shared }

  /// Brings the main window forward, reopening it if it was closed.
  func showMainWindow() {
    if let window = windows.mainWindow, window.isVisible || window.isMiniaturized {
      if window.isMiniaturized { window.deminiaturize(nil) }
      window.makeKeyAndOrderFront(nil)
    } else {
      windows.openMainWindow?()
    }
  }

  /// App-wide observers: flush on resign, the global hotkey.
  func installSystemServices() {
    let center = NotificationCenter.default
    let flush: @Sendable (Notification) -> Void = { [weak self] _ in
      Task { @MainActor in await self?.flushAll() }
    }
    windowObservers.append(
      center.addObserver(forName: NSApplication.willResignActiveNotification, object: nil, queue: .main, using: flush))
    windowObservers.append(
      center.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main, using: flush))
    windowObservers.append(
      center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.systemIntegration.refresh() }
      })
    // The menu's ⌘+ only matches ⇧⌘=; accept plain ⌘= too, like most Mac apps.
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
        event.charactersIgnoringModifiers == "="
      else { return event }
      MainActor.assumeIsolated {
        guard let self, self.phase == .ready else { return }
        CommandCatalog.adjustFontSize(model: self, by: 1)
      }
      return nil
    }
    applyGlobalHotkeyPreference()
  }

  /// Registers (or removes) the "open today's note" hotkey from preferences; returns an error
  /// message when registration failed.
  @discardableResult
  func applyGlobalHotkeyPreference() -> String? {
    let shortcut = preferences.globalHotkeyEnabled
      ? (preferences.globalHotkey ?? systemIntegration.defaultGlobalShortcut) : nil
    do {
      try systemIntegration.setGlobalHotkey(shortcut) { [weak self] in self?.openTodaysNote() }
      return nil
    } catch {
      return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  /// Launch at login from Settings; returns an error message on failure.
  @discardableResult
  func setLaunchAtLogin(_ enabled: Bool) -> String? {
    do {
      try systemIntegration.setLaunchAtLogin(enabled)
      preferences.launchAtLogin = systemIntegration.isLaunchAtLoginEnabled
      return nil
    } catch {
      preferences.launchAtLogin = systemIntegration.isLaunchAtLoginEnabled
      return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  /// Approval notifications and the Dock badge for a new agent store.
  func startAgentServices(_ agent: AgentStore) {
    let notifier = ApprovalNotifier(store: agent) { [weak self] threadId in
      self?.openThread(threadId)
    }
    notifier.isThreadOnScreen = { [weak self] threadId in
      guard let self else { return false }
      return self.ui.inspectorPresented && self.ui.selectedThreadId == threadId
        && NSApplication.shared.isActive
    }
    notifier.start()
    self.notifier = notifier
    let badge = DockBadge(store: agent)
    badge.start()
    dockBadge = badge
  }

  /// Mirrors agent command errors as window toasts while the agent panel (which shows its own
  /// banner) is hidden.
  func observeAgentErrors(_ agent: AgentStore) {
    withObservationTracking {
      _ = agent.lastError
    } onChange: { [weak self, weak agent] in
      Task { @MainActor in
        guard let self, let agent, self.agent === agent else { return }
        if let alert = agent.lastError, !self.ui.inspectorPresented {
          self.toasts.show(.error, alert.title, body: alert.message)
        }
        self.observeAgentErrors(agent)
      }
    }
  }
}
