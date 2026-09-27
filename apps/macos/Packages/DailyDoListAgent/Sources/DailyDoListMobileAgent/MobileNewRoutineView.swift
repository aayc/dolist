#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  public struct MobileNewRoutineView: View {
    let store: AgentStore
    let actionsEnabled: Bool
    let onDone: (Routine?) -> Void
    @State private var draft: RoutineDraft
    @State private var error: RoutineFormError?
    @State private var saving = false
    private let uses: [(RoutineUse, String)] = [
      (.web, "Web"), (.browser, "Browser"), (.computer, "Host apps"),
      (.shell, "Shell"), (.files, "Files"), (.connectors, "Connectors"),
    ]

    public init(
      store: AgentStore, initial: RoutineDraft = RoutineDraft(), actionsEnabled: Bool,
      onDone: @escaping (Routine?) -> Void
    ) {
      self.store = store
      self.actionsEnabled = actionsEnabled
      self.onDone = onDone
      _draft = State(initialValue: initial)
    }

    public var body: some View {
      NavigationStack {
        Form {
          if draft.repeatsThreadId == nil, !store.routineTemplates.isEmpty {
            Section("Start from a template") {
              Menu(
                draft.templateId.flatMap { id in store.routineTemplates.first { $0.id == id }?.name
                } ?? "Blank routine"
              ) {
                Button("Blank routine") {
                  draft = RoutineDraft()
                  error = nil
                }
                ForEach(store.routineTemplates) { template in
                  Button(template.name) {
                    draft = RoutineDraft(template: template)
                    error = nil
                  }
                }
              }
            }
          }
          Section("Name") {
            TextField("Morning briefing", text: $draft.name).accessibilityIdentifier("routine.name")
            fieldError(.name)
          }
          Section {
            TextField("Every weekday at 7:30", text: $draft.schedule)
              .accessibilityIdentifier("routine.schedule")
            fieldError(.schedule)
          } header: {
            Text("Schedule")
          } footer: {
            Text(
              "Use the connected host's time, such as every weekday at 7:30 or every 2 hours. Travel with your phone does not change this schedule."
            )
          }
          Section("What to do") {
            TextField("Instructions for each run", text: $draft.instructions, axis: .vertical)
              .lineLimit(5...12).accessibilityIdentifier("routine.instructions")
            fieldError(.instructions)
          }
          Section("Notifications") {
            Picker("Notify me", selection: $draft.notify) {
              ForEach(RoutineFormat.notifyChoices, id: \.0) { Text($0.1).tag($0.0) }
            }
          }
          Section("Tools the routine may use") {
            ForEach(uses, id: \.0) { use, label in
              Toggle(
                label,
                isOn: Binding(
                  get: { draft.uses.contains(use) },
                  set: { selected in
                    if selected {
                      if !draft.uses.contains(use) { draft.uses.append(use) }
                    } else {
                      draft.uses.removeAll { $0 == use }
                    }
                  }))
            }
            Text("The host's safety policy still applies to every action.").font(.caption)
              .foregroundStyle(.secondary)
          }
          if let error, error.field == .other { Text(error.message).foregroundStyle(.red) }
          if !actionsEnabled || store.readOnly != nil {
            Text(store.readOnly?.reason ?? "Reconnect to create this routine.").foregroundStyle(
              .secondary)
          }
        }
        .navigationTitle(draft.repeatsThreadId == nil ? "New routine" : "Repeat this task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { onDone(nil) }.disabled(saving)
          }
          ToolbarItem(placement: .confirmationAction) {
            if saving {
              ProgressView()
            } else {
              Button("Create", action: create).disabled(
                !draft.isComplete || !actionsEnabled || store.readOnly != nil)
            }
          }
        }
        .interactiveDismissDisabled(saving)
        .task { if !store.routinesLoaded { await store.loadRoutines() } }
      }
    }

    @ViewBuilder private func fieldError(_ field: RoutineFormError.Field) -> some View {
      if let error, error.field == field {
        Text(error.message).font(.caption).foregroundStyle(.red)
      }
    }

    private func create() {
      guard !saving, draft.isComplete, actionsEnabled, store.readOnly == nil else { return }
      saving = true
      error = nil
      Task {
        let result = await store.createRoutine(draft.request)
        saving = false
        switch result {
        case .success(let routine): onDone(routine)
        case .failure(let problem): error = problem
        }
      }
    }
  }
#endif
