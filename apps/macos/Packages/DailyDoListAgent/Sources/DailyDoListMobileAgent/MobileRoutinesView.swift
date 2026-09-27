#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  /// Routine definitions and their run histories. Editing uses the ordinary document repository.
  public struct MobileRoutinesView: View {
    let store: AgentStore
    let actionsEnabled: Bool
    let hostName: String?
    let drafts: MobileAgentDrafts?
    let openNote: (String, Int?) -> Void
    @State private var creating = false

    public init(
      store: AgentStore, actionsEnabled: Bool = false, hostName: String? = nil,
      drafts: MobileAgentDrafts? = nil, openNote: @escaping (String, Int?) -> Void = { _, _ in }
    ) {
      self.store = store
      self.actionsEnabled = actionsEnabled
      self.hostName = hostName
      self.drafts = drafts
      self.openNote = openNote
    }

    public var body: some View {
      List {
        if let error = store.routinesLoadError {
          MobileAgentNotice(
            title: "Couldn't refresh routines", message: error, systemImage: "wifi.exclamationmark")
          Button("Try again") { Task { await store.loadRoutines() } }
        }
        if store.routines.isEmpty, store.routinesLoaded {
          ContentUnavailableView(
            "No routines yet", systemImage: "repeat",
            description: Text("Create a standing task and choose when the host should run it."))
        }
        ForEach(store.routines) { routine in
          NavigationLink {
            MobileRoutineDetailView(
              store: store, routineId: routine.id, actionsEnabled: actionsEnabled,
              hostName: hostName, drafts: drafts, openNote: openNote)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(routine.name).font(.headline)
              Text(RoutineFormat.schedule(routine)).font(.subheadline)
              Text(RoutineFormat.nextRun(routine)).font(.caption).foregroundStyle(.secondary)
              if let error = routine.error { Text(error).font(.caption).foregroundStyle(.red) }
            }.padding(.vertical, 4)
          }
        }
      }
      .navigationTitle("Routines")
      .task { await store.loadRoutines() }
      .refreshable { await store.loadRoutines() }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New routine", systemImage: "plus") { creating = true }
            .disabled(!actionsEnabled || store.readOnly != nil)
        }
      }
      .sheet(isPresented: $creating) {
        MobileNewRoutineView(store: store, actionsEnabled: actionsEnabled) { _ in creating = false }
      }
      .modifier(MobileAgentError(store: store))
    }
  }

  private struct MobileRoutineDetailView: View {
    let store: AgentStore
    let routineId: String
    let actionsEnabled: Bool
    let hostName: String?
    let drafts: MobileAgentDrafts?
    let openNote: (String, Int?) -> Void
    @Environment(\.mobileAgentVisibility) private var visibility
    @State private var openedRun: String?

    var body: some View {
      List {
        if let routine = store.routine(routineId) {
          Section {
            Text(RoutineFormat.schedule(routine)).font(.headline)
            Text(RoutineFormat.nextRun(routine)).foregroundStyle(.secondary)
            Text("Schedules use the clock on \(hostName ?? "the connected host").").font(.caption)
            Text(RoutineFormat.notify(routine.notify)).font(.subheadline)
            if let uses = RoutineFormat.uses(routine.uses) { Text(uses).font(.subheadline) }
            LabeledContent("Extra runs left today", value: "\(routine.extraRunsLeft)")
            if let error = routine.error { Text(error).foregroundStyle(.red) }
            if let alert = store.routineAlerts[routineId] {
              MobileAgentNotice(
                title: alert.title, message: alert.message, systemImage: "exclamationmark.triangle")
            }
          }
          Section {
            Button("Run now", systemImage: "play.fill") {
              Task { openedRun = await store.runRoutine(routineId) }
            }.disabled(
              !canAct || routine.isRunning || routine.error != nil || routine.extraRunsLeft == 0
                || !store.isAgentAvailable)
            Button(
              routine.paused ? "Resume schedule" : "Pause schedule",
              systemImage: routine.paused ? "play.circle" : "pause.circle"
            ) {
              Task { await store.setRoutinePaused(routineId, !routine.paused) }
            }.disabled(!canAct)
            Button("Edit routine file", systemImage: "square.and.pencil") {
              openNote(routine.path, nil)
            }
          }
          Section("Instructions") {
            MobileMarkdownView(source: routine.instructions, openNote: openNote)
          }
          Section("Runs") {
            let runs = store.runs(ofRoutine: routineId)
            if runs.isEmpty { Text("No runs yet").foregroundStyle(.secondary) }
            ForEach(runs) { run in
              NavigationLink {
                thread(run.id)
              } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text(RoutineFormat.runTitle(run.createdAt)).font(.headline)
                  MobileStatusLabel(status: run.status)
                  if let preview = run.lastMessagePreview {
                    Text(preview).font(.subheadline).lineLimit(3)
                  }
                  if run.pendingApprovals > 0 {
                    Text(AgentFormat.approvalsWaiting(run.pendingApprovals)).font(.caption)
                      .foregroundStyle(.orange)
                  }
                }
              }
            }
          }
        } else {
          ContentUnavailableView(
            "Routine unavailable", systemImage: "doc.questionmark",
            description: Text("Its file may have moved or been deleted."))
        }
      }
      .onAppear { visibility.routine(routineId, true) }
      .onDisappear { visibility.routine(routineId, false) }
      .navigationTitle(store.routine(routineId)?.name ?? "Routine")
      .navigationBarTitleDisplayMode(.inline)
      .task(id: routineId) { await store.loadRuns(ofRoutine: routineId) }
      .refreshable {
        await store.loadRoutines()
        await store.loadRuns(ofRoutine: routineId)
      }
      .navigationDestination(
        isPresented: Binding(get: { openedRun != nil }, set: { if !$0 { openedRun = nil } })
      ) {
        if let openedRun { thread(openedRun) }
      }
    }

    private var canAct: Bool {
      actionsEnabled && store.readOnly == nil && !store.busyRoutineIds.contains(routineId)
    }

    private func thread(_ id: String) -> some View {
      MobileThreadView(
        store: store, threadId: id, actionsEnabled: actionsEnabled, hostName: hostName,
        drafts: drafts, openNote: openNote)
    }
  }
#endif
