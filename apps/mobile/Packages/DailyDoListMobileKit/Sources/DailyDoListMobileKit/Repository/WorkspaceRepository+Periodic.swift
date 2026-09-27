import DailyDoListDomain
import DailyDoListModels
import Foundation

public enum PeriodicNoteKind: Sendable { case daily, weekly }

public enum PeriodicNoteError: Error, Equatable, LocalizedError {
  case templateNotDownloaded(String)
  case noteNotDownloaded(String)

  public var errorDescription: String? {
    switch self {
    case .templateNotDownloaded(let path):
      "Download the template \(path) before creating this note offline."
    case .noteNotDownloaded(let path):
      "\(path) exists on the host but is not downloaded to this iPhone."
    }
  }
}

extension WorkspaceRepository {
  /// Freeze the local date and template at creation. Create-only reconciliation preserves a
  /// concurrent host note rather than replacing it with a template after reconnecting.
  public func createPeriodicNote(
    _ kind: PeriodicNoteKind, date: LocalDate, settings: AppSettings,
    knownPaths: Set<String>, now: Date, timeZone: TimeZone
  ) throws -> LocalNote {
    let path: String
    let template: String
    switch kind {
    case .daily:
      path = try DailyNotes.checkedPath(
        for: date, settings: settings.dailyNotes, timeZone: timeZone)
      template = settings.dailyNotes.template
    case .weekly:
      path = try DailyNotes.checkedWeeklyPath(
        for: date, settings: settings.weeklyNotes, timeZone: timeZone)
      template = settings.weeklyNotes.template
    }
    if let existing = try note(path) { return existing }
    guard !knownPaths.contains(path) else { throw PeriodicNoteError.noteNotDownloaded(path) }
    var content = kind == .daily ? "- [ ] " : ""
    if let templatePath = DailyNotes.templatePath(template) {
      guard let templateNote = try note(templatePath) else {
        throw PeriodicNoteError.templateNotDownloaded(templatePath)
      }
      content = NoteTemplate.render(
        templateNote.content,
        context: .init(title: VaultPath.stem(path), date: date, now: now), timeZone: timeZone)
    }
    return try create(path: path, content: content)
  }
}
