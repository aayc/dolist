import DailyDoListAgent
import SwiftUI

/// The app's scenes, exposed so the executable stays a one-liner: the single main window, the
/// Settings window and the menu bar extra.
public struct DailyDoListScenes: Scene {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model: AppModel = .shared

  public init() {}

  public var body: some Scene {
    Window("Daily Do List", id: MainWindowID.value) {
      MainWindowView(model: model)
    }
    .defaultSize(width: 1180, height: 780)
    .windowToolbarStyle(.unifiedCompact(showsTitle: false))
    .commands { AppMenuCommands(model: model) }

    Settings {
      SettingsView(model: model)
    }

    MenuBarExtra {
      MenuBarContent(model: model)
    } label: {
      MenuBarLabel(model: model)
    }
    .menuBarExtraStyle(.window)
  }
}

/// Scene id of the single main window.
enum MainWindowID {
  static let value = "main"
}

/// Menu bar icon: a checkbox, with the number of pending approvals when there are any.
struct MenuBarLabel: View {
  let model: AppModel

  var body: some View {
    let pending = model.agent?.pendingApprovalCount ?? 0
    if pending > 0 {
      Label("\(pending)", systemImage: "checkmark.square.badge.exclamationmark")
        .labelStyle(.titleAndIcon)
    } else {
      Image(systemName: model.agent?.status?.enabled == false ? "square.dashed" : "checkmark.square")
    }
  }
}

/// Menu bar window: the agent's status and approvals, or a connection note before boot.
struct MenuBarContent: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Group {
      if let agent = model.agent {
        AgentMenuBarContent(
          store: agent,
          openTodaysNote: { model.openTodaysNote() },
          openMainWindow: { showWindow() },
          openThread: { model.openThread($0) })
      } else {
        VStack(alignment: .leading, spacing: 10) {
          Text("Daily Do List").font(.headline)
          Text(statusText).font(.callout).foregroundStyle(.secondary)
          Divider()
          Button("Open Daily Do List") { showWindow() }
          Button("Quit") { NSApp.terminate(nil) }
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
      }
    }
    .onAppear {
      WindowHandles.shared.openMainWindow = { openWindow(id: MainWindowID.value) }
    }
  }

  private var statusText: String {
    switch model.phase {
    case .failed(let failure): failure.title
    case .booting(let message): message
    default: "Connecting…"
    }
  }

  private func showWindow() {
    NSApp.activate()
    model.showMainWindow()
  }
}
