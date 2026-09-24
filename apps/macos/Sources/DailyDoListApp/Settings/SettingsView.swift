import SwiftUI

/// A tab of the Settings window.
enum SettingsPane: String, CaseIterable, Identifiable {
  case general, appearance, daily, agent, connectors, about
  var id: String { rawValue }
}

/// The native Settings window (⌘,).
struct SettingsView: View {
  let model: AppModel

  var body: some View {
    @Bindable var ui = model.ui
    TabView(selection: $ui.settingsPane) {
      GeneralSettingsPane(model: model, preferences: model.preferences)
        .tabItem { Label("General", systemImage: "gearshape") }
        .tag(SettingsPane.general)
      AppearanceSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Appearance", systemImage: "paintbrush") }
        .tag(SettingsPane.appearance)
      DailyNotesSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Daily Notes", systemImage: "calendar") }
        .tag(SettingsPane.daily)
      AgentSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Agent", systemImage: "sparkles") }
        .tag(SettingsPane.agent)
      ConnectorsSettingsPane(model: model)
        .tabItem { Label("Connectors", systemImage: "puzzlepiece.extension") }
        .tag(SettingsPane.connectors)
      AboutSettingsPane(model: model)
        .tabItem { Label("About", systemImage: "info.circle") }
        .tag(SettingsPane.about)
    }
    .frame(width: 600)
    .frame(minHeight: 420)
    .tint(Theme.accent)
  }
}

/// Shown in daemon-backed panes before a connection exists.
struct NotConnectedNote: View {
  var body: some View {
    SettingsNote(
      text:
        "Not connected to the daemon. These settings are stored by the daemon and can be changed once it's connected."
    )
  }
}
