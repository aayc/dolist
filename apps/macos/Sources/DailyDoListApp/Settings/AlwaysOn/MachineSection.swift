import AppKit
import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → Always-On → Always-On Machine: its address and pairing with a code, what it
/// reports (reachable, version, where its agent runs, its readiness), checking it, forgetting
/// this device's credential, and opening its web app.
struct MachineSection: View {
  let model: AppModel
  let remote: RemoteSettingsStore
  @State private var confirmingForget = false

  var body: some View {
    Form {
      if let status = remote.machine {
        if let machine = status.machine {
          Section("Always-on machine") {
            LabeledContent("Name", value: machine.name)
            LabeledContent("Address") {
              Text(machine.url).textSelection(.enabled).foregroundStyle(.secondary)
            }
            LabeledContent("This device") {
              Text(status.paired ? "Paired" : "Not paired yet")
                .foregroundStyle(status.paired ? Theme.success : Theme.warning)
            }
            HStack {
              if let url = URL(string: machine.url) {
                Button("Open Its Web App") { NSWorkspace.shared.open(url) }
                  .pointingHandCursor()
                  .tooltip(TooltipContent.path(machine.url))
              }
              Spacer()
              if status.paired {
                Button("Forget This Machine…") { confirmingForget = true }
                  .pointingHandCursor()
                  .disabled(remote.isBusy(.forgetMachine))
              }
            }
            if let error = remote.error(.forgetMachine) {
              SettingsNote(text: error, tone: Theme.danger)
            }
          }
          if status.paired {
            MachineStatusRows(model: model, remote: remote, status: status)
          } else {
            PairMachineForm(remote: remote, initialURL: machine.url)
          }
        } else {
          PairMachineForm(remote: remote, initialURL: "")
        }
      } else {
        Section { AlwaysOnUnavailableNote(model: model, remote: remote) }
      }
    }
    .formStyle(.grouped)
    .alert(
      "Forget \(remote.machine?.machine?.name ?? "the always-on machine")?",
      isPresented: $confirmingForget
    ) {
      Button("Forget", role: .destructive) { Task { await remote.forgetMachine() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "This device drops its credential (the machine revokes it when it answers). The machine stays set up for your other devices; pair again with a new code."
      )
    }
    .task(id: remote.machine?.paired == true) {
      // The daemon checks the machine while a client watches: keep the status fresh while shown.
      while remote.machine?.paired == true, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(15))
        guard !Task.isCancelled else { return }
        await remote.refreshMachine()
      }
    }
  }
}

/// Reachability, version, where its agent runs, and its readiness.
private struct MachineStatusRows: View {
  let model: AppModel
  let remote: RemoteSettingsStore
  let status: MachineStatusResponse

  var body: some View {
    Section {
      LabeledContent("Reachable") {
        switch status.reachable {
        case true?:
          Label("Yes", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success)
        case false?: Label("No", systemImage: "xmark.circle.fill").foregroundStyle(Theme.danger)
        case nil: Text("Not checked yet").foregroundStyle(.secondary)
        }
      }
      if let error = status.error, status.reachable == false {
        SettingsNote(text: error, tone: Theme.danger)
      }
      if let version = status.version { LabeledContent("Version", value: version) }
      if let agent = status.agent {
        LabeledContent("Its agent runs on") {
          Text(Self.runsOnText(agent.runsOn, thisDeviceId: remote.device?.device.id))
            .foregroundStyle(.secondary)
        }
        if let problem = agent.problem { SettingsNote(text: problem, tone: Theme.warning) }
      }
      HStack {
        if let checkedAt = status.checkedAt {
          Text("Checked \(Date(epochMillis: checkedAt), style: .relative) ago")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button(remote.isBusy(.checkMachine) ? "Checking…" : "Check Now") {
          Task { await remote.checkMachine() }
        }
        .pointingHandCursor()
        .disabled(remote.isBusy(.checkMachine))
      }
      if let error = remote.error(.checkMachine) { SettingsNote(text: error, tone: Theme.danger) }
    } header: {
      Text("Status")
    }
    Section("Its readiness") {
      if let readiness = status.readiness {
        ReadinessRows(items: ReadinessItem.items(readiness, onThisDevice: false))
      } else {
        SettingsNote(
          text: status.reachable == false
            ? "Its readiness shows once it answers."
            : "Check the machine to see whether it's ready to run the agent.")
      }
    }
  }

  /// Where the machine says its agent runs; "this device" there is the machine itself.
  static func runsOnText(_ runsOn: AgentRunsOn?, thisDeviceId: String?) -> String {
    guard let runsOn else { return "Nobody right now" }
    if runsOn.thisDevice { return "Itself" }
    if runsOn.deviceId == thisDeviceId { return "This device" }
    return runsOn.name
  }
}

/// The address and a pairing code the machine issued.
struct PairMachineForm: View {
  let remote: RemoteSettingsStore
  let initialURL: String
  @State private var url = ""
  @State private var code = ""
  @State private var name = ""
  @State private var edited = false

