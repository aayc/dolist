import AppIntents
import DailyDoListMobileIntegration
import DailyDoListMobileKit
import SwiftUI

@main
struct DailyDoListApp: App {
  @State private var model = PhoneAppModel()
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--editor-spike") {
          EditorSpikeView()
        } else if ProcessInfo.processInfo.arguments.contains("--drawing-spike") {
          DrawingSpikeView()
        } else {
          PhoneRootView(model: model)
        }
      #else
        PhoneRootView(model: model)
      #endif
    }
  }
}

struct ApplicationIntents: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] { [DoListIntentsPackage.self] }
}

// Xcode extracts framework actions through includedPackages, but shortcut phrases must be
// declared in the application target to appear in its Metadata.appintents catalog.
struct ApplicationShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddToDoListIntent(), phrases: ["Add a task to \(.applicationName)"],
      shortTitle: "Add a task", systemImageName: "plus.circle")
    AppShortcut(
      intent: OpenDoListTodayIntent(), phrases: ["Open today in \(.applicationName)"],
      shortTitle: "Open Today", systemImageName: "calendar")
    AppShortcut(
      intent: ShowDoListApprovalsIntent(), phrases: ["Show approvals in \(.applicationName)"],
      shortTitle: "Show approvals", systemImageName: "tray")
    AppShortcut(
      intent: CountDoListApprovalsIntent(), phrases: ["Count approvals in \(.applicationName)"],
      shortTitle: "Count approvals", systemImageName: "number")
  }
}
