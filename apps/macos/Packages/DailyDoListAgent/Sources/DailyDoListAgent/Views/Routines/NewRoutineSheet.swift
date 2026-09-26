import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// "New Routine…": starter templates, then the name, the schedule in the user's words (the daemon
/// reads it and says what it couldn't), what to do, and when to notify. Creating it writes
/// `Routines/<name>.md`.
public struct NewRoutineSheet: View {
  let store: AgentStore
  let onDone: (Routine?) -> Void
  /// Started from a finished task ("Repeat this"): no templates, the schedule is the user's call.
  let isRepeat: Bool
  @State private var draft: RoutineDraft
  @State private var error: RoutineFormError?
  @State private var saving = false
  @FocusState private var focus: Field?

  enum Field: Hashable { case name, schedule, instructions }

  /// - Parameters:
  ///   - draft: what the fields start with.
  ///   - onDone: the created routine, or nil when cancelled.
  public init(
    store: AgentStore, draft: RoutineDraft = RoutineDraft(), onDone: @escaping (Routine?) -> Void
  ) {
    self.store = store
    self.onDone = onDone
    self.isRepeat = draft.repeatsThreadId != nil
    self._draft = State(initialValue: draft)
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text(isRepeat ? "Repeat This Task" : "New Routine")
          .font(.title3.weight(.semibold))
        Text(
          "The agent does this on a schedule, and each run reports back in the routine's own inbox. It's saved as a note in Routines, so you can edit it later."
        )
        .font(.callout)
        .foregroundStyle(Theme.mutedText)
        .fixedSize(horizontal: false, vertical: true)
      }
      if !isRepeat, !store.routineTemplates.isEmpty { templates }
      field("Name", error: error?.field == .name ? error?.message : nil) {
        TextField("Morning briefing", text: $draft.name)
          .textFieldStyle(.roundedBorder)
          .focused($focus, equals: .name)
      }
      field(
        "When", error: error?.field == .schedule ? error?.message : nil,
        hint: isRepeat && draft.schedule.isEmpty
          ? "Choose when it runs, in your words."
          : "In your words, on this Mac's clock: every weekday at 7:30, every 2 hours, every month on the 1st at 9:00."
      ) {
        TextField("every weekday at 7:30", text: $draft.schedule)
          .textFieldStyle(.roundedBorder)
          .focused($focus, equals: .schedule)
      }
      field("What to do", error: error?.field == .instructions ? error?.message : nil) {
        TextEditor(text: $draft.instructions)
          .font(.body)
          .scrollContentBackground(.hidden)
          .padding(4)
          .frame(minHeight: 96, maxHeight: 180)
          .background(RoundedRectangle(cornerRadius: 6).fill(Theme.secondaryBackground))
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.separator))
          .focused($focus, equals: .instructions)
      }
      field("Notify me", error: nil, hint: RoutineFormat.uses(draft.uses)) {
        Picker("Notify me", selection: $draft.notify) {
          ForEach(RoutineFormat.notifyChoices, id: \.0) { choice in
            Text(choice.1).tag(choice.0)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
      }
      if let error, error.field == .other {
        Label(error.message, systemImage: "exclamationmark.triangle")
          .font(.callout)
          .foregroundStyle(Theme.warning)
      }
      HStack(spacing: 8) {
        Spacer()
        Button("Cancel") { onDone(nil) }
          .buttonStyle(
            ChromeButtonStyle(horizontalPadding: 12, verticalPadding: 5, showsBorder: true)
          )
          .keyboardShortcut(.cancelAction)
        Button(isRepeat ? "Create Routine" : "Create") { create() }
          .buttonStyle(AccentButtonStyle())
          .keyboardShortcut(.defaultAction)
          .disabled(!draft.isComplete || saving)
          .tooltip(
            "Create routine",
            whenDisabled: saving ? "Creating…" : "Fill in the name, when, and what to do")
      }
    }
    .padding(20)
    .frame(width: 500)
    .foregroundStyle(Theme.text)
    .tint(Theme.accent)
    .onAppear {
      focus = draft.name.isEmpty ? .name : draft.schedule.isEmpty ? .schedule : .name
    }
    .onChange(of: draft.name) { _, _ in clear(.name) }
    .onChange(of: draft.schedule) { _, _ in clear(.schedule) }
    .onChange(of: draft.instructions) { _, _ in clear(.instructions) }
  }

  private var templates: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Start from")
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.mutedText)
      FlowLayout(spacing: 6) {
        TemplateChip(title: "Blank", detail: nil, isSelected: draft.templateId == nil) {
          draft = RoutineDraft()
          focus = .name
        }
        ForEach(store.routineTemplates) { template in
          TemplateChip(
            title: template.name, detail: template.description,
            isSelected: draft.templateId == template.id
          ) {
            draft = RoutineDraft(template: template)
            error = nil
          }
        }
      }
    }
  }

  private func field<Content: View>(
    _ title: String, error: String?, hint: String? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.mutedText)
      content()
      if let error {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(Theme.warning)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel("\(title): \(error)")
      } else if let hint {
        Text(verbatim: hint)
          .font(.caption)
          .foregroundStyle(Theme.faintText)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func clear(_ field: RoutineFormError.Field) {
    if error?.field == field { error = nil }
  }

  private func create() {
    guard draft.isComplete, !saving else { return }
    saving = true
    error = nil
    let request = draft.request
    Task {
      let result = await store.createRoutine(request)
      saving = false
      switch result {
      case .success(let routine):
        onDone(routine)
      case .failure(let failure):
        error = failure
        switch failure.field {
        case .name: focus = .name
        case .schedule: focus = .schedule
        case .instructions: focus = .instructions
        case .other: break
        }
      }
    }
  }
}

/// A starter template in the sheet (its description is the tooltip).
private struct TemplateChip: View {
  let title: String
  let detail: String?
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(verbatim: title)
        .font(.system(size: 12, weight: isSelected ? .medium : .regular))
        .foregroundStyle(isSelected ? Theme.text : Theme.mutedText)
    }
    .buttonStyle(
      ChromeButtonStyle(
        horizontalPadding: 9, verticalPadding: 3, isSelected: isSelected, showsBorder: !isSelected)
    )
    .tooltip(detail.map { TooltipContent($0) })
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
  }
}
