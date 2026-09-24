import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// The daemon's `AppSettings`, updated optimistically: a patch applies locally at once, the
/// daemon's answer (or `settings.changed`) is authoritative, and a failed patch is reverted.
@MainActor
@Observable
final class SettingsStore {
  private(set) var settings: AppSettings = .defaults
  /// True once the daemon's settings arrived.
  private(set) var isLoaded = false

  @ObservationIgnored var client: DaemonClient?
  /// Called with (old, new) whenever the effective settings change.
  @ObservationIgnored var onChange: (@MainActor (AppSettings, AppSettings) -> Void)?
  @ObservationIgnored var onError: (@MainActor (Error) -> Void)?
  @ObservationIgnored private var revision = 0

  /// Authoritative settings from the daemon (initial load, PATCH answer, `settings.changed`).
  func apply(_ next: AppSettings) {
    isLoaded = true
    set(next)
  }

  func reload() async {
    guard let client else { return }
    if let fresh = try? await client.settings() { apply(fresh) }
  }

  /// Applies `patch` locally, sends it, and adopts the daemon's result; reverts on error.
  func update(_ patch: SettingsPatch) async {
    guard !patch.isEmpty else { return }
    let before = settings
    revision += 1
    let mine = revision
    set(settings.applying(patch))
    guard let client else { return }
    do {
      let confirmed = try await client.updateSettings(patch)
      if mine == revision { apply(confirmed) }
    } catch {
      onError?(error)
      if mine == revision {
        set(before)
      } else {
        await reload()
      }
    }
  }

  private func set(_ next: AppSettings) {
    guard next != settings else { return }
    let old = settings
    settings = next
    onChange?(old, next)
  }
}
