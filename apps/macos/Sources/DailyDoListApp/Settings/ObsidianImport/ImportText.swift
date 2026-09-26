import DailyDoListModels
import Foundation

/// The words of the import from Obsidian (the web app's `import-text.ts`, in Swift).
enum ImportText {
  static func phase(_ phase: ObsidianImportPhase) -> String {
    switch phase {
    case .checking: "Reading the vault…"
    case .copying: "Copying files…"
    case .carryingOver: "Carrying over your notes…"
    case .finishing: "Finishing…"
    default: "Working…"
    }
  }

  /// 0–1: files copied so far (a job that's done is full).
  static func fraction(_ job: ObsidianImportJob) -> Double {
    if job.state == .done { return 1 }
    let total = job.progress.totalFiles
    return total > 0 ? min(1, Double(job.progress.files) / Double(total)) : 0
  }

  /// "12 of 64 files · 1.2 MB of 3.5 MB"; empty before the totals are known.
  static func progress(_ job: ObsidianImportJob) -> String {
    let p = job.progress
    guard p.totalFiles > 0 else { return "" }
    return
      "\(p.files) of \(TextMetrics.pluralize(p.totalFiles, "file")) · \(bytes(p.bytes)) of \(bytes(p.totalBytes))"
  }

  static func bytes(_ count: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
  }

  /// "a, b and c".
  static func join(_ parts: [String]) -> String {
    guard parts.count > 1, let last = parts.last else { return parts.first ?? "" }
    return parts.dropLast().joined(separator: ", ") + " and " + last
  }

  static func support(_ support: ObsidianPluginSupport) -> String {
    switch support {
    case .supported: "Works here"
    case .partial: "Partly"
    default: "Doesn't run"
    }
  }

  static func skipReason(_ reason: ImportSkipReason) -> String {
    switch reason {
    case .symlinkOutside: "a link to something outside the vault"
    case .symlinkFolder: "a link to a folder in the vault, copied where it is"
    case .specialFile: "not a regular file"
    case .unreadable: "can't be read"
    case .sidecar: "Daily Do List's own folder: your current agent history replaces it"
    default: reason.rawValue
    }
  }

  /// "11 images, 2 PDFs and 1 other file".
  static func attachments(_ summary: AttachmentSummary) -> String {
    join(
      summary.byType.map { item in
        switch item.type {
        case .image: TextMetrics.pluralize(item.count, "image")
        case .pdf: TextMetrics.pluralize(item.count, "PDF")
        case .audio: TextMetrics.pluralize(item.count, "audio file")
        case .video: TextMetrics.pluralize(item.count, "video")
        default: TextMetrics.pluralize(item.count, "other file")
        }
      })
  }

  /// "Journal/Daily, named YYYY/MM/YYYY-MM-DD".
  static func dailyPlace(_ daily: DailyNoteSettings) -> String {
    "\(daily.folder.isEmpty ? "the vault's top folder" : daily.folder), named \(daily.format)"
  }

  /// `dailyPlace` and the template new ones start from.
  static func dailyNotes(_ daily: DailyNoteSettings) -> String {
    dailyPlace(daily) + (daily.template.isEmpty ? "" : ", from the template \(daily.template)")
  }

  /// ["vim mode on", "line numbers off", "the vimrc"].
  static func editor(_ editor: ObsidianEditorSettings, vimrc: Bool) -> [String] {
    let names: [(Bool?, String)] = [
      (editor.vimMode, "vim mode"), (editor.livePreview, "live preview"),
      (editor.readableLineLength, "readable line length"),
      (editor.showLineNumbers, "line numbers"), (editor.spellcheck, "spellcheck"),
    ]
    var parts = names.compactMap { value, name in value.map { "\(name) \($0 ? "on" : "off")" } }
    if vimrc { parts.append("the vimrc") }
    return parts
  }

  static func day(_ epochMillis: Int) -> String {
    Date(timeIntervalSince1970: Double(epochMillis) / 1000).formatted(
      date: .long, time: .omitted)
  }

  /// What the agent does with Obsidian's open tasks after the switch.
  static func watchedTasks(_ plan: CarryOverPlan) -> String {
    "Obsidian's daily notes have \(TextMetrics.pluralize(plan.watchedOpenTasks, "open task")) in the days the agent "
      + "watches. The agent treats them as tasks that were already there, so "
      + (plan.actOnExistingTasks
        ? "it works on them: “Act on existing tasks” is on in Settings → Agent."
        : "it leaves them alone unless you edit them: “Act on existing tasks” is off.")
  }

  /// The update's outcome in one line.
  static func update(_ report: ObsidianUpdateReport) -> String {
    let parts = [
      report.added.count > 0 ? "\(report.added.count) new" : nil,
      report.updated.count > 0 ? "\(report.updated.count) changed" : nil,
      report.restored.count > 0 ? "\(report.restored.count) brought back" : nil,
      report.conflicts.count > 0
        ? "\(report.conflicts.count) changed in both places (both kept)" : nil,
    ].compactMap { $0 }
    if parts.isEmpty { return "Nothing changed in Obsidian since the last time." }
    return "\(join(parts)). \(TextMetrics.pluralize(report.unchanged, "file")) unchanged."
  }
}
