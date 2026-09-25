import DailyDoListModels
import DailyDoListUI
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
        SettingsToggle(
          "Agent enabled",
          isOn: Binding(
            get: { status?.enabled ?? agent.enabled },
            set: { enabled in
              Task {
                await model.setAgentEnabled(enabled)
                await settings.update(SettingsPatch(agent: .init(enabled: enabled)))
              }
            }))
        SettingsNote(text: "When off, the orchestrator ignores changes to your notes.")
        ClampedNumberField(
          title: "Settle delay", value: agent.settleMs, range: SettingsRanges.settleMs, step: 250,
          unit: "ms"
        ) {
          update(.init(settleMs: $0))
        }
        SettingsNote(text: "Quiet time after you stop editing a task before the agent looks at it.")
        ClampedNumberField(
          title: "Max concurrent subagents", value: agent.maxConcurrentSubagents,
          range: SettingsRanges.maxConcurrentSubagents
        ) { update(.init(maxConcurrentSubagents: $0)) }
        ClampedNumberField(
          title: "Approval timeout", value: agent.approvalTimeoutMs / 60_000,
          range: (SettingsRanges.approvalTimeoutMs.lowerBound / 60_000)...(SettingsRanges
            .approvalTimeoutMs.upperBound / 60_000),
          step: 15, unit: "min"
        ) { update(.init(approvalTimeoutMs: $0 * 60_000)) }
        SettingsNote(text: "Risky actions waiting longer than this are denied automatically.")
        SettingsToggle(
          "Act on tasks that already exist",
          isOn: Binding(
            get: { agent.actOnExistingTasks },
            set: { update(.init(actOnExistingTasks: $0)) }))
      }
      Section("Models") {
        LabeledContent("Agent") {
          Picker(
            "Agent", selection: Binding(get: { agent.harness }, set: { update(.init(harness: $0)) })
          ) {
            ForEach(AgentHarnessKind.allCases, id: \.self) { Text($0.settingsLabel).tag($0) }
          }
          .labelsHidden()
          .fixedSize()
          .pointingHandCursor()
        }
        SettingsNote(text: "What runs the orchestrator and its subagents.")
        let field = AgentModelField(agent)
        CommitTextField(
          title: field.title, value: field.value, prompt: field.prompt, monospaced: true,
          required: true
        ) {
          update(field.patch($0))
        }
        .id(field.harness)
        SettingsNote(text: field.note)
        LabeledContent("Safety judge") {
          Text(agent.judgeModel).font(.system(.body, design: .monospaced)).textSelection(.enabled)
        }
        SettingsNote(text: "Checks risky actions. An OpenRouter model with either agent.")
        if let status {
          LabeledContent("Mode", value: status.mode.rawValue)
          LabeledContent("Execution", value: status.execution.provider)
        }
      }
      Section("Watch window") {
        ClampedNumberField(
          title: "Days before today", value: agent.watch.pastDays, range: SettingsRanges.watchDays,
          unit: "days"
        ) {
          update(.init(watch: .init(pastDays: $0)))
        }
        ClampedNumberField(
          title: "Days after today", value: agent.watch.futureDays, range: SettingsRanges.watchDays,
          unit: "days"
        ) {
          update(.init(watch: .init(futureDays: $0)))
        }
        SettingsNote(text: "Daily notes in this window are watched for tasks.")
      }
      if !settings.isLoaded { NotConnectedNote() }
    }
    .formStyle(.grouped)
  }

  private func update(_ patch: SettingsPatch.AgentPatch) {
    Task { await settings.update(SettingsPatch(agent: patch)) }
  }
}

extension AgentHarnessKind {
  /// The harness's choice in Settings → Agent.
  var settingsLabel: String {
    switch self {
    case .pi: "Pi · OpenRouter model"
    case .cursor: "Cursor CLI · your Cursor account"
    }
  }
}

/// The model field the Agent pane shows: the configured harness's model.
struct AgentModelField: Equatable {
  let harness: AgentHarnessKind
  let title: String
  let value: String
  let prompt: String
  let note: String

  init(_ agent: AgentSettings) {
    harness = agent.harness
    switch agent.harness {
    case .pi:
      title = "OpenRouter model"
      value = agent.model
      prompt = AgentSettings.defaultModel
      note = "An OpenRouter model id, e.g. \(AgentSettings.defaultModel)."
    case .cursor:
      title = "Cursor model"
      value = agent.cursorModel
      prompt = AgentSettings.defaultCursorModel
      note =
        "A model from `agent models`, e.g. claude-opus-5-5 or composer-2.5. The CLI runs each model's preset: effort and fast variants can't be picked."
    }
  }

  /// Saves `model` as this harness's model.
  func patch(_ model: String) -> SettingsPatch.AgentPatch {
    switch harness {
    case .pi: SettingsPatch.AgentPatch(model: model)
    case .cursor: SettingsPatch.AgentPatch(cursorModel: model)
    }
  }
}
