import DailyDoListModels
import SwiftUI

/// Agent behavior (stored by the daemon).
struct AgentSettingsPane: View {
  let model: AppModel
  let settings: SettingsStore

  var body: some View {
    let agent = settings.settings.agent
    let status = model.agent?.status
    Form {
      if let problem = status?.problem {
        Section {
          Label(problem, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(Theme.danger)
        }
      }
      Section("Agent") {
        Toggle("Agent enabled", isOn: Binding(
          get: { status?.enabled ?? agent.enabled },
          set: { enabled in
            Task {
              await model.setAgentEnabled(enabled)
              await settings.update(SettingsPatch(agent: .init(enabled: enabled)))
            }
          }))
        SettingsNote(text: "When off, the orchestrator ignores changes to your notes.")
        ClampedNumberField(title: "Settle delay", value: agent.settleMs, range: SettingsRanges.settleMs, step: 250, unit: "ms") {
          update(.init(settleMs: $0))
        }
        SettingsNote(text: "Quiet time after you stop editing a task before the agent looks at it.")
        ClampedNumberField(
          title: "Max concurrent subagents", value: agent.maxConcurrentSubagents,
          range: SettingsRanges.maxConcurrentSubagents
        ) { update(.init(maxConcurrentSubagents: $0)) }
        ClampedNumberField(
          title: "Approval timeout", value: agent.approvalTimeoutMs / 60_000,
          range: (SettingsRanges.approvalTimeoutMs.lowerBound / 60_000)...(SettingsRanges.approvalTimeoutMs.upperBound / 60_000),
          step: 15, unit: "min"
        ) { update(.init(approvalTimeoutMs: $0 * 60_000)) }
        SettingsNote(text: "Risky actions waiting longer than this are denied automatically.")
        Toggle("Act on tasks that already exist", isOn: Binding(
          get: { agent.actOnExistingTasks },
          set: { update(.init(actOnExistingTasks: $0)) }))
      }
      Section("Watch window") {
        ClampedNumberField(title: "Days before today", value: agent.watch.pastDays, range: SettingsRanges.watchDays, unit: "days") {
          update(.init(watch: .init(pastDays: $0)))
        }
        ClampedNumberField(title: "Days after today", value: agent.watch.futureDays, range: SettingsRanges.watchDays, unit: "days") {
          update(.init(watch: .init(futureDays: $0)))
        }
        SettingsNote(text: "Daily notes in this window are watched for tasks.")
      }
      Section("Models") {
        LabeledContent("Model") {
          Text(status?.model ?? agent.model).font(.system(.body, design: .monospaced)).textSelection(.enabled)
        }
        LabeledContent("Safety judge") {
          Text(agent.judgeModel).font(.system(.body, design: .monospaced)).textSelection(.enabled)
        }
        SettingsNote(text: "Configured on the daemon (OpenRouter model ids).")
        if let status {
          LabeledContent("Mode", value: status.mode.rawValue)
          LabeledContent("Execution", value: status.execution.provider)
        }
      }
      if !settings.isLoaded { NotConnectedNote() }
    }
    .formStyle(.grouped)
  }

  private func update(_ patch: SettingsPatch.AgentPatch) {
    Task { await settings.update(SettingsPatch(agent: patch)) }
  }
}
