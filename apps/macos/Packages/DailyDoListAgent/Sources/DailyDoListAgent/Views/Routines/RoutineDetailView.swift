import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// One routine's own inbox: what it does and when, Run Now / Pause / Edit, why an action didn't
/// work, and its runs (threads, newest first) that open in the thread view.
struct RoutineDetailView: View {
  let store: AgentStore
  let routineId: String
  let actions: AgentRoutineActions
  let onOpenRun: (String) -> Void
  @Environment(\.agentReferenceDate) private var referenceDate

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      let now = referenceDate ?? context.date
      if let routine = store.routine(routineId) {
        VStack(spacing: 0) {
          RoutineHeader(
            routine: routine, now: now, isBusy: store.busyRoutineIds.contains(routineId),
            readOnlyReason: store.readOnly?.reason, onRun: run, onSetPaused: setPaused,
            onEdit: actions.edit.map { edit in { edit(routine) } })
          callouts(routine)
          Hairline()
          runs(routine, now: now)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      } else if store.routinesLoaded {
        ContentUnavailableView(
          "Routine Not Found", systemImage: "questionmark.folder",
          description: Text("Its file in Routines was renamed or deleted."))
      } else {
        ProgressView().controlSize(.small)
      }
    }
    .task(id: routineId) {
      if !store.routinesLoaded { await store.loadRoutines() }
      await store.loadRuns(ofRoutine: routineId)
    }
  }

  private func run() {
    Task {
      if let threadId = await store.runRoutine(routineId) { onOpenRun(threadId) }
    }
  }

  private func setPaused(_ paused: Bool) {
    Task { await store.setRoutinePaused(routineId, paused) }
  }

  @ViewBuilder private func callouts(_ routine: Routine) -> some View {
    if let alert = store.routineAlerts[routineId] {
      RoutineCallout(
        title: alert.title, message: alert.message,
        systemImage: alert.kind == .agentUnavailable ? "bolt.slash" : "exclamationmark.triangle",
        onDismiss: { store.dismissRoutineAlert(routineId, alertId: alert.id) }
      )
      .padding(.horizontal, 12)
      .padding(.bottom, 10)
      .transition(.opacity)
    }
    if let error = routine.error {
      RoutineCallout(
        title: "This routine can't run", message: error, systemImage: "doc.badge.gearshape",
        actionTitle: actions.edit == nil ? nil : "Edit File",
        onAction: actions.edit.map { edit in { edit(routine) } }
      )
      .padding(.horizontal, 12)
      .padding(.bottom, 10)
    }
  }

  @ViewBuilder private func runs(_ routine: Routine, now: Date) -> some View {
    let runs = store.runs(ofRoutine: routineId)
    if runs.isEmpty {
      ContentUnavailableView {
        Label("No runs yet", systemImage: "tray")
      } description: {
        Text(
          routine.paused
            ? "It's paused. Resume it, or run it now." : "Run it now, or wait for its next run.")
      }
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
          Section {
            // Keyed by the whole summary, like the inbox: rows follow status changes.
            ForEach(runs, id: \.self) { run in
              RoutineRunRow(
                run: run,
                pendingApprovals: max(
                  run.pendingApprovals, store.pendingApprovals(forThread: run.id).count),
                now: now
              ) { onOpenRun(run.id) }
            }
          } header: {
            HStack(spacing: 6) {
              Text("RUNS")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.mutedText)
              Text(verbatim: "\(runs.count)").font(.caption).foregroundStyle(Theme.faintText)
              Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity)
            .background(Theme.background)
            .accessibilityAddTraits(.isHeader)
          }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 10)
      }
    }
  }
}

