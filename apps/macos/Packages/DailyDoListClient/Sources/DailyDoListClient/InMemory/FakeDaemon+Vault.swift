import DailyDoListModels
import Foundation

/// REST semantics of the daemon's vault, daily-note, search and settings routes.
extension FakeDaemon {
  static let maxNoteCharacters = 5 * 1024 * 1024

  static func internalError() -> DaemonClientError {
    .http(status: 500, body: ApiErrorBody(error: .internalError, message: "Internal server error"))
  }

  static func invalidSettings(_ message: String) -> DaemonClientError {
    .http(status: 400, body: ApiErrorBody(error: .invalidSettings, message: message))
  }

  static func noteResponse(_ path: String, _ file: FakeVault.File) -> NoteResponse {
    NoteResponse(path: path, content: file.content, version: file.version, mtime: file.mtime)
  }

  func health() -> HealthResponse {
    HealthResponse(
      version: Self.serverVersion, apiVersion: DaemonProtocol.apiVersion, vaultName: vaultName,
      agentMode: simulation == .enabled ? .mock : .off)
  }

  func tree() -> VaultTreeResponse {
    VaultTreeResponse(vaultName: vaultName, entries: vault.entries())
  }

  func readNote(_ input: String) throws(DaemonClientError) -> NoteResponse {
    let path = try FakeVaultPaths.resolveNotePath(input)
    guard let file = vault.file(path) else { throw .notFound("No note at \"\(path)\"") }
    return Self.noteResponse(path, file)
  }

  func writeNote(_ input: String, content: String, baseVersion: BaseVersion)
    throws(DaemonClientError) -> WriteNoteResponse
  {
    let path = try FakeVaultPaths.resolveNotePath(input)
    guard content.utf16.count <= Self.maxNoteCharacters else {
      throw .invalidRequest(
        "✖ Too big: expected string to have <=\(Self.maxNoteCharacters) characters\n  → at content")
    }
    if case .match(let version) = baseVersion, version.isEmpty || version.utf16.count > 256 {
      throw .invalidRequest("✖ Invalid baseVersion\n  → at baseVersion")
    }
    let result: (file: FakeVault.File, created: Bool)
    do {
      result = try vault.write(path, content, base: baseVersion, mtime: nowMillis)
    } catch .conflict(let current) {
      throw .conflict(ConflictResponse(current: current.map { Self.noteResponse(path, $0) }))
    } catch {
      throw Self.internalError()
    }
    emitVaultChange(
      [
        VaultChange(
          path: path, kind: result.created ? .created : .modified, version: result.file.version)
      ], origin: .client)
    observeNote(path, content: content)
    return WriteNoteResponse(path: path, version: result.file.version, mtime: result.file.mtime)
  }

  func deleteNote(_ input: String) throws(DaemonClientError) -> TrashResponse {
    let path = try FakeVaultPaths.resolveNotePath(input)
    guard vault.file(path) != nil else { throw .notFound("No note at \"\(path)\"") }
    let move: FakeVault.Move
    do {
      move = try vault.trashNote(path, stamp: trashStamp)
    } catch {
      throw Self.internalError()
    }
    emitVaultChange([VaultChange(path: path, kind: .deleted)], origin: .client)
    forgetNote(path)
    return TrashResponse(trashedTo: move.to)
  }

  func rename(from: String, to: String) throws(DaemonClientError) -> RenameResponse {
    let folder = try FakeVaultPaths.resolveVaultPath(from)
    if vault.isFolder(folder) {
      let target = try FakeVaultPaths.resolveVaultPath(to)
      if folder == target { throw .invalidRequest("Source and target are the same") }
      let moves: [FakeVault.Move]
      do {
        moves = try vault.renameFolder(folder, to: target)
      } catch .targetExists {
        throw .http(
          status: 409, body: ApiErrorBody(error: .conflict, message: "\"\(target)\" already exists")
        )
      } catch {
        throw .http(
          status: 409,
          body: ApiErrorBody(
            error: .conflict, message: "\"\(target)\" already exists or is inside \"\(folder)\""))
      }
      emitMoves(moves)
      return .folder(FolderRenameResponse(path: target, moved: moves.count))
    }
    let source = try FakeVaultPaths.resolveNotePath(from)
    let target = try FakeVaultPaths.resolveNotePath(to)
    if source == target { throw .invalidRequest("Source and target are the same") }
    let file: FakeVault.File
    do {
      file = try vault.rename(source, to: target)
    } catch .notFound {
      throw .notFound("No note at \"\(source)\"")
    } catch .conflict(let current) {
      throw .conflict(ConflictResponse(current: current.map { Self.noteResponse(target, $0) }))
    } catch {
      throw Self.internalError()
    }
    emitMoves([FakeVault.Move(from: source, to: target, version: file.version)])
    return .note(WriteNoteResponse(path: target, version: file.version, mtime: file.mtime))
  }

  func createFolder(_ input: String) throws(DaemonClientError) -> CreateFolderResponse {
    let path = try FakeVaultPaths.resolveVaultPath(input)
    do {
      try vault.createFolder(path)
    } catch {
      throw Self.internalError()
    }
    return CreateFolderResponse(path: path)
  }

