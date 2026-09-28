import DailyDoListDomain
import DailyDoListMobileKit
import DailyDoListModels
import Foundation

extension PhoneWorkspace {
  func goBack() async {
    if let path = tabs.popBack() { await open(path, recordHistory: false) }
  }

  func goForward() async {
    if let path = tabs.popForward() { await open(path, recordHistory: false) }
  }

  func closeNote(_ path: String) async {
    defer { scheduleNavigationSave() }
    drawingSessions[path]?.controller.finishEditing()
    await drawingSessions[path]?.checkpoint()
    sessions[path]?.finishComposition()
    await sessions[path]?.checkpoint()
    guard sessions[path]?.hasUncheckpointedEdits != true,
      drawingSessions[path]?.hasUncheckpointedEdits != true
    else {
      error = "This note still has unsaved changes. Keep it open until it can be saved."
      return
    }
    if let session = sessions[path] {
      savedPositions[path] = WorkspaceNavigation.Position(
        selection: session.editor.selection,
        scrollY: session.editor.input.contentOffset.y)
    }
    sessions[path] = nil
    // Inline canvases may still use a drawing after its standalone tab closes.
    if sessions.isEmpty { drawingSessions[path] = nil }
    if let next = tabs.close(path) {
      await open(next, recordHistory: false)
    } else {
      active = nil
      activeDrawing = nil
    }
  }

  /// Releases note editors no tab shows anymore, once they're saved: each holds a text system,
  /// and live paths are protected from cache cleanup. An editor whose save failed (or is still
  /// composing) stays. Back/Forward restore the caret and scroll from `savedPositions`. Inline
  /// drawings keep their own `drawingSessions`, which this leaves alone.
  func releaseHiddenEditors() async {
    func hidden(_ path: String) -> Bool { !tabs.tabs.contains(path) && active?.note.path != path }
    for (path, session) in sessions where hidden(path) {
      await session.checkpoint()
      guard hidden(path), sessions[path] === session, !session.hasUncheckpointedEdits else {
        continue
      }
      savedPositions[path] = WorkspaceNavigation.Position(
        selection: session.editor.selection,
        scrollY: session.editor.input.contentOffset.y)
      sessions[path] = nil
    }
  }

  func reopenNote() async {
    if let closed = tabs.popClosedTab() {
      tabs.reinsert(closed)
      await open(closed.path, recordHistory: false)
    }
  }

  func revealLine(_ line: Int) {
    guard let editor = active?.editor else { return }
    let text = editor.text as NSString
    var offset = 0
    for _ in 0..<max(0, line) {
      guard offset < text.length else { break }
      offset = NSMaxRange(text.lineRange(for: NSRange(location: offset, length: 0)))
    }
    editor.selection = NSRange(location: min(offset, text.length), length: 0)
    editor.input.scrollRangeToVisible(editor.selection)
  }

  func openDaily(_ date: LocalDate) async {
    guard !structuralBusy else { return }
    let epoch = generation
    if let settings,
      let cached = try? await repository.note(
        DailyNotes.checkedPath(for: date, settings: settings.dailyNotes))
    {
      await open(cached.path)
      return
    }
    if let client, online {
      do {
        let daily = try await client.dailyNote(date.isoString, create: true)
        guard epoch == generation else { return }
        _ = try await repository.cache(
          RemoteNote(content: daily.content, version: daily.version), path: daily.path)
        guard epoch == generation else { return }
        if date == LocalDate(date: Date(), timeZone: .current) { agent?.todayNotePath = daily.path }
        await open(daily.path)
        await refreshTree()
      } catch { if epoch == generation { self.error = error.localizedDescription } }
    } else {
      await createOfflinePeriodic(.daily, date: date)
    }
  }

  func openWeekly(_ date: LocalDate = LocalDate(date: Date(), timeZone: .current)) async {
    guard let settings else {
      error = "Reconnect to load weekly-note settings."
      return
    }
    do {
      let path = try DailyNotes.checkedWeeklyPath(for: date, settings: settings.weeklyNotes)
      if try await repository.note(path) != nil || entries.contains(where: { $0.path == path }) {
        await open(path)
        return
      }
      guard let remote, online else {
        await createOfflinePeriodic(.weekly, date: date)
        return
      }
      let epoch = generation
      let fresh = try await client?.settings()
      guard epoch == generation, let fresh else { return }
      self.settings = fresh
      let destination = try DailyNotes.checkedWeeklyPath(for: date, settings: fresh.weeklyNotes)
      var content = ""
      if let template = DailyNotes.templatePath(fresh.weeklyNotes.template),
        let note = try await remote.readNote(template)
      {
        content = NoteTemplate.render(
          note.content, context: .init(title: VaultPath.stem(destination), date: date))
      }
      guard epoch == generation else { return }
      let note = try await repository.create(path: destination, content: content)
      includeLocalNotes([note])
      show(note)
      tabs.place(note.path)
      scheduleNavigationSave()
      selectedTab = 0
      await synchronize()
    } catch { self.error = error.localizedDescription }
  }

  func createOfflinePeriodic(_ kind: PeriodicNoteKind, date: LocalDate) async {
    guard let settings else {
      error = "Reconnect to load daily and weekly note settings before creating these notes."
      return
    }
    do {
      let note = try await repository.createPeriodicNote(
        kind, date: date, settings: settings, knownPaths: Set(entries.map(\.path)),
        now: Date(), timeZone: .current)
      includeLocalNotes([note])
      await open(note.path)
    } catch { self.error = error.localizedDescription }
  }

  func downloadPeriodicTemplates() async {
    guard let settings, let remote, online else { return }
    let epoch = generation
    for template in Set([settings.dailyNotes.template, settings.weeklyNotes.template]) {
      guard let path = DailyNotes.templatePath(template), epoch == generation else { continue }
      await refresh(path, remote: remote)
    }
  }

  func openAdjacentDaily(_ direction: DailyNotes.Direction) async {
    guard let settings else { return }
    let date = DailyNotes.navigationAnchor(
      activePath: activePath, settings: settings.dailyNotes)
    if let target = DailyNotes.adjacent(
      paths: entries.map(\.path), from: date, direction: direction, settings: settings.dailyNotes)
    {
      await open(target.path)
    } else {
      error =
        direction == .previous ? "No earlier daily note exists." : "No later daily note exists."
    }
  }
}
