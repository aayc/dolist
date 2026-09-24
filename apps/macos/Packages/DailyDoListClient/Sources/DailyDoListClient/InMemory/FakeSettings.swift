import DailyDoListModels
import Foundation

/// Validates and applies `SettingsPatch`es like the daemon (`UpdateSettingsRequest` schema ranges,
/// trimmed model ids, and note paths that must stay visible and inside the vault).
enum FakeSettings {
  /// The patch with model ids trimmed, or the daemon's 400 `invalid_request`.
  static func validate(_ patch: SettingsPatch) throws(DaemonClientError) -> SettingsPatch {
    var problems: [String] = []
    var patch = patch
    func check<T: Comparable>(_ value: T?, _ range: ClosedRange<T>, _ path: String) {
      if let value, !range.contains(value) {
        problems.append("\(path) must be between \(range.lowerBound) and \(range.upperBound)")
      }
    }
    func checkLength(_ value: String?, _ max: Int, _ path: String) {
      if let value, value.utf16.count > max { problems.append("\(path) is longer than \(max) characters") }
    }
    check(patch.editor?.fontSize, SettingsRanges.fontSize, "editor.fontSize")
    for (name, section) in [("dailyNotes", patch.dailyNotes), ("weeklyNotes", patch.weeklyNotes.map {
      SettingsPatch.DailyNotesPatch(folder: $0.folder, format: $0.format, template: $0.template)
    })] {
      checkLength(section?.folder, SettingsRanges.folderLength, "\(name).folder")
      checkLength(section?.format, SettingsRanges.formatLength, "\(name).format")
      checkLength(section?.template, SettingsRanges.templateLength, "\(name).template")
    }
    if let agent = patch.agent {
      check(agent.settleMs, SettingsRanges.settleMs, "agent.settleMs")
      check(agent.maxConcurrentSubagents, SettingsRanges.maxConcurrentSubagents, "agent.maxConcurrentSubagents")
      check(agent.watch?.pastDays, SettingsRanges.watchDays, "agent.watch.pastDays")
      check(agent.watch?.futureDays, SettingsRanges.watchDays, "agent.watch.futureDays")
      check(agent.approvalTimeoutMs, SettingsRanges.approvalTimeoutMs, "agent.approvalTimeoutMs")
      patch.agent?.model = try? trimmedModel(agent.model, "agent.model", &problems)
      patch.agent?.judgeModel = try? trimmedModel(agent.judgeModel, "agent.judgeModel", &problems)
    }
    if !problems.isEmpty { throw .invalidRequest("Invalid settings: " + problems.joined(separator: "; ")) }
    return patch
  }

  private static func trimmedModel(_ value: String?, _ path: String, _ problems: inout [String]) throws -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.utf16.count > 200 {
      problems.append("\(path) must be 1-200 characters")
    }
    return trimmed
  }

  /// Cross-field checks on the sections a patch touches (the daemon's `settingsProblems`).
  static func pathProblems(
    _ settings: AppSettings, touched patch: SettingsPatch, today: LocalDate, calendar: FakeCalendar
  ) -> [String] {
    var problems: [String] = []
    if patch.dailyNotes != nil {
      do {
        if FakeVaultPaths.isHidden(try calendar.dailyNotePath(today, settings.dailyNotes)) {
          problems.append("dailyNotes: notes would be created in a hidden folder")
        }
        if let template = try FakeCalendar.templateNotePath(settings.dailyNotes.template), FakeVaultPaths.isSidecar(template) {
          problems.append("dailyNotes: template cannot live in the sidecar")
        }
      } catch {
        problems.append("dailyNotes: the path escapes the vault root")
      }
    }
    if patch.weeklyNotes != nil {
      do {
        if FakeVaultPaths.isHidden(try calendar.weeklyNotePath(today, settings.weeklyNotes)) {
          problems.append("weeklyNotes: notes would be created in a hidden folder")
        }
        if let template = try FakeCalendar.templateNotePath(settings.weeklyNotes.template), FakeVaultPaths.isSidecar(template) {
          problems.append("weeklyNotes: template cannot live in the sidecar")
        }
      } catch {
        problems.append("weeklyNotes: the path escapes the vault root")
      }
    }
    return problems
  }
}