  var body: some View {
    Section {
      TextField("Address", text: $url, prompt: Text("https://vm-name.tailnet-name.ts.net"))
        .onChange(of: url) { edited = true }
      if let problem = urlProblem { SettingsNote(text: problem, tone: Theme.danger) }
      LabeledContent("Pairing code") {
        TextField("Pairing code", text: $code, prompt: Text("XXXX-XXXX"))
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          .font(.system(.body, design: .monospaced))
      }
      if let problem = codeProblem { SettingsNote(text: problem, tone: Theme.danger) }
      TextField("Name", text: $name, prompt: Text(defaultName ?? "Optional"))
      HStack {
        Spacer()
        Button(remote.isBusy(.pairMachine) ? "Pairing…" : "Pair") {
          Task { await pair() }
        }
        .buttonStyle(.borderedProminent)
        .pointingHandCursor()
        .disabled(!canPair || remote.isBusy(.pairMachine))
      }
      if let error = remote.error(.pairMachine) { SettingsNote(text: error, tone: Theme.danger) }
    } header: {
      Text(initialURL.isEmpty ? "Pair with the always-on machine" : "Pair this device")
    } footer: {
      SettingsNote(
        text:
          "Get a pairing code on the always-on machine: in its web app (Settings → Devices), or with its daemon's `pair` command. Codes work once, for five minutes.",
        markdown: true)
    }
    .onAppear { if !edited { url = initialURL } }
  }

  private var normalizedURL: String? { RemoteAccess.normalizeMachineURL(url) }
  private var normalizedCode: String? { RemoteAccess.normalizePairingCode(code) }
  private var defaultName: String? { normalizedURL.map(RemoteAccess.defaultMachineName) }

  private var urlProblem: String? {
    guard !url.trimmingCharacters(in: .whitespaces).isEmpty, normalizedURL == nil else {
      return nil
    }
    return "Use https://<name>[:port], without a path (plain http only to this Mac)."
  }

  private var codeProblem: String? {
    let typed = code.filter { !$0.isWhitespace && $0 != "-" }
    guard typed.count >= RemoteAccess.pairingCodeLength, normalizedCode == nil else { return nil }
    return "A pairing code is 8 letters and digits, like ABCD-2345."
  }

  private var nameProblem: Bool {
    !name.trimmingCharacters(in: .whitespaces).isEmpty
      && RemoteAccess.normalizeDeviceName(name) == nil
  }

  private var canPair: Bool { normalizedURL != nil && normalizedCode != nil && !nameProblem }

  private func pair() async {
    guard let url = normalizedURL, let code = normalizedCode else { return }
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    if await remote.pairMachine(url: url, code: code, name: trimmed.isEmpty ? nil : trimmed) {
      self.code = ""
    }
  }
}
