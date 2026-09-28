import DailyDoListMobileIntegration
import SwiftUI

struct PhoneIntegrationSettingsView: View {
  @Bindable var model: PhoneAppModel
  var storageProtection: PhoneStorageProtectionController? = nil
  var body: some View {
    Form {
      Section {
        if model.notificationPreferences.enabled {
          Toggle("Local notifications", isOn: preference(\.enabled))
        } else {
          Button("Enable notifications") { Task { await model.enableNotifications() } }
        }
        Toggle("Show task and routine previews", isOn: preference(\.showPreviews))
        Toggle("Background refresh", isOn: preference(\.backgroundRefresh))
          .disabled(
            !model.notificationPreferences.enabled
              || storageProtection?.permitsBackgroundRefresh == false
              || model.notificationPreferences.requiresUnlockedStorage)
      } header: {
        Text("On this iPhone")
      } footer: {
        Text(
          "Previews are hidden by default. Alerts arrive when this iPhone receives updates. iOS chooses when background refresh runs; alerts may wait until you reopen the app."
        )
      }
      if let storageProtection {
        PhoneStorageProtectionSection(controller: storageProtection)
      }
      if let error = model.notificationError {
        Section { Text(error).foregroundStyle(.secondary) }
      }
      Section("Siri and Shortcuts") {
        Label("Add a task", systemImage: "plus.circle")
        Label("Open Today", systemImage: "calendar")
        Label("Show or count approvals", systemImage: "tray")
        Text(
          "Find Daily Do List in Shortcuts or ask Siri to add a task to Daily Do List. Unlock your iPhone to use these shortcuts. Offline captures are saved and sent when you reconnect."
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Privacy and notifications")
    .onChange(of: storageProtection?.permitsBackgroundRefresh) { _, permitted in
      guard let permitted else { return }
      var preferences = model.notificationPreferences
      preferences.requiresUnlockedStorage = !permitted
      Task { await model.updateNotificationPreferences(preferences) }
    }
  }
  private func preference(_ keyPath: WritableKeyPath<PhoneNotificationPreferences, Bool>)
    -> Binding<Bool>
  {
    Binding(
      get: { model.notificationPreferences[keyPath: keyPath] },
      set: { enabled in
        var next = model.notificationPreferences
        next[keyPath: keyPath] = enabled
        Task { await model.updateNotificationPreferences(next) }
      })
  }
}
