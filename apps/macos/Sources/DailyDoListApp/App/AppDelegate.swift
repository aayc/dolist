import AppKit
import DailyDoListDaemon
import Foundation

/// Lifecycle hooks SwiftUI doesn't offer: boot at launch, flush before quitting, the Dock menu, and
/// reopening the window from the Dock.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  /// Longest we delay quitting to flush unsaved notes and stop the daemon.
  static let terminationTimeout: TimeInterval = 4

  private var model: AppModel { .shared }
  private var pendingReply: TerminationReply?

  func applicationDidFinishLaunching(_ notification: Notification) {
    BootTrace.mark("app: did finish launching")
    model.start()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard pendingReply == nil else { return .terminateLater }
    let reply = TerminationReply(application: sender)
    pendingReply = reply
    // A run-loop timer (not a main-queue task) so quitting can't hang even if the main queue is
    // blocked while AppKit waits for the reply.
    let timer = Timer(timeInterval: Self.terminationTimeout, repeats: false) { _ in
      MainActor.assumeIsolated {
        AppModel.shared.supervisor.terminateForAppExit()
        reply.send()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.add(timer, forMode: .modalPanel)
    reply.timer = timer
    let model = self.model
    Task { @MainActor in
      await model.prepareForTermination()
      reply.send()
    }
    return .terminateLater
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    if !flag { model.showMainWindow() }
    return true
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    let today = NSMenuItem(
      title: "Open Today's Note", action: #selector(openTodaysNote(_:)), keyEquivalent: "")
    today.target = self
    menu.addItem(today)
    return menu
  }

  @objc private func openTodaysNote(_ sender: Any?) {
    model.openTodaysNote()
  }
}

/// Answers `applicationShouldTerminate` exactly once (flush finished or timed out).
@MainActor
private final class TerminationReply {
  private let application: NSApplication
  private var replied = false
  var timer: Timer?

  init(application: NSApplication) {
    self.application = application
  }

  func send() {
    guard !replied else { return }
    replied = true
    timer?.invalidate()
    application.reply(toApplicationShouldTerminate: true)
  }
}
