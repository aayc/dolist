import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The host's keyboard shortcuts for what the agent panel's buttons do (their tooltips show them).
public struct AgentPanelShortcuts: Hashable, Sendable {
  /// A command of the host: its id (tests match the keys against the host's catalog) and keys.
  public struct Command: Hashable, Sendable {
    public var id: String?
    public var keys: KeyShortcut?

    public init(id: String? = nil, keys: KeyShortcut? = nil) {
      self.id = id
      self.keys = keys
    }
  }

  /// Hides the panel (the header's hide button).
  public var hidePanel: KeyShortcut?
  /// Shows the inbox (a thread's back button).
  public var inbox: KeyShortcut?
  /// Stops the open thread's agent (the chat bar's Stop button).
  public var stop: Command
  /// Shows the routines (the Routines tab).
  public var routines: Command
  /// Opens the New Routine sheet (the Routines tab's New Routine button).
  public var newRoutine: Command
  /// Runs the orchestrator on this device (turning Remote off, "Run It on This Device Instead").
  public var runHere: Command
  /// Runs the orchestrator on the always-on machine (turning Remote on).
  public var runOnMachine: Command

  public init(
    hidePanel: KeyShortcut? = nil, inbox: KeyShortcut? = nil, stop: Command = Command(),
    routines: Command = Command(), newRoutine: Command = Command(), runHere: Command = Command(),
    runOnMachine: Command = Command()
  ) {
    self.hidePanel = hidePanel
    self.inbox = inbox
    self.stop = stop
    self.routines = routines
    self.newRoutine = newRoutine
    self.runHere = runHere
    self.runOnMachine = runOnMachine
  }
}

/// The agent panel's two lists: the task inbox and the routines.
public enum AgentPanelSection: String, Hashable, Sendable {
  case inbox, routines
}