/// The routine's name, schedule and state, with its actions.
struct RoutineHeader: View {
  let routine: Routine
  let now: Date
  let isBusy: Bool
  /// Run Now can't reach the agent from this device.
  var readOnlyReason: String?
  let onRun: () -> Void
  let onSetPaused: (Bool) -> Void
  let onEdit: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 4) {
          Text(verbatim: routine.name)
            .font(.system(size: 15, weight: .semibold))
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .tooltip(
              ifTruncated: routine.name, font: .systemFont(ofSize: 15, weight: .semibold),
              lineLimit: 2)
          Text(verbatim: RoutineFormat.schedule(routine))
            .font(.callout)
            .foregroundStyle(Theme.mutedText)
        }
        Spacer(minLength: 8)
        HStack(spacing: 0) {
          IconButton(
            routine.paused ? "play.circle" : "pause.circle",
            label: routine.paused ? "Resume routine" : "Pause routine", isEnabled: !isBusy
          ) { onSetPaused(!routine.paused) }
          if let onEdit {
            IconButton("square.and.pencil", label: "Edit routine file", action: onEdit)
          }
        }
      }
      HStack(spacing: 8) {
        RoutineStateChip(routine: routine)
        if let subtitle = RoutineFormat.subtitle(routine, now: now) {
          Text(verbatim: subtitle)
            .font(.caption)
            .foregroundStyle(Theme.mutedText)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        Button(action: onRun) {
          HStack(spacing: 4) {
            if isBusy {
              ProgressView().controlSize(.mini)
            } else {
              Image(systemName: "play.fill").imageScale(.small)
            }
            Text("Run Now")
          }
          .font(.system(size: 12, weight: .medium))
        }
        .buttonStyle(
          ChromeButtonStyle(horizontalPadding: 9, verticalPadding: 3, showsBorder: true)
        )
        .tooltip(
          TooltipContent("Run now", detail: extraRunsDetail),
          whenDisabled: readOnlyReason.map { TooltipContent("Run now", detail: $0) }
            ?? TooltipContent("Working on it…"),
          accessibility: .none
        )
        .disabled(isBusy || readOnlyReason != nil)
      }
      Text(verbatim: details)
        .font(.caption)
        .foregroundStyle(Theme.faintText)
        .lineLimit(2)
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 10)
  }

  private var extraRunsDetail: String {
    switch routine.extraRunsLeft {
    case 0: "No extra runs left today"
    case 1: "1 extra run left today"
    default: "\(routine.extraRunsLeft) extra runs left today"
    }
  }

  private var details: String {
    var parts = [RoutineFormat.notify(routine.notify)]
    if let uses = RoutineFormat.uses(routine.uses) { parts.append(uses) }
    parts.append(routine.path)
    return parts.joined(separator: " · ")
  }
}

/// A warning box in a routine's view: why an action didn't work, or what's wrong with its file.
struct RoutineCallout: View {
  let title: String
  let message: String
  let systemImage: String
  var actionTitle: String?
  var onAction: (() -> Void)?
  var onDismiss: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: systemImage)
        .foregroundStyle(Theme.warning)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        Text(verbatim: title).font(.callout.weight(.semibold))
        Text(verbatim: message)
          .font(.callout)
          .foregroundStyle(Theme.mutedText)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
        if let actionTitle, let onAction {
          Button(actionTitle, action: onAction)
            .buttonStyle(
              ChromeButtonStyle(horizontalPadding: 8, verticalPadding: 3, showsBorder: true)
            )
            .font(.system(size: 12, weight: .medium))
            .padding(.top, 4)
        }
      }
      Spacer(minLength: 0)
      if let onDismiss {
        IconButton("xmark", label: "Dismiss", size: .compact, action: onDismiss)
      }
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 8).fill(Theme.warning.opacity(0.1))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.warning.opacity(0.35))
    )
    .accessibilityElement(children: .contain)
  }
}

/// One run in its routine's inbox: when it ran, how it went, what it said last.
struct RoutineRunRow: View {
  let run: ThreadSummary
  let pendingApprovals: Int
  let now: Date
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: run.status.systemImage)
          .foregroundStyle(run.status.tone.color)
          .frame(width: 16)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: RoutineFormat.runTitle(run.createdAt, now: now))
              .font(.system(size: 13, weight: .medium))
              .lineLimit(1)
            Spacer(minLength: 4)
            Text(verbatim: AgentFormat.relativeTime(Date(epochMillis: run.updatedAt), now: now))
              .font(.caption)
              .monospacedDigit()
              .foregroundStyle(Theme.mutedText)
          }
          if let preview = run.lastMessagePreview.map(AgentFormat.plainPreview), !preview.isEmpty {
            Text(verbatim: preview)
              .font(.callout)
              .foregroundStyle(Theme.mutedText)
              .lineLimit(2)
          }
          HStack(spacing: 6) {
            StatusChip(status: run.status, pulses: run.status.isRunning)
            Spacer(minLength: 0)
            if pendingApprovals > 0 {
              CountBadge(
                count: pendingApprovals, tone: .warning, systemImage: "exclamationmark.shield.fill"
              )
              .tooltip(AgentFormat.approvalsWaiting(pendingApprovals))
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens the run")
  }
}