  func deleteFolder(_ input: String) throws(DaemonClientError) -> TrashResponse {
    let path = try FakeVaultPaths.resolveVaultPath(input)
    guard vault.isFolder(path) else { throw .notFound("No folder at \"\(path)\"") }
    let result: (moves: [FakeVault.Move], trashedTo: String)
    do {
      result = try vault.trashFolder(path, stamp: trashStamp)
    } catch {
      throw Self.internalError()
    }
    emitVaultChange(
      result.moves.map { VaultChange(path: $0.from, kind: .deleted) }, origin: .client)
    for move in result.moves { forgetNote(move.from) }
    return TrashResponse(trashedTo: result.trashedTo)
  }

  func dailyNote(_ dateParameter: String, create: Bool) throws(DaemonClientError)
    -> DailyNoteResponse
  {
    let date: LocalDate
    if dateParameter == "today" {
      date = today
    } else if let parsed = LocalDate(iso: dateParameter) {
      date = parsed
    } else {
      throw .invalidRequest("Date must be \"today\" or YYYY-MM-DD")
    }
    let path: String
    do {
      path = try calendar.dailyNotePath(date, settings.dailyNotes)
    } catch {
      throw Self.invalidSettings("Invalid daily note settings: the path escapes the vault root")
    }
    if path.isEmpty || FakeVaultPaths.isHidden(path) {
      throw Self.invalidSettings("Daily notes are configured in a hidden folder")
    }
    if let existing = vault.file(path) {
      return DailyNoteResponse(
        path: path, content: existing.content, version: existing.version, mtime: existing.mtime,
        date: date.iso,
        created: false)
    }
    guard create else { throw .notFound("No daily note for \(date.iso)") }
    let content = renderDailyNote(path, date: date)
    let (file, _) = vault.store(path, content, mtime: nowMillis)
    emitVaultChange(
      [VaultChange(path: path, kind: .created, version: file.version)], origin: .client)
    observeNote(path, content: content)
    return DailyNoteResponse(
      path: path, content: content, version: file.version, mtime: file.mtime, date: date.iso,
      created: true)
  }

  /// The template rendered for `date`, or `- [ ] ` without a (readable) template.
  func renderDailyNote(_ path: String, date: LocalDate) -> String {
    guard let templatePath = try? FakeCalendar.templateNotePath(settings.dailyNotes.template),
      !FakeVaultPaths.isSidecar(templatePath), let template = vault.file(templatePath)
    else { return FakeCalendar.defaultDailyNoteContent }
    return calendar.renderTemplate(
      template.content, title: FakeVaultPaths.stem(path), date: date, now: now)
  }

  func search(_ query: String, limit: Int?) throws(DaemonClientError) -> SearchResponse {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.utf16.count > 500 {
      throw .invalidRequest("✖ Too big: expected string to have <=500 characters\n  → at q")
    }
    if let limit, limit < 1 { throw .invalidRequest("✖ must be a positive integer\n  → at limit") }
    let max = min(limit ?? 50, 200)
    return SearchResponse(
      hits: FakeVaultSearch.search(trimmed, in: vault.searchableNotes, limit: max))
  }

  func updateSettings(_ patch: SettingsPatch) throws(DaemonClientError) -> AppSettings {
    let validated = try FakeSettings.validate(patch)
    let next = settings.applying(validated)
    let problems = FakeSettings.pathProblems(
      next, touched: validated, today: today, calendar: calendar)
    if !problems.isEmpty { throw .invalidRequest(problems.joined(separator: "; ")) }
    let agentChanged = next.agent != settings.agent
    let disabled = settings.agent.enabled && !next.agent.enabled
    settings = next
    if disabled { settleTokens = settleTokens.mapValues { $0 + 1 } }
    emit(.settingsChanged(next))
    if agentChanged { emitStatus() }
    return next
  }

  func setAgentEnabled(_ enabled: Bool) throws(DaemonClientError) -> AgentStatusResponse {
    _ = try updateSettings(SettingsPatch(agent: .init(enabled: enabled)))
    return status()
  }

  /// Writes as another program would (origin `external`); `nil` deletes.
  func simulateExternalEdit(_ input: String, content: String?) throws(DaemonClientError) {
    let path: String
    do {
      path = try FakeVaultPaths.normalize(input)
    } catch {
      throw .invalidPath("Invalid vault path \"\(input)\"")
    }
    guard !path.isEmpty else { throw .invalidPath("Path is empty") }
    guard let content else {
      guard vault.file(path) != nil else { return }
      vault.removeFile(path)
      emitVaultChange([VaultChange(path: path, kind: .deleted)], origin: .external)
      forgetNote(path)
      return
    }
    let (file, created) = vault.store(path, content, mtime: nowMillis)
    emitVaultChange(
      [VaultChange(path: path, kind: created ? .created : .modified, version: file.version)],
      origin: .external)
    observeNote(path, content: content)
  }

  /// `YYYY-MM-DD HHmmss` of now, local time: the suffix of colliding trash names.
  var trashStamp: String { calendar.format(now, "YYYY-MM-DD HHmmss") }

  private func emitMoves(_ moves: [FakeVault.Move]) {
    var changes: [VaultChange] = []
    for move in moves {
      changes.append(VaultChange(path: move.from, kind: .deleted))
      changes.append(VaultChange(path: move.to, kind: .created, version: move.version))
    }
    emitVaultChange(changes, origin: .client)
    for move in moves { renameNote(from: move.from, to: move.to) }
  }
}
