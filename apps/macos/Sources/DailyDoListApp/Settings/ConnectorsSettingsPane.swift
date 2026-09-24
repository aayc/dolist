import DailyDoListModels
import SwiftUI

/// MCP connectors the daemon loaded from `$DDL_HOME/mcp.json`.
struct ConnectorsSettingsPane: View {
  let model: AppModel
  @State private var connectors: [ConnectorStatus]?
  @State private var error: String?
  @State private var isLoading = false

  var body: some View {
    Form {
      Section {
        if let error {
          SettingsNote(text: error, tone: Theme.danger)
        } else if let connectors {
          if connectors.isEmpty {
            Text("No connectors configured.").foregroundStyle(.secondary)
          }
          ForEach(connectors) { ConnectorRow(connector: $0) }
        } else if model.client == nil {
          NotConnectedNote()
        } else {
          ProgressView().controlSize(.small)
        }
      } header: {
        HStack {
          Text("Connectors")
          Spacer()
          Button("Refresh") { Task { await load() } }
            .controlSize(.small)
            .disabled(isLoading || model.client == nil)
        }
      } footer: {
        SettingsNote(
          text:
            "MCP servers from ~/.daily-do-list/mcp.json (the same format as Claude Desktop and Cursor)."
        )
      }
    }
    .formStyle(.grouped)
    .task { await load() }
  }

  private func load() async {
    guard let client = model.client else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      connectors = try await client.connectors()
      error = nil
    } catch {
      self.error = ToastStore.message(for: error)
    }
  }
}

struct ConnectorRow: View {
  let connector: ConnectorStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(connector.name).font(.body.weight(.medium))
        Pill(text: connector.transport.rawValue, color: Theme.mutedText)
        Spacer()
        Text(TextMetrics.pluralize(connector.toolCount, "tool")).foregroundStyle(.secondary)
        Pill(text: connector.state.rawValue, color: color)
      }
      if let error = connector.error {
        SettingsNote(text: error, tone: Theme.danger)
      }
    }
  }

  private var color: Color {
    switch connector.state {
    case .connected: Theme.success
    case .connecting: Theme.info
    case .error: Theme.danger
    default: Theme.faintText
    }
  }
}
