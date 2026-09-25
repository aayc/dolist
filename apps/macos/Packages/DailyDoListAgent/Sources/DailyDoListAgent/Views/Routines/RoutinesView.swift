import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What the host does for routines: open the New Routine sheet, and open a routine's file.
public struct AgentRoutineActions {
  /// Opens the New Routine sheet with a draft (blank, from a template, or from a finished task).
  public var newRoutine: ((RoutineDraft) -> Void)?
  /// Opens `Routines/<name>.md` in the editor.
  public var edit: ((Routine) -> Void)?

  public init(
    newRoutine: ((RoutineDraft) -> Void)? = nil, edit: ((Routine) -> Void)? = nil
  ) {
    self.newRoutine = newRoutine
    self.edit = edit
  }

  public static var none: AgentRoutineActions { AgentRoutineActions() }
}

/// The Routines tab of the agent panel: every routine with its schedule in words, next run, last
/// run's status, whether it's paused and what's wrong with it. Selecting one shows its runs.
struct RoutinesView: View {
  let store: AgentStore
  let actions: AgentRoutineActions
  let shortcuts: AgentPanelShortcuts
  let onSelect: (String) -> Void
  @Environment(\.agentReferenceDate) private var referenceDate

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      let now = referenceDate ?? context.date
      VStack(spacing: 0) {
        if !store.routines.isEmpty { toolbar }
        content(now: now)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task { if !store.routinesLoaded { await store.loadRoutines() } }
  }

  private var toolbar: some View {
    HStack(spacing: 8) {
      Text(countLabel)
        .font(.caption.weight(.semibold))
        .foregroundStyle(AgentTheme.mutedText)
      Spacer(minLength: 8)
      if let newRoutine = actions.newRoutine {
        NewRoutineButton(shortcuts: shortcuts) { newRoutine(RoutineDraft()) }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 6)
  }

  private var countLabel: String {
    let count = store.routines.count
    return count == 1 ? "1 ROUTINE" : "\(count) ROUTINES"
  }

  @ViewBuilder private func content(now: Date) -> some View {
    let routines = store.routines
    if !store.routinesLoaded, let error = store.routinesLoadError {
      ContentUnavailableView {
        Label("Couldn't load routines", systemImage: "exclamationmark.triangle")
      } description: {
        Text(verbatim: error)
      } actions: {
        Button("Try Again") { Task { await store.loadRoutines() } }
          .buttonStyle(
            ChromeButtonStyle(horizontalPadding: 10, verticalPadding: 4, showsBorder: true))
      }
    } else if !store.routinesLoaded {
      ProgressView().controlSize(.small)
    } else if routines.isEmpty {
      ContentUnavailableView {
        Label("No routines yet", systemImage: "clock.arrow.circlepath")
      } description: {
        Text(
          "A routine is a job the agent does on a schedule, like a morning briefing. Each run reports back here."
        )
      } actions: {
        if let newRoutine = actions.newRoutine {
          Button("New Routine…") { newRoutine(RoutineDraft()) }
            .buttonStyle(AccentButtonStyle())
            .tooltip(
              "New routine", keys: shortcuts.newRoutine.keys, command: shortcuts.newRoutine.id,
              accessibility: .keysOnly)
        }
      }
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(routines) { routine in
            RoutineRow(
              routine: routine, isBusy: store.busyRoutineIds.contains(routine.id), now: now
            ) { onSelect(routine.id) }
            .contextMenu { menu(for: routine) }
          }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 10)
      }
    }
  }

  @ViewBuilder private func menu(for routine: Routine) -> some View {
    Button("Run Now") {
      onSelect(routine.id)
      Task { await store.runRoutine(routine.id) }
    }
    Button(routine.paused ? "Resume" : "Pause") {
      Task { await store.setRoutinePaused(routine.id, !routine.paused) }
    }
    if let edit = actions.edit {
      Button("Edit File") { edit(routine) }
    }
  }
}

/// "+ New Routine" in the Routines toolbar.
struct NewRoutineButton: View {
  let shortcuts: AgentPanelShortcuts
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("New Routine", systemImage: "plus")
        .font(.system(size: 12, weight: .medium))
    }
    .buttonStyle(ChromeButtonStyle(horizontalPadding: 8, verticalPadding: 3, showsBorder: true))
    .tooltip(
      "New routine", keys: shortcuts.newRoutine.keys, command: shortcuts.newRoutine.id,
      accessibility: .keysOnly)
  }
}

/// One routine in the list.
struct RoutineRow: View {
  let routine: Routine
  let isBusy: Bool
  let now: Date
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: symbol)
          .foregroundStyle(symbolColor)
          .frame(width: 16)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: routine.name)
              .font(.system(size: 13, weight: .medium))
              .lineLimit(1)
              .truncationMode(.tail)
              .tooltip(ifTruncated: routine.name, font: .systemFont(ofSize: 13, weight: .medium))
            Spacer(minLength: 4)
            if let run = routine.lastRun {
              Text(verbatim: AgentFormat.relativeTime(Date(epochMillis: run.startedAt), now: now))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(AgentTheme.mutedText)
            }
          }
          Text(verbatim: RoutineFormat.schedule(routine))
            .font(.callout)
            .foregroundStyle(AgentTheme.mutedText)
            .lineLimit(1)
          HStack(spacing: 6) {
            RoutineStateChip(routine: routine)
            if let subtitle = RoutineFormat.subtitle(routine, now: now) {
              Text(verbatim: subtitle)
                .font(.caption)
                .foregroundStyle(AgentTheme.faint)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            if isBusy { ProgressView().controlSize(.mini) }
          }
          if let error = routine.error {
            Text(verbatim: error)
              .font(.caption)
              .foregroundStyle(AgentTheme.warning)
              .lineLimit(2)
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .accessibilityElement(children: .combine)
    .accessibilityHint("Shows its runs")
  }

  private var symbol: String {
    if routine.error != nil { return "exclamationmark.triangle.fill" }
    if routine.paused { return "pause.circle" }
    if routine.isRunning, let status = routine.lastRun?.status { return status.systemImage }
    return "clock.arrow.circlepath"
  }

  private var symbolColor: Color {
    if routine.error != nil { return AgentTheme.warning }
    if routine.paused { return AgentTheme.faint }
    if routine.isRunning, let status = routine.lastRun?.status { return status.tone.color }
    return AgentTheme.accent
  }
}

/// A routine's state in one chip: its problem, paused, or how its last run went.
struct RoutineStateChip: View {
  let routine: Routine

  var body: some View {
    if routine.error != nil {
      Chip(text: "Problem", tone: .warning, systemImage: "exclamationmark.triangle.fill")
    } else if routine.paused {
      Chip(text: "Paused", systemImage: "pause.fill")
    } else if let run = routine.lastRun {
      StatusChip(
        status: run.status, label: RoutineFormat.lastRunStatus(routine),
        pulses: run.status.isRunning)
    } else {
      Chip(text: "Never run")
    }
  }
}
