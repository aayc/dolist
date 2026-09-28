import DailyDoListMobileAgent
import DailyDoListMobileDrawing
import DailyDoListMobileEditor
import DailyDoListMobileKit
import DailyDoListMobileSettings
import DailyDoListModels
import SwiftUI

struct PhoneWorkspaceView: View {
  let model: PhoneAppModel
  @Bindable var workspace: PhoneWorkspace
  let chooseHost: @MainActor () -> Void
  var isRootCurrent: @MainActor () -> Bool = { true }
  @State private var capture = false
  @State private var commandSettings = false
  @State private var commandDrawing = false
  @State private var commandDrawingName = ""
  @State private var commandDrawingSession: NoteSession?

  var body: some View {
    TabView(selection: $workspace.selectedTab) {
      NavigationStack {
        Group {
          if let drawing = workspace.activeDrawing {
            PhoneDrawingView(session: drawing)
          } else if let session = workspace.active {
            PhoneNoteView(workspace: workspace, session: session)
          } else {
            ContentUnavailableView(
              "Open a note", systemImage: "doc.text",
              description: Text("Choose a downloaded note or open Today."))
          }
        }
        .navigationTitle(workspace.activePath?.components(separatedBy: "/").last ?? "Today")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { PhoneCommandMenu() }
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
            NavigationLink("Forget this connection") {
              PhoneForgetConnectionView(
                workspace: workspace,
                prepare: { try await workspace.prepareRecoveryExport() },
                forget: { scope, proof in try await model.forget(scope, proof: proof) })
            }
          }
          Section("On this iPhone") {
            NavigationLink("Downloads and storage") { PhoneDownloadsView(workspace: workspace) }
            NavigationLink("Privacy and notifications") {
              PhoneIntegrationSettingsView(model: model)
            }
            NavigationLink("Attachments") {
              PhoneAttachmentUploadsView(
                online: workspace.online,
                copyDestination: workspace.active?.note.path,
                load: { try await workspace.attachmentUploads.uploads() },
                checkAgain: { await workspace.synchronize() },
                cancel: { upload in
                  _ = try await workspace.attachmentUploads.cancel(
                    upload.id, expectedRevision: upload.revision)
                  for session in workspace.sessions.values { session.editor.attachmentsDidChange() }
                },
                original: { try await workspace.attachmentUploads.bytes($0) },
                importCopy: { try await workspace.replaceAttachment($0, data: $1) })
            }
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
    .onChange(of: workspace.selectedTab) { _, _ in workspace.scheduleNavigationSave() }
    .environment(
      \.mobileAgentVisibility,
      MobileAgentVisibility(
        thread: { id, visible in
          if visible { model.visibleThreads.insert(id) } else { model.visibleThreads.remove(id) }
        },
        routine: { id, visible in
          if visible { model.visibleRoutines.insert(id) } else { model.visibleRoutines.remove(id) }
        })
    )
    .sheet(item: $workspace.routedThread) { destination in
      NavigationStack {
        if let store = workspace.agent {
          MobileThreadView(
            store: store, threadId: destination.id,
            actionsEnabled: workspace.online && model.connection.actionsEnabled,
            hostName: workspace.profile.name, drafts: workspace.composerDrafts.callbacks,
            openNote: { path, line in
              workspace.routedThread = nil
              Task { await workspace.open(path, line: line) }
            }
          )
          .toolbar {
            ToolbarItem(placement: .topBarLeading) {
              Button("Done") { workspace.routedThread = nil }
            }
          }
        }
      }
    }
    .sheet(isPresented: $capture) { CaptureTaskView(workspace: workspace) }
    .sheet(item: $workspace.routedLink) { destination in
      PhoneNoteLinkPreview(model: workspace.linkPreview(destination)) { target in
        guard workspace.isCurrentLink(destination) else { return }
        workspace.routedLink = nil
        workspace.openEditorLink(target, from: destination.sourcePath)
      }
    }
    .sheet(isPresented: $commandSettings) {
      NavigationStack {
        hostSettings.toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { commandSettings = false } }
        }
      }
    }
    .alert("Insert drawing", isPresented: $commandDrawing) {
      TextField("Drawing name", text: $commandDrawingName)
      Button("Cancel", role: .cancel) { commandDrawingSession = nil }
      Button("Create") {
        guard let session = commandDrawingSession, workspace.active === session else { return }
        let name = commandDrawingName
        commandDrawingName = ""
        commandDrawingSession = nil
        Task { await workspace.insertDrawing(named: name, into: session) }
      }.disabled(commandDrawingName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .phoneCommands(
      workspace: workspace,
      isCurrent: {
        model.workspace === workspace && isRootCurrent() && !capture && !commandSettings
          && !commandDrawing && workspace.routedThread == nil && workspace.routedLink == nil
      },
      chooseConnection: chooseHost, showHostSettings: { commandSettings = true },
      insertDrawing: {
        commandDrawingSession = workspace.active
        commandDrawing = true
      },
      visibleThread: { model.visibleThreads.first })
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
  let workspace: PhoneWorkspace
  let session: NoteSession
  @State private var backlinks = false
  @State private var newDrawing = false
  @State private var drawingName = ""

  var body: some View {
    VStack(spacing: 0) {
      PhoneOrchestratorIndicator(
        activity: workspace.workingActivity, currentPath: workspace.activePath,
        online: workspace.online
      ) { workspace.openAnnotationThread(nil, turn: $0) }
      HStack {
        Text(session.saveLabel).font(.caption).foregroundStyle(
          session.error == nil ? Color.secondary : Color.red)
        Spacer(minLength: 4)
        PhoneAttachmentImportButton { data, filename in
          try await workspace.importAttachment(data, filename: filename, into: session)
        }
        .labelStyle(.iconOnly)
        .disabled(!session.editor.configuration.isEditable || workspace.structuralBusy)
        Menu("Editing options", systemImage: "ellipsis.circle") {
          Toggle(
            "Source mode",
            isOn: Binding(
              get: { !session.editor.configuration.livePreview },
              set: { session.setSourceMode($0) }))
          Toggle(
            "Read only",
            isOn: Binding(
              get: { !session.editor.configuration.isEditable },
              set: { value in
                var configuration = session.editor.configuration
                configuration.isEditable = !value
                session.editor.updateConfiguration(configuration)
              }))
          Button("Backlinks", systemImage: "link") { backlinks = true }
          Button("Insert drawing", systemImage: "pencil.and.scribble") { newDrawing = true }
            .disabled(!session.editor.configuration.isEditable)
          Button("Undo", systemImage: "arrow.uturn.backward") { session.editor.run(.undo) }
          Button("Redo", systemImage: "arrow.uturn.forward") { session.editor.run(.redo) }
        }
      }.padding(.horizontal).padding(.vertical, 6).background(.bar)
      MobileMarkdownView(controller: session.editor).id(session.note.path)
        .accessibilityIdentifier("workspace.editor")
    }
    .alert("Insert drawing", isPresented: $newDrawing) {
      TextField("Drawing name", text: $drawingName)
      Button("Cancel", role: .cancel) {}
      Button("Create") {
        let name = drawingName
        drawingName = ""
        Task { await workspace.insertDrawing(named: name, into: session) }
      }.disabled(drawingName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .sheet(isPresented: $backlinks) {
      NavigationStack {
        MobileBacklinksView(
          notePath: session.note.path,
          identity: "\(workspace.profile.id):\(workspace.generation)",
          source: { try await workspace.backlinks(to: $0) },
          onOpen: { path, line in
            backlinks = false
            Task { await workspace.open(path, line: line) }
          }
        )
        .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { backlinks = false } } }
      }
    }
  }
}