/// Right-hand agent panel: the inbox or the routines (a routine's own inbox of runs when
/// `selectedRoutineId` is set), or one thread when `selectedThreadId` is set. Leaving a thread
/// goes back to where it was opened from. Failed actions show as a dismissible toast at the
/// bottom.
public struct AgentPanel: View {
  let store: AgentStore
  @Binding var selectedThreadId: String?
  @Binding var section: AgentPanelSection
  @Binding var selectedRoutineId: String?
  let routineActions: AgentRoutineActions
  let onShowInNote: ((TaskLocation) -> Void)?
  let onClose: (() -> Void)?
  let headerHeight: CGFloat
  let onHide: (() -> Void)?
  let noteLinks: AgentNoteLinks
  let shortcuts: AgentPanelShortcuts
  let onOpenOrchestratorWindow: (() -> Void)?
  let placementActions: AgentPlacementActions
  /// The host keeps the section: the header shows the Inbox and Routines tabs.
  let showsSections: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// - Parameters:
  ///   - onShowInNote: opens the task's note at its line (the button is hidden when nil).
  ///   - onClose: hides the panel (the thread's Close button returns to the inbox when nil).
  ///   - headerHeight: height of the header row, to line up with the host's other pane headers.
  ///   - onHide: adds a "hide panel" button to the header. A thread then has no Close button of
  ///     its own: the header already goes back to the inbox and hides the panel.
  ///   - noteLinks: how `[[wikilinks]]` in agent text open and preview notes.
  ///   - shortcuts: the host's shortcuts for hiding the panel and showing the inbox.
  ///   - onOpenOrchestratorWindow: opens the orchestrator's chat in a window of its own (a button
  ///     in its header).
  ///   - section: the inbox or the routines (constant: the inbox only, without the tabs).
  ///   - selectedRoutineId: the routine whose runs show in the routines section.
  ///   - routineActions: New Routine (also "Repeat this" on finished tasks) and Edit File.
  ///   - placementActions: what the orchestrator's Remote switch row opens to set up what's
  ///     missing. The row shows when the daemon reports placement.
  public init(
    store: AgentStore, selectedThreadId: Binding<String?>,
    onShowInNote: ((TaskLocation) -> Void)? = nil, onClose: (() -> Void)? = nil,
    headerHeight: CGFloat = 40, onHide: (() -> Void)? = nil, noteLinks: AgentNoteLinks = .none,
    shortcuts: AgentPanelShortcuts = AgentPanelShortcuts(),
    onOpenOrchestratorWindow: (() -> Void)? = nil,
    section: Binding<AgentPanelSection>? = nil,
    selectedRoutineId: Binding<String?> = .constant(nil),
    routineActions: AgentRoutineActions = .none,
    placementActions: AgentPlacementActions = .none
  ) {
    self.onOpenOrchestratorWindow = onOpenOrchestratorWindow
    self.placementActions = placementActions
    self.store = store
    self._selectedThreadId = selectedThreadId
    self._section = section ?? .constant(.inbox)
    self.showsSections = section != nil
    self._selectedRoutineId = selectedRoutineId
    self.routineActions = routineActions
    self.onShowInNote = onShowInNote
    self.onClose = onClose
    self.headerHeight = headerHeight
    self.onHide = onHide
    self.noteLinks = noteLinks
    self.shortcuts = shortcuts
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      if let location = store.orchestratorLocation {
        OrchestratorLocationBar(
          store: store, location: location, shortcuts: shortcuts, actions: placementActions)
      }
      if let readOnly = store.readOnly, let banner = readOnly.banner {
        ReadOnlyBanner(kind: readOnly.kind, text: banner)
          .transition(.opacity)
      }
      Group {
        if let threadId = selectedThreadId, OrchestratorThread.isOrchestrator(threadId) {
          OrchestratorChatView(
            store: store, onOpenTask: { selectedThreadId = $0 },
            onOpenWindow: onOpenOrchestratorWindow,
            onClose: onHide == nil ? onClose ?? { selectedThreadId = nil } : nil)
        } else if let threadId = selectedThreadId {
          ThreadView(
            store: store, threadId: threadId, onShowInNote: onShowInNote,
            onClose: onHide == nil ? onClose ?? { selectedThreadId = nil } : nil,
            stop: shortcuts.stop, onRepeat: routineActions.newRoutine
          )
          .id(threadId)
        } else if section == .routines, let routineId = selectedRoutineId {
          RoutineDetailView(
            store: store, routineId: routineId, actions: routineActions,
            onOpenRun: { selectedThreadId = $0 }
          )
          .id(routineId)
        } else if section == .routines {
          RoutinesView(
            store: store, actions: routineActions, shortcuts: shortcuts,
            onSelect: { selectedRoutineId = $0 })
        } else {
          InboxView(store: store) { selectedThreadId = $0 }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .overlay(alignment: .bottom) {
      if let alert = store.lastError {
        AgentErrorBanner(alert: alert) { store.dismissError(alert.id) }
          .padding(10)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .task(id: alert.id) {
            try? await Task.sleep(for: .seconds(8))
            store.dismissError(alert.id)
          }
      }
    }
    .animation(.snappy(duration: 0.2), value: store.lastError?.id)
    .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: store.readOnly)
    .frame(minWidth: 300)
    .foregroundStyle(Theme.text)
    .tint(Theme.accent)
    .environment(\.agentNoteLinks, noteLinks)
    .environment(\.openURL, LinkPolicy.openURLAction(noteLinks: noteLinks))
  }

  private var header: some View {
    let pending = store.pendingApprovalCount
    return HStack(spacing: 8) {
      if selectedThreadId != nil {
        backButton
      } else if section == .routines, let routineId = selectedRoutineId {
        BackButton(title: "Routines", tooltip: "Back to routines", keys: shortcuts.routines.keys) {
          if selectedRoutineId == routineId { selectedRoutineId = nil }
        }
      } else if showsSections {
        SectionTabs(section: $section, shortcuts: shortcuts)
      } else {
        Label("Inbox", systemImage: "tray")
          .font(.system(size: 13, weight: .semibold))
      }
      if pending > 0 {
        CountBadge(count: pending, tone: .warning, systemImage: "exclamationmark.shield.fill")
          .tooltip(AgentFormat.approvalsWaiting(pending))
          .countTransition()
      }
      Spacer(minLength: 8)
      AgentStatusIndicator(store: store)
      if let onHide {
        IconButton(
          "sidebar.right", label: "Hide agent panel", keys: shortcuts.hidePanel, action: onHide)
      }
    }
    .animation(.countAppearance(reduceMotion: reduceMotion), value: pending > 0)
    .padding(.leading, 12)
    .padding(.trailing, onHide == nil ? 12 : 6)
    .frame(height: headerHeight)
    .overlay(alignment: .bottom) { Hairline() }
  }

  /// A thread's way back: to its routine's runs when it was opened there, else the list it came
  /// from.
  @ViewBuilder private var backButton: some View {
    if section == .routines {
      let routine = selectedRoutineId.flatMap { store.routine($0) }
      BackButton(
        title: routine?.name ?? "Routines",
        tooltip: routine.map { "Back to “\($0.name)”" } ?? "Back to routines", keys: nil
      ) { selectedThreadId = nil }
    } else {
      BackButton(title: "Inbox", tooltip: "Back to inbox", keys: shortcuts.inbox) {
        selectedThreadId = nil
      }
    }
  }
}

/// "‹ Inbox" in the panel header.
private struct BackButton: View {
  let title: String
  let tooltip: String
  let keys: KeyShortcut?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: "chevron.left")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.accent)
        .lineLimit(1)
    }
    .buttonStyle(ChromeButtonStyle(horizontalPadding: 6, verticalPadding: 3))
    .padding(.leading, -6)
    .tooltip(tooltip, keys: keys, accessibility: .keysOnly)
  }
}

/// Inbox | Routines in the panel header.
private struct SectionTabs: View {
  @Binding var section: AgentPanelSection
  let shortcuts: AgentPanelShortcuts

  var body: some View {
    HStack(spacing: 2) {
      tab(.inbox, "Inbox", systemImage: "tray", tooltip: "Agent inbox", keys: shortcuts.inbox)
      tab(
        .routines, "Routines", systemImage: "clock.arrow.circlepath", tooltip: "Routines",
        keys: shortcuts.routines.keys, command: shortcuts.routines.id)
    }
    .padding(.leading, -6)
  }

  private func tab(
    _ value: AgentPanelSection, _ title: String, systemImage: String, tooltip: String,
    keys: KeyShortcut?, command: String? = nil
  ) -> some View {
    let isSelected = section == value
    return Button {
      section = value
    } label: {
      Label(title, systemImage: systemImage)
        .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
        .foregroundStyle(isSelected ? Theme.text : Theme.mutedText)
    }
    .buttonStyle(
      ChromeButtonStyle(horizontalPadding: 6, verticalPadding: 3, isSelected: isSelected)
    )
    .tooltip(tooltip, keys: keys, command: command, accessibility: .keysOnly)
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
  }
}
