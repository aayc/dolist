import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What the host does for the "where the orchestrator runs" control.
public struct AgentPlacementActions {
  /// Opens the Settings pane that sets up what's missing (the always-on machine, or sync).
  public var openSetUp: ((OrchestratorLocation.SetUp) -> Void)?

  public init(openSetUp: ((OrchestratorLocation.SetUp) -> Void)? = nil) {
    self.openSetUp = openSetUp
  }

  public static var none: AgentPlacementActions { AgentPlacementActions() }
}

/// Under the agent panel's header: where the orchestrator runs, one click away. A segmented
/// control (This device | Always-on machine), disabled with the reason while the agent is held on
/// this device (and a way to set up what's missing), the handover as it happens, and "Run It on
/// This Device Instead" when the always-on machine can't be reached. On the always-on machine
/// itself it just says so.
struct OrchestratorLocationBar: View {
  let store: AgentStore
  let location: OrchestratorLocation
  let runHere: AgentPanelShortcuts.Command
  let actions: AgentPlacementActions
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if location.isHost {
        Label("This is the always-on machine", systemImage: "server.rack")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(AgentTheme.mutedText)
      } else {
        ViewThatFits(in: .horizontal) {
          controls(labeled: true)
          controls(labeled: false)
        }
      }
      if let line = location.line {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          LocationLine(line: line)
          if let setUp = location.setUp, let open = actions.openSetUp {
            Button {
              open(setUp)
            } label: {
              Text(location.heldHere == nil ? "Pair…" : "Set Up…")
                .font(.caption.weight(.medium))
                .foregroundStyle(AgentTheme.accent)
            }
            .buttonStyle(ChromeButtonStyle(horizontalPadding: 4, verticalPadding: 1))
            .fixedSize()
            .tooltip(setUp == .sync ? "Set up sync" : "Set up the always-on machine")
          }
        }
        .transition(.opacity)
      }
      if location.offersRunHere {
        Button("Run It on This Device Instead") {
          Task { await store.moveOrchestrator(to: .thisDevice) }
        }
        .font(.system(size: 12, weight: .medium))
        .buttonStyle(
          ChromeButtonStyle(horizontalPadding: 8, verticalPadding: 3, showsBorder: true)
        )
        .tooltip(
          "Run the orchestrator on this device instead", keys: runHere.keys, command: runHere.id)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { AgentHairline() }
    .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: location)
  }

  private func controls(labeled: Bool) -> some View {
    HStack(spacing: 8) {
      if labeled {
        Text("Orchestrator")
          .font(.system(size: 12))
          .foregroundStyle(AgentTheme.mutedText)
          .fixedSize()
      }
      picker
      Spacer(minLength: 0)
    }
  }

  private var picker: some View {
    Picker(
      "Where the orchestrator runs",
      selection: Binding(
        get: { location.selection },
        set: { target in Task { await store.moveOrchestrator(to: target) } })
    ) {
      ForEach([AgentPlacement.thisDevice, .alwaysOnMachine], id: \.self) { placement in
        Text(OrchestratorLocation.title(placement)).tag(placement)
      }
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .controlSize(.small)
    .fixedSize()
    .pointingHandCursor(location.canSwitch)
    .tooltip(
      TooltipContent("Where the orchestrator runs"),
      whenDisabled: location.heldTooltip
        ?? (location.isSwitching ? TooltipContent("Moving the orchestrator…") : nil)
    )
    .disabled(!location.canSwitch)
  }
}

/// Over the agent panel while its work is read-only here: what that means, and where to act.
struct ReadOnlyBanner: View {
  let readOnly: AgentReadOnly

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "eye")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(AgentTheme.info)
      Text(readOnly.banner)
        .font(.caption)
        .foregroundStyle(AgentTheme.text)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AgentTheme.info.opacity(0.10))
    .overlay(alignment: .bottom) { AgentHairline() }
    .accessibilityElement(children: .combine)
  }
}

/// The handover's note, the relay's trouble, or who else runs the agent.
private struct LocationLine: View {
  let line: OrchestratorLocation.Line

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      if line.inProgress {
        ProgressView().controlSize(.mini).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
      } else {
        Circle().fill(line.tone.color).frame(width: 6, height: 6)
      }
      Text(line.text)
        .font(.caption)
        .foregroundStyle(line.tone == .faint ? AgentTheme.mutedText : line.tone.color)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }
}
