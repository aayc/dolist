import SwiftUI

/// The native Settings window (⌘,).
struct SettingsView: View {
  let model: AppModel

  enum Pane: String, CaseIterable, Identifiable {
    case general, appearance, daily, agent, connectors, about
    var id: String { rawValue }
  }

  @State private var pane: Pane = .general

  var body: some View {
    TabView(selection: $pane) {
      GeneralSettingsPane(model: model, preferences: model.preferences)
        .tabItem { Label("General", systemImage: "gearshape") }
        .tag(Pane.general)
      AppearanceSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Appearance", systemImage: "paintbrush") }
        .tag(Pane.appearance)
      DailyNotesSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Daily Notes", systemImage: "calendar") }
        .tag(Pane.daily)
      AgentSettingsPane(model: model, settings: model.settings)
        .tabItem { Label("Agent", systemImage: "sparkles") }
        .tag(Pane.agent)
      ConnectorsSettingsPane(model: model)
        .tabItem { Label("Connectors", systemImage: "puzzlepiece.extension") }
        .tag(Pane.connectors)
      AboutSettingsPane(model: model)
        .tabItem { Label("About", systemImage: "info.circle") }
        .tag(Pane.about)
    }
    .frame(width: 600)
    .frame(minHeight: 420)
    .tint(Theme.accent)
  }
}

/// Shown in daemon-backed panes before a connection exists.
struct NotConnectedNote: View {
  var body: some View {
    SettingsNote(text: "Not connected to the daemon. These settings are stored by the daemon and can be changed once it's connected.")
  }
}
