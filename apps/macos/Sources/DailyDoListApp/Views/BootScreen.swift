import DailyDoListUI
import SwiftUI

/// Startup progress, or a clear explanation of what's wrong with the daemon and how to fix it.
struct BootScreen: View {
  let model: AppModel

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "checkmark.square.fill")
        .font(.system(size: 44, weight: .regular))
        .foregroundStyle(Theme.accent)
      switch model.phase {
      case .failed(let failure):
        BootFailureView(model: model, failure: failure)
      case .booting(let message):
        ProgressView().controlSize(.small)
        Text(message).foregroundStyle(Theme.mutedText)
      case .idle, .ready:
        ProgressView().controlSize(.small)
      }
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.background)
  }
}

private struct BootFailureView: View {
  let model: AppModel
  let failure: BootFailure
  @State private var isWorking = false

  var body: some View {
    VStack(spacing: 14) {
      Text(failure.title)
        .font(.title2.weight(.semibold))
      Text(failure.message)
        .font(.callout)
        .foregroundStyle(Theme.mutedText)
        .multilineTextAlignment(.center)
        .textSelection(.enabled)
        .frame(maxWidth: 520)
      HStack(spacing: 10) {
        Button("Retry") { run { await model.boot() } }
          .keyboardShortcut(.defaultAction)
          .pointingHandCursor()
          .tooltip("Retry", keys: .returnKey, accessibility: .keysOnly)
        if failure.offersStartDaemon, model.preferences.daemonMode == .external {
          Button("Start Daemon") { run { await model.startManagedDaemon() } }
            .pointingHandCursor()
        }
        if let url = failure.helpURL {
          Link("Install Node.js…", destination: url).pointingHandCursor()
        }
        SettingsLink { Text("Open Settings…") }.pointingHandCursor()
      }
      .disabled(isWorking)
      if model.managesDaemon, !model.supervisor.logLines.isEmpty {
        DisclosureGroup("Daemon log") {
          ScrollView {
            Text(model.supervisor.logLines.suffix(40).joined(separator: "\n"))
              .font(.system(size: 11, design: .monospaced))
              .frame(maxWidth: .infinity, alignment: .leading)
              .textSelection(.enabled)
          }
          .frame(height: 140)
        }
        .disclosureGroupStyle(ChevronDisclosureStyle())
        .frame(maxWidth: 560)
      }
      Text(model.connection.endpointDescription == "—" ? "" : model.connection.endpointDescription)
        .font(.caption)
        .foregroundStyle(Theme.faintText)
    }
  }

  private func run(_ action: @escaping @MainActor () async -> Void) {
    isWorking = true
    Task {
      await action()
      isWorking = false
    }
  }
}
