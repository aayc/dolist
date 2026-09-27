import DailyDoListMobileAgent
import DailyDoListMobileEditor
import DailyDoListMobileKit
import DailyDoListMobileSettings
import DailyDoListModels
import SwiftUI

struct PhoneWorkspaceView: View {
  let model: PhoneAppModel
  @Bindable var workspace: PhoneWorkspace
  let chooseHost: () -> Void
  @State private var capture = false

  var body: some View {
    TabView(selection: $workspace.selectedTab) {
      NavigationStack {
        Group {
          if let session = workspace.active {
            PhoneNoteView(session: session)
          } else {
            ContentUnavailableView(
              "Open a note", systemImage: "doc.text",
              description: Text("Choose a downloaded note or open Today."))
          }
        }
        .navigationTitle(workspace.active?.note.path.components(separatedBy: "/").last ?? "Today")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button("Today", systemImage: "calendar") { Task { await workspace.openToday() } }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button("Capture a task", systemImage: "plus.circle") { capture = true }
          }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
          PhoneNoteNavigation(workspace: workspace)
          if !model.connection.actionsEnabled {
            ConnectionStatusView(connection: model.connection).padding(10).frame(
              maxWidth: .infinity, alignment: .leading
            )
            .background(.bar)
          }
        }
      }.tabItem { Label("Today", systemImage: "calendar") }.tag(0)
      NavigationStack {
        PhoneExplorerView(workspace: workspace)
      }.tabItem { Label("Notes", systemImage: "folder") }.tag(1)
      Group {
        if let store = workspace.agent {
          MobileInboxView(
            store: store,
            actionsEnabled: workspace.online && model.connection.actionsEnabled,
            hostName: workspace.profile.name, drafts: workspace.composerDrafts.callbacks,
            openNote: { path, line in Task { await workspace.open(path, line: line) } })
        } else {
          ContentUnavailableView(
            "Inbox unavailable", systemImage: "tray",
            description: Text("Connect to the host to download your conversations."))
        }
      }.tabItem { Label("Inbox", systemImage: "tray") }.tag(2)
      NavigationStack {
        if let store = workspace.agent {
          MobileRoutinesView(
            store: store,
            actionsEnabled: workspace.online && model.connection.actionsEnabled,
            hostName: workspace.profile.name, drafts: workspace.composerDrafts.callbacks,
            openNote: { path, line in Task { await workspace.open(path, line: line) } })
        } else {
          ContentUnavailableView(
            "Routines unavailable", systemImage: "repeat",
            description: Text("Connect to the host to download your routines."))
        }
      }.tabItem { Label("Routines", systemImage: "repeat") }.tag(3)
      NavigationStack {
        List {
          Section("Connection") {
            LabeledContent("Host", value: workspace.profile.name)
            LabeledContent("Workspace", value: workspace.profile.vaultName ?? "Connected vault")
            ConnectionStatusView(connection: model.connection)
            Button("Choose a connection", action: chooseHost)
            NavigationLink("Host and shared settings") { hostSettings }
          }
          Section("On this iPhone") {
            NavigationLink("Captures") { CaptureHistoryView(workspace: workspace) }
            NavigationLink("Recovery and pending actions") {
              PhoneRecoveryView(workspace: workspace)
            }
            Button("Sync saved changes", systemImage: "arrow.triangle.2.circlepath") {
              Task { await workspace.synchronize() }
            }.disabled(!workspace.online || workspace.refreshing)
            Text("Notes save on this iPhone before syncing to the selected host.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }.navigationTitle("Settings")
      }.tabItem { Label("Settings", systemImage: "gearshape") }.tag(4)
    }
    .alert(
      "Couldn't finish",
      isPresented: Binding(
        get: { workspace.error != nil }, set: { if !$0 { workspace.error = nil } })
    ) {
      Button("OK") { workspace.error = nil }
    } message: {
      Text(workspace.error ?? "")
    }
    .preferredColorScheme(
      workspace.settings?.theme == .dark
        ? .dark : workspace.settings?.theme == .light ? .light : nil
    )
    .sheet(isPresented: $capture) { CaptureTaskView(workspace: workspace) }
  }
  private var hostSettings: some View {
    let client = model.connection.client
    let profileID = workspace.profile.id
    return MobileSettingsView(
      client: client, settings: workspace.settings,
      hostName: workspace.profile.name,
      actionsEnabled: model.connection.actionsEnabled && workspace.online,
      hostID: workspace.profile.workspaceID,
      isCurrentSession: {
        model.connection.actionsEnabled && model.connection.selected?.id == profileID
          && model.connection.client?.clientId == client?.clientId
      }, onSettingsSaved: { value in Task { await workspace.adoptSettings(value) } })
  }

}

private struct PhoneNoteView: View {
  let session: NoteSession
  @State private var source = false
  @State private var readOnly = false

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(session.saveLabel).font(.caption).foregroundStyle(
          session.error == nil ? Color.secondary : Color.red)
        Spacer(minLength: 4)
        Menu("Editing options", systemImage: "ellipsis.circle") {
          Toggle("Source mode", isOn: $source)
          Toggle("Read only", isOn: $readOnly)
          Button("Undo", systemImage: "arrow.uturn.backward") { session.editor.run(.undo) }
          Button("Redo", systemImage: "arrow.uturn.forward") { session.editor.run(.redo) }
        }
      }.padding(.horizontal).padding(.vertical, 6).background(.bar)
      MobileMarkdownView(controller: session.editor).id(session.note.path)
        .accessibilityIdentifier("workspace.editor")
    }
    .onChange(of: source) { _, value in session.setSourceMode(value) }
    .onChange(of: readOnly) { _, value in
      var configuration = session.editor.configuration
      configuration.isEditable = !value
      session.editor.updateConfiguration(configuration)
    }
    .onChange(of: session.note.path) { _, _ in
      source = !session.editor.configuration.livePreview
      readOnly = !session.editor.configuration.isEditable
    }
    .task {
      source = !session.editor.configuration.livePreview
      readOnly = !session.editor.configuration.isEditable
    }
  }
}
