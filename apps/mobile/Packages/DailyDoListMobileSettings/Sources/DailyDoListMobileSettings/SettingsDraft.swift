import DailyDoListDomain
import DailyDoListModels
import Foundation

/// Only changed leaves are sent; newer daemon fields and unknown enum fallbacks are untouched.
enum SettingsDraft {
  static func patch(from baseline: AppSettings, to draft: AppSettings) throws -> SettingsPatch {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let before = try decoder.decode(JSONValue.self, from: encoder.encode(baseline))
    let after = try decoder.decode(JSONValue.self, from: encoder.encode(draft))
    let value = difference(before, after) ?? .object([:])
    return try decoder.decode(SettingsPatch.self, from: encoder.encode(value))
  }

  private static func difference(_ old: JSONValue?, _ new: JSONValue, key: String = "")
    -> JSONValue?
  {
    guard old != new else { return nil }
    if key != "alwaysOnMachine", case .object(let values) = new {
      var result: [String: JSONValue] = [:]
      for (key, value) in values {
        if let change = difference(old?[key], value, key: key) { result[key] = change }
      }
      return result.isEmpty ? nil : .object(result)
    }
    return new
  }

  static func problems(_ settings: AppSettings) -> [String] {
    var result: [String] = []
    let agent = settings.agent
    if !SettingsRanges.fontSize.contains(settings.editor.fontSize) {
      result.append("Font size must be 8–48.")
    }
    if settings.editor.vimrc.utf16.count > SettingsRanges.vimrcLength {
      result.append("Vim configuration is too long.")
    }
    for (title, folder, format, template) in [
      (
        "Daily", settings.dailyNotes.folder, settings.dailyNotes.format,
        settings.dailyNotes.template
      ),
      (
        "Weekly", settings.weeklyNotes.folder, settings.weeklyNotes.format,
        settings.weeklyNotes.template
      ),
    ] {
      if folder.utf16.count > SettingsRanges.folderLength
        || format.utf16.count > SettingsRanges.formatLength
        || template.utf16.count > SettingsRanges.templateLength
      {
        result.append("\(title) note settings exceed the allowed path or format length.")
      }
    }
    if !SettingsRanges.settleMs.contains(agent.settleMs) {
      result.append("Settle delay must be 0–120000 milliseconds.")
    }
    if !SettingsRanges.maxConcurrentSubagents.contains(agent.maxConcurrentSubagents) {
      result.append("Concurrency must be 1–32.")
    }
    if !SettingsRanges.watchDays.contains(agent.watch.pastDays)
      || !SettingsRanges.watchDays.contains(agent.watch.futureDays)
    {
      result.append("Watch windows must be 0–366 days.")
    }
    if !SettingsRanges.approvalTimeoutMs.contains(agent.approvalTimeoutMs) {
      result.append("Approval timeout must be 1 minute–30 days.")
    }
    for (title, model) in [
      ("OpenRouter", agent.model), ("Cursor", agent.cursorModel),
      ("Safety judge", agent.judgeModel),
    ] {
      let value = model.trimmingCharacters(in: .whitespacesAndNewlines)
      if value.isEmpty || value.utf16.count > SettingsRanges.modelIdLength {
        result.append("\(title) model must be 1–200 characters.")
      }
    }
    if let machine = settings.remote.alwaysOnMachine,
      RemoteAccess.normalizeDeviceName(machine.name) == nil
        || !RemoteAccess.isMachineURL(machine.url)
    {
      result.append("The always-on machine needs a name and a valid HTTPS origin.")
    }
    return result
  }
}

struct PolicyConsent: Equatable {
  var from: ApprovalPolicy
  var to: ApprovalPolicy
}

enum MobileApprovalPolicy {
  static func widens(from: ApprovalPolicy, to: ApprovalPolicy) -> Bool {
    rank(to) > rank(from)
  }
  private static func rank(_ policy: ApprovalPolicy) -> Int {
    switch policy {
    case .askEveryAction: 0
    case .askRisky: 1
    case .askHighRisk: 2
    case .runEverything: 3
    }
  }
  static func title(_ policy: ApprovalPolicy) -> String {
    switch policy {
    case .askEveryAction: "Ask before every change"
    case .askRisky: "Ask for risky actions"
    case .askHighRisk: "Ask only for high-risk actions"
    case .runEverything: "Run everything"
    }
  }
  static func detail(_ policy: ApprovalPolicy) -> String {
    switch policy {
    case .askEveryAction:
      "Every action that changes something asks first. Reading and research can run."
    case .askRisky:
      "The safety check asks for purchases, messages, bookings, deletions, account changes and actions it cannot verify."
    case .askHighRisk:
      "Only high-risk actions ask first. Other actions, including changes to your note text, can run without approval."
    case .runEverything:
      "Agents can buy, send messages, book, delete files and run programs without asking. Hard-denied actions stay blocked."
    }
  }
}
