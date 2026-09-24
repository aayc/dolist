import DailyDoListModels
import SwiftUI

/// Versions of the app, the protocol and the daemon, plus useful links.
struct AboutSettingsPane: View {
  let model: AppModel

  var body: some View {
    Form {
      Section {
        HStack(spacing: 14) {
          Image(systemName: "checkmark.square.fill")
            .font(.system(size: 40))
            .foregroundStyle(Theme.accent)
          VStack(alignment: .leading, spacing: 2) {
            Text("Daily Do List").font(.title2.weight(.semibold))
            Text("Your daily note is a do list: agents do the tasks.").foregroundStyle(.secondary)
          }
        }
      }
      Section("Versions") {
        LabeledContent("App", value: AppInfo.version)
        LabeledContent("API version", value: "v\(DaemonProtocol.apiVersion)")
        LabeledContent(
          "Daemon",
          value: model.connection.health.map { "\($0.version) (API v\($0.apiVersion))" } ?? "—")
        LabeledContent("Vault", value: model.connection.health?.vaultName ?? "—")
        LabeledContent(
          "Agent mode",
          value: model.agent?.status?.mode.rawValue ?? model.connection.health?.agentMode.rawValue
            ?? "—")
        LabeledContent("Endpoint", value: model.connection.endpointDescription)
      }
      Section("Links") {
        Link("OpenRouter models", destination: URL(string: "https://openrouter.ai/models")!)
        Link(
          "Model Context Protocol (connectors)",
          destination: URL(string: "https://modelcontextprotocol.io")!)
        Link("Node.js downloads", destination: URL(string: "https://nodejs.org/en/download")!)
      }
    }
    .formStyle(.grouped)
  }
}

enum AppInfo {
  /// `CFBundleShortVersionString (CFBundleVersion)`, or "dev" outside an app bundle.
  static var version: String {
    let info = Bundle.main.infoDictionary
    guard let short = info?["CFBundleShortVersionString"] as? String, !short.isEmpty else {
      return "dev"
    }
    if let build = info?["CFBundleVersion"] as? String, !build.isEmpty, build != short {
      return "\(short) (\(build))"
    }
    return short
  }
}
