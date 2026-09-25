import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation

/// How the app moves its daemon to another vault.
enum VaultSwitchMethod: Equatable {
  /// The app runs the daemon and passes it `DDL_VAULT` (its vault preference): the daemon would
  /// answer 409 `locked_by_env`, so the app changes the preference and restarts it.
  case preference
  /// The daemon writes the vault to its `config.json` and exits to start again on it
  /// (`PUT /api/device/vault`): the app's supervisor, or whoever started it, starts it again.
  case daemon
}

extension AppModel {
  var vaultSwitchMethod: VaultSwitchMethod {
    guard preferences.daemonMode == .managed, !isDemo, case .running = supervisor.state,
      supervisor.configuration.vaultPath != nil
    else { return .daemon }
    return .preference
  }

  /// Why the app can't switch to another vault right now; nil when it can.
  var vaultSwitchBlocker: String? {
    if isDemo { return "The demo can't switch vaults." }
    if imports.isForbidden { return ObsidianImportStore.pairedDeviceReason }
    if imports.isRunning { return "An import or update from Obsidian is running." }
    if imports.syncs {
      return
        "This device syncs its vault. Turn sync off first, or your old notes would sync into the new vault."
    }
    if vaultSwitchMethod == .daemon, imports.vault?.lockedByEnv == true {
      return
        "The daemon was started with DDL_VAULT, which fixes its vault. Point DDL_VAULT at the new vault where you start it."
    }
    return nil
  }

  /// Saves open notes, moves the daemon to `path` and reconnects on it (tabs, the agent and
  /// settings are the new vault's). Returns why it couldn't, or nil.
  @discardableResult
  func switchVault(to path: String) async -> String? {
    if let blocker = vaultSwitchBlocker {
      imports.endSwitch(error: blocker)
      return blocker
    }
    imports.beginSwitch()
    let name = (path as NSString).lastPathComponent
    switch vaultSwitchMethod {
    case .preference:
      await teardown()
      preferences.vaultPath = path
      supervisor.configuration = preferences.launchConfiguration
      phase = .booting("Opening \(name)…")
      _ = await supervisor.restart()
      await boot()
      return nil
    case .daemon:
      return await switchThroughDaemon(to: path, name: name)
    }
  }

  private func switchThroughDaemon(to path: String, name: String) async -> String? {
    guard let client else {
      imports.endSwitch(error: "Not connected to the daemon.")
      return "Not connected to the daemon."
    }
    await flushAll()
    let response: DeviceVaultResponse
    do {
      response = try await client.switchVault(DeviceVaultRequest(path: path))
    } catch {
      let message =
        (error as? DaemonClientError).map(ObsidianImportStore.message(for:))
        ?? error.localizedDescription
      imports.endSwitch(error: message)
      return message
    }
    guard let restart = response.restart else {
      imports.endSwitch(error: nil)
      return nil
    }
    let endpoint = clientEndpoint
    let managed = preferences.daemonMode == .managed
    let launched: Int32? =
      if case .running(let pid, _) = supervisor.state { pid } else { nil }
    await teardown()
    if let launched, managed {
      phase = .booting("Restarting the daemon on \(name)…")
      await waitForRelaunch(of: launched)
    } else {
      let waitsForUser = restart == .manual && !managed
      phase = .booting(
        waitsForUser
          ? "The daemon stopped so it can open \(name). Start it again the way you started it; the app reconnects when it's back."
          : "Waiting for the daemon to start again on \(name)…")
      await waitForDaemon(at: endpoint, vaultName: name, waitsForUser: waitsForUser)
      // A daemon this app attached to has gone: let go of it, so booting starts this app's own.
      if managed { await supervisor.stop() }
    }
    await boot()
    return nil
  }

  /// Until the supervisor runs a new daemon (it relaunches one that exits to open another vault).
  private func waitForRelaunch(of pid: Int32) async {
    let deadline = Date().addingTimeInterval(60)
    while Date() < deadline {
      switch supervisor.state {
      case .running(let next, _) where next != pid: return
      case .failed: return
      default: try? await Task.sleep(for: .milliseconds(100))
      }
    }
  }

  /// Until the daemon at `endpoint` answers on the new vault, or (unless the user must start it
  /// again) stops answering.
  private func waitForDaemon(at endpoint: DaemonEndpoint?, vaultName: String, waitsForUser: Bool)
    async
  {
    guard let endpoint else { return }
    let probe = environment.makeClient(endpoint)
    let deadline = Date().addingTimeInterval(waitsForUser ? 600 : 60)
    while Date() < deadline {
      if let health = try? await probe.health() {
        if health.vaultName == vaultName { return }
      } else if !waitsForUser {
        return
      }
      try? await Task.sleep(for: .milliseconds(500))
    }
  }

  // MARK: - After an import

  /// The vault this one was imported over, when it's on this Mac.
  var previousVaultURL: URL? {
    guard !isDemo, let path = imports.imported?.previousVault, environment.folderExists(path)
    else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
  }

  func revealPreviousVault() {
    guard let url = previousVaultURL else { return }
    environment.revealInFinder(url)
  }

  /// Import from Obsidian…: Settings → General with the import sheet open.
  func showImportFromObsidian() {
    ui.obsidianImportPresented = true
    showSettings(.general)
  }

  /// A job that ended while its sheet or section may not be on screen.
  func announceImportEnd(_ job: ObsidianImportJob) {
    let update = job.kind == .update
    switch job.state {
    case .done:
      toasts.show(
        .success, update ? "Update from Obsidian finished" : "Import from Obsidian finished",
        body: update ? nil : "Switch to the new vault in Settings → General.",
        actionLabel: "Open"
      ) { [weak self] in
        guard let self else { return }
        if update { showSettings(.general) } else { showImportFromObsidian() }
      }
    case .failed:
      toasts.show(
        .error, update ? "Update from Obsidian stopped" : "Import from Obsidian stopped",
        body: job.error)
    default:
      break
    }
  }
}
