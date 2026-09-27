#if canImport(UIKit)
  import DailyDoListModels
  import SwiftUI

  struct MobileConnectorSettings: View {
    let store: MobileSettingsStore
    var body: some View {
      Form {
        Section("Connectors on \(store.hostName)") {
          if let connectors = store.connectors {
            if connectors.isEmpty { Text("No connectors configured.") }
            ForEach(connectors) { connector in
              VStack(alignment: .leading, spacing: 4) {
                Text(connector.name).font(.headline)
                Text(
                  "\(connector.transport.rawValue) · \(connector.state.rawValue) · \(connector.toolCount) tools"
                ).font(.caption)
                if let error = connector.error { Text(error).foregroundStyle(.red).font(.footnote) }
              }
            }
          } else {
            Text("Connector status is unavailable.")
          }
          Button("Refresh") { Task { await store.load() } }.disabled(!store.canMutate)
          SettingsErrors(store: store, keys: ["connectors"])
        }
        Section {
          Text(
            "Configure MCP servers in $DDL_HOME/mcp.json on \(store.hostName), using the mcpServers format, then restart the host daemon. Connector credentials stay on the host."
          ).textSelection(.enabled).font(.footnote)
        }
      }.navigationTitle("Connectors")
    }
  }

  struct MobileDiagnostics: View {
    let store: MobileSettingsStore
    var body: some View {
      Form {
        Section("Daily Do List") {
          LabeledContent(
            "App",
            value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
              ?? "Development")
          LabeledContent(
            "Build",
            value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Development")
          LabeledContent("Client API", value: "\(DaemonProtocol.apiVersion)")
          LabeledContent("Connected host", value: store.hostName)
          LabeledContent("Shared actions", value: store.actionsEnabled ? "Online" : "Read-only")
        }
        if let health = store.health {
          Section("Host report") {
            LabeledContent("Daemon version", value: health.version)
            LabeledContent("Daemon API", value: "\(health.apiVersion)")
            LabeledContent("Vault", value: health.vaultName)
            LabeledContent("Agent mode", value: health.agentMode.rawValue)
            if let capabilities = health.capabilities {
              LabeledContent("Capabilities", value: capabilities.joined(separator: ", "))
            }
          }
        }
        if let agent = store.agent {
          Section("Agent") {
            LabeledContent("Enabled", value: agent.enabled ? "Yes" : "No")
            LabeledContent("Model", value: agent.model)
            LabeledContent("Execution", value: agent.execution.provider)
            LabeledContent("Running", value: "\(agent.running)")
            LabeledContent("Queued", value: "\(agent.queued)")
            LabeledContent("Pending approvals", value: "\(agent.pendingApprovals)")
            if let problem = agent.problem { Text(problem).foregroundStyle(.orange) }
          }
        }
        Section {
          Button("Refresh diagnostics") { Task { await store.load() } }.disabled(!store.canMutate)
          SettingsErrors(store: store)
          Text(
            "Credentials, personal note contents and process logs are not included in this report."
          ).font(.footnote)
        }
      }.navigationTitle("Diagnostics")
    }
  }

  struct MobileHostSetup: View {
    let hostName: String
    var body: some View {
      Form {
        Section {
          Text(
            "Complete these actions directly on \(hostName). A paired iPhone cannot use the daemon's privileged setup routes."
          ).font(.footnote)
        }
        Section("Vault and Obsidian") {
          Text(
            "Open Daily Do List on \(hostName), then Settings → General to choose or switch its vault, import from Obsidian, or update from an existing import. On a headless host, configure its vault path and restart its service."
          )
          Text(
            "Use Finder or the host's file manager to reveal the vault. Existing notes remain plain Markdown files."
          )
        }
        Section("Model credentials") {
          Text(
            "For Pi and the safety judge, set OPENROUTER_API_KEY in the host's environment or ~/.daily-do-list/.env, then restart the host daemon."
          ).textSelection(.enabled)
          Text(
            "For Cursor, install its CLI on the host and run agent login there. Use agent models to inspect available model names. Do not paste credentials into note or chat text."
          ).textSelection(.enabled)
        }
        Section("Computer use") {
          Text(
            "On a Mac host, open its Daily Do List app and Settings → Computer Use. Grant Accessibility and Screen Recording in that Mac's System Settings. Install Google Chrome on the host for browser execution. A Linux host cannot use the Mac desktop-control helper."
          )
        }
        Section("Daemon lifecycle") {
          Text(
            "Start, restart and update the daemon from the Mac app or the host's service manager. Port, vault path, DDL_HOME, agent mode and environment overrides are host setup. The iPhone does not start a background daemon."
          )
        }
        Section("Remote access and sync") {
          Text(
            "Keep the daemon bound to loopback. Configure its private-network proxy and allowed DNS names, then pair each device with a single-use code. Obtain the sync service URL, vault ID and token from the sync service administrator or ddl-sync vault create."
          )
        }
      }.navigationTitle("Setup on \(hostName)")
    }
  }
#endif
