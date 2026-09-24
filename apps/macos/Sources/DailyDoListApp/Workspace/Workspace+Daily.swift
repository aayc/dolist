import DailyDoListDomain
import DailyDoListModels
import Foundation

extension Workspace {
  var today: LocalDate { LocalDate.today(now: now()) }

  /// Date of the active note when it is a daily note.
  var activeDailyDate: LocalDate? {
    activePath.flatMap { DailyNotes.date(forPath: $0, settings: settings.settings.dailyNotes) }
  }

  func openToday() async {
    await openDaily(today)
  }

  func openTomorrow() async {
    await openDaily(today.adding(days: 1))
  }

  /// Opens (creating from the template if needed — the daemon does that) the daily note for `date`.
  func openDaily(_ date: LocalDate) async {
    let path = DailyNotes.path(for: date, settings: settings.settings.dailyNotes)
    if notes.has(path) {
      _ = beginNavigation(nil)
      activate(path)
      return
    }
    let token = beginNavigation(path)
    do {
      let note = try await client.dailyNote(date.isoString, create: true)
      guard token == navToken else { return }
      endNavigation(token)
      adoptDaily(note)
      activate(note.path)
    } catch {
      endNavigation(token)
      toasts.error("Couldn't open the daily note", error)
    }
  }

  func adoptDaily(_ note: DailyNoteResponse) {
    notes.adopt(note.note)
    vault.addFile(note.path, version: note.version)
  }

  /// Obsidian's previous/next daily note: the nearest EXISTING note before/after the active daily
  /// note (or today). Repeated presses continue from the note still loading.
  @discardableResult
  func openAdjacentDaily(_ direction: DailyNotes.Direction) async -> Bool {
    guard let target = adjacentDailyPath(direction, from: navTarget ?? activePath) else {
      toasts.show(.info, direction == .previous ? "No previous daily note" : "No next daily note", timeout: 2.5)
      return false
    }
    return await openNote(target)
  }

  /// Path of the nearest existing daily note in `direction` from `path`'s date (or today).
  func adjacentDailyPath(_ direction: DailyNotes.Direction, from path: String?) -> String? {
    let dailySettings = settings.settings.dailyNotes
    let anchor = DailyNotes.navigationAnchor(activePath: path, settings: dailySettings, now: now())
    return DailyNotes.adjacent(paths: vault.files, from: anchor, direction: direction, settings: dailySettings)?.path
  }

  /// This week's note (`weeklyNotes` settings): opens it, or creates it from the weekly template
  /// (when configured and present) with `baseVersion: null`.
  func openWeekly() async {
    let weekly = settings.settings.weeklyNotes
    let date = today
    let path = DailyNotes.weeklyPath(for: date, settings: weekly)
    if vault.isFile(path) || notes.has(path) {
      await openNote(path)
      return
    }
    var content = ""
    if let template = DailyNotes.templatePath(weekly.template), vault.isFile(template) {
      if let body = try? await client.readNote(template).content {
        content = NoteTemplate.render(body, context: NoteTemplate.Context(title: VaultPath.stem(path), date: date, now: now()))
      }
    }
    await createNote(at: path, content: content, newTab: false, focusTitle: false)
  }
}
