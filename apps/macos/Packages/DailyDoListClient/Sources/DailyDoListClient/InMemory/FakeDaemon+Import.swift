import DailyDoListDomain
import DailyDoListModels
import Foundation

/// Importing from Obsidian and switching vaults, like the daemon's `/api/device/vault` and
/// `/api/import/obsidian*` (and the web mock): two synthetic folders under a pretend home (an
/// Obsidian vault and a plain folder), jobs that progress on the virtual timeline with
/// `import.progress` events, and a switch that answers like a supervised daemon's.
extension FakeDaemon {
  static let fakeHome = "/Users/me"
  static let fakeObsidianVault = "/Users/me/Obsidian Notebook"
  static let fakePlainFolder = "/Users/me/Plain notes"
  static let importStepMillis: Double = 250

  private static let ddlHome = "/Users/me/.daily-do-list"
  private static let obsidianDaily = DailyNoteSettings(
    folder: "Journal/Daily", format: "YYYY/MM/YYYY-MM-DD", template: "Templates/Daily.md")
  private static let obsidianTotals = (files: 64, bytes: 3_482_112)
  private static let plainTotals = (files: 12, bytes: 48_640)
  /// Notes the Obsidian vault has too: carried over as `Name (Daily Do List).md`.
  private static let obsidianNotes: Set<String> = ["Ideas.md", "Projects/Garden.md"]
  private static let copySteps = 6

  // MARK: - Routes

  func deviceVault() throws(DaemonClientError) -> DeviceVaultResponse {
    try thisMachineOnly()
    return DeviceVaultResponse(path: imports.vaultPath, lockedByEnv: imports.lockedByEnv)
  }

  func switchVault(_ request: DeviceVaultRequest) throws(DaemonClientError) -> DeviceVaultResponse {
    try thisMachineOnly()
    if imports.lockedByEnv {
      throw .http(
        status: 409,
        body: ApiErrorBody(
          error: .lockedByEnv,
          message: "DDL_VAULT sets the vault this daemon opens; change it there"
        ))
    }
    let path = try expand(request.path, what: "vault")
    guard folderExists(path) else { throw .invalidRequest("There's no folder at \(request.path)") }
    if overlaps(path, Self.ddlHome) {
      throw .invalidRequest("A vault can't be in or hold Daily Do List's own folder")
    }
    if path == imports.vaultPath { return try deviceVault() }
    if imports.job?.state == .running {
      throw conflict("An import from Obsidian is running; wait for it or cancel it")
    }
    if remote.syncs {
      throw conflict(
        "This device syncs its vault: turn sync off before switching vaults, or the old notes sync into the new one"
      )
    }
    imports.vaultPath = path
    imports.job = nil
    return DeviceVaultResponse(path: path, lockedByEnv: false, restart: .supervisor)
  }

  func previewObsidianImport(_ request: ObsidianImportPreviewRequest) throws(DaemonClientError)
    -> ObsidianImportPreview
  {
    try thisMachineOnly()
    let source = try resolveSource(request.source)
    let obsidian = source == Self.fakeObsidianVault
    let plan = carryOver(obsidian: obsidian)
    var warnings: [String] = []
    if !obsidian {
      warnings.append(
        "This folder has no .obsidian folder: it's copied as a plain folder of notes.")
    }
    if remote.syncs {
      warnings.append(
        "This device syncs its vault: turn sync off before switching to the new vault, or the old notes sync back into it."
      )
    }
    if plan.collisions.count == 1 {
      warnings.append(
        "1 file has the same name as one in the Obsidian vault and gets \"(Daily Do List)\" added; links to it lead to the Obsidian one."
      )
    } else if plan.collisions.count > 1 {
      warnings.append(
        "\(plan.collisions.count) files have the same names as ones in the Obsidian vault and get \"(Daily Do List)\" added; links to them lead to the Obsidian ones."
      )
    }
    let totals = obsidian ? Self.obsidianTotals : Self.plainTotals
    return ObsidianImportPreview(
      source: source, defaultDestination: try defaultDestination(source),
      isObsidianVault: obsidian, files: totals.files, bytes: totals.bytes,
      notes: obsidian ? 41 : 11, folders: obsidian ? 9 : 2,
      attachments: obsidian
        ? AttachmentSummary(
          count: 14, bytes: 3_180_000,
          byType: [
            AttachmentTypeSummary(type: .image, count: 11, bytes: 2_900_000),
            AttachmentTypeSummary(type: .pdf, count: 2, bytes: 260_000),
            AttachmentTypeSummary(type: .other, count: 1, bytes: 20_000),
          ])
        : AttachmentSummary(
          count: 1, bytes: 12_000,
          byType: [AttachmentTypeSummary(type: .image, count: 1, bytes: 12_000)]),
      settings: obsidian
        ? ObsidianSettingsFound(
          files: [
            ".obsidian.vimrc", ".obsidian/app.json", ".obsidian/appearance.json",
            ".obsidian/daily-notes.json",
          ],
          dailyNotes: Self.obsidianDaily,
          editor: ObsidianEditorSettings(
            vimMode: true, readableLineLength: true, showLineNumbers: false),
          vimrc: true, theme: .dark)
        : ObsidianSettingsFound(
          files: [], dailyNotes: nil, editor: ObsidianEditorSettings(), vimrc: false),
      templates: ObsidianTemplates(folder: obsidian ? "Templates" : nil, count: obsidian ? 3 : 0),
      plugins: obsidian ? Self.obsidianPlugins : [],
      canvases: obsidian
        ? ImportPathList(count: 2, paths: ["Projects/Garden plan.canvas", "Projects/Trip.canvas"])
        : .empty,
      drawings: obsidian
        ? ImportPathList(count: 1, paths: ["Drawings/Kitchen layout.excalidraw.md"]) : .empty,
      skipped: obsidian
        ? ImportSkippedList(
          count: 1,
          items: [ImportSkipped(path: "Attachments/Holiday video.mov", reason: .symlinkOutside)])
        : ImportSkippedList(count: 0, items: []),
      carryOver: plan, warnings: warnings)
  }

  func obsidianImportStatus() throws(DaemonClientError) -> ObsidianImportStatusResponse {
    try thisMachineOnly()
    return ObsidianImportStatusResponse(
      job: imports.job, imported: imports.origins[imports.vaultPath])
  }

  func startObsidianImport(_ request: ObsidianImportRequest) throws(DaemonClientError)
    -> ObsidianImportJob
  {
    try thisMachineOnly()
    try assertIdle()
    let source = try resolveSource(request.source)
    let destination: String
    if let input = request.destination {
      destination = try resolveDestination(input, source: source)
    } else {
      destination = try defaultDestination(source)
    }
    let job = ObsidianImportJob(
      id: nextID("imp"), kind: .import, state: .running, phase: .checking, source: source,
      destination: destination, startedAt: Int(nowMillis),
      progress: ObsidianImportProgress(files: 0, totalFiles: 0, bytes: 0, totalBytes: 0))
    startJob(job)
    return job
  }

  func cancelObsidianImport() throws(DaemonClientError) -> ObsidianImportJob {
    try thisMachineOnly()
    guard var job = imports.job, job.state == .running else {
      throw .notFound("No import or update is running")
    }
    job.state = .cancelled
    job.finishedAt = Int(nowMillis)
    imports.job = job
    imports.generation += 1
    emit(.importProgress(job))
    return job
  }

  func updateFromObsidian() throws(DaemonClientError) -> ObsidianImportJob {
    try thisMachineOnly()
    try assertIdle()
    guard let origin = imports.origins[imports.vaultPath] else {
      throw .notFound("This vault wasn't imported from Obsidian")
    }
    guard folderExists(origin.source) else {
      throw .notFound("The Obsidian vault isn't at \(origin.source) any more")
    }
    let job = ObsidianImportJob(
      id: nextID("imp"), kind: .update, state: .running, phase: .checking, source: origin.source,
      destination: imports.vaultPath, startedAt: Int(nowMillis),
      progress: ObsidianImportProgress(files: 0, totalFiles: 0, bytes: 0, totalBytes: 0))
    startJob(job)
    return job
  }

  // MARK: - Simulation

  func simulateImportSetting(pairedDevice: Bool?, lockedByEnv: Bool?) {
    if let pairedDevice { imports.pairedDevice = pairedDevice }
    if let lockedByEnv { imports.lockedByEnv = lockedByEnv }
  }

  // MARK: - Jobs

  private func startJob(_ job: ObsidianImportJob) {
    imports.job = job
    imports.generation += 1
    emit(.importProgress(job))
    schedule(
      .importStep(generation: imports.generation, step: 0), after: Self.importStepMillis)
  }

  /// One step of the running job: its phases, then the outcome.
  func runImportStep(generation: Int, step: Int) {
    guard generation == imports.generation, var job = imports.job, job.state == .running else {
      return
    }
    let last =
      job.kind == .import ? advanceImport(&job, step: step) : advanceUpdate(&job, step: step)
    imports.job = job
    emit(.importProgress(job))
    if !last {
      schedule(.importStep(generation: generation, step: step + 1), after: Self.importStepMillis)
    }
  }

  /// True once the job is done.
  private func advanceImport(_ job: inout ObsidianImportJob, step: Int) -> Bool {
    let obsidian = job.source == Self.fakeObsidianVault
    let totals = obsidian ? Self.obsidianTotals : Self.plainTotals
    let plan = carryOver(obsidian: obsidian)
    let moves = plan.notes.count + plan.daily.count
    switch step {
    case 0:
      job.phase = .copying
      job.progress.totalFiles = totals.files + moves
      job.progress.totalBytes = totals.bytes + moves * 400
    case 1...Self.copySteps:
      job.progress.files = totals.files * step / Self.copySteps
      job.progress.bytes = totals.bytes * step / Self.copySteps
    case Self.copySteps + 1:
      job.phase = .carryingOver
      job.progress.files += moves
      job.progress.bytes += moves * 400
    case Self.copySteps + 2:
      job.phase = .finishing
    default:
      job.state = .done
      job.finishedAt = Int(nowMillis)
      job.result = ObsidianImportResult(
        copied: ObsidianImportCopied(files: totals.files, bytes: totals.bytes),
        skipped: ImportSkippedList(count: 0, items: []), carryOver: plan,
        manifest: ".daily-do-list/import/obsidian.json")
      imports.folders.insert(job.destination)
      imports.origins[job.destination] = ObsidianImportOrigin(
        source: job.source, importedAt: job.startedAt, previousVault: imports.vaultPath)
      return true
    }
    return false
  }

  private func advanceUpdate(_ job: inout ObsidianImportJob, step: Int) -> Bool {
    let phoneNote = "Journal/Phone notes.md"
    switch step {
    case 0:
      job.phase = .copying
      job.progress = ObsidianImportProgress(files: 0, totalFiles: 3, bytes: 0, totalBytes: 1_200)
    case 1:
      job.progress.files = 3
      job.progress.bytes = 1_200
      try? simulateExternalEdit(phoneNote, content: "Written on my phone: ideas for the garden.\n")
    default:
      job.state = .done
      job.phase = .finishing
      job.finishedAt = Int(nowMillis)
      job.update = ObsidianUpdateReport(
        added: ImportPathList(count: 1, paths: [phoneNote]),
        updated: ImportPathList(count: 1, paths: ["Projects/Garden.md"]),
        restored: .empty,
        conflicts: ImportMoveList(
          count: 1, items: [ImportMove(from: "Ideas.md", to: "Ideas (Obsidian).md")]),
        deletedInSource: .empty, unchanged: Self.obsidianTotals.files - 2,
        skipped: ImportSkippedList(count: 0, items: []))
      imports.origins[imports.vaultPath]?.updatedAt = Int(nowMillis)
      return true
    }
    return false
  }

  // MARK: - Places

  private func thisMachineOnly() throws(DaemonClientError) {
    guard imports.pairedDevice else { return }
    throw .http(
      status: 403,
      body: ApiErrorBody(
        error: .forbiddenDevice,
        message: "Only this machine can import vaults or switch them, not a paired device"))
  }

  private func assertIdle() throws(DaemonClientError) {
    if imports.job?.state == .running { throw conflict("An import or update is already running") }
  }

  private func conflict(_ message: String) -> DaemonClientError {
    .http(status: 409, body: ApiErrorBody(error: .conflict, message: message))
  }

  private func folderExists(_ path: String) -> Bool {
    [Self.fakeHome, Self.ddlHome, Self.fakeObsidianVault, Self.fakePlainFolder, imports.vaultPath]
      .contains(path) || imports.folders.contains(path)
  }

  private func expand(_ input: String, what: String) throws(DaemonClientError) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespaces)
    var path: String
    if trimmed == "~" {
      path = Self.fakeHome
    } else if trimmed.hasPrefix("~/") {
      path = Self.fakeHome + "/" + trimmed.dropFirst(2)
    } else if trimmed.hasPrefix("/") {
      path = trimmed
    } else {
      throw .invalidRequest("The \(what) must be an absolute path (or start with ~/)")
    }
    while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    return path
  }

  private func resolveSource(_ input: String) throws(DaemonClientError) -> String {
    let source = try expand(input, what: "Obsidian vault")
    guard folderExists(source) else {
      throw .invalidRequest(
        "There's no folder at \(input.trimmingCharacters(in: .whitespaces))")
    }
    if overlaps(source, Self.ddlHome) {
      throw .invalidRequest("The Obsidian vault can't be in or hold Daily Do List's own folder")
    }
    if overlaps(source, imports.vaultPath) {
      throw .invalidRequest(
        "The Obsidian vault can't be in or hold the current Daily Do List vault")
    }
    return source
  }

  private func destinationProblem(_ path: String, source: String) -> String? {
    if !folderExists(parent(path)) { return "The folder that would hold \(path) doesn't exist" }
    if isInside(path, source) { return "The new vault can't be inside the Obsidian vault" }
    if isInside(path, Self.ddlHome) {
      return "The new vault can't be inside Daily Do List's own folder"
    }
    if isInside(path, imports.vaultPath) {
      return "The new vault can't be inside the current vault"
    }
    if folderExists(path) { return "\(path) isn't empty" }
    return nil
  }

  private func resolveDestination(_ input: String, source: String) throws(DaemonClientError)
    -> String
  {
    let path = try expand(input, what: "destination")
    if let problem = destinationProblem(path, source: source) { throw .invalidRequest(problem) }
    return path
  }

  private func defaultDestination(_ source: String) throws(DaemonClientError) -> String {
    let name = String(source.split(separator: "/").last ?? "")
    for n in 0...100 {
      let label = n == 0 ? name : "\(name) (Daily Do List\(n > 1 ? " \(n)" : ""))"
      let candidate = parent(imports.vaultPath) + "/" + label
      if destinationProblem(candidate, source: source) == nil { return candidate }
    }
    throw .invalidRequest("Choose a destination folder for the new vault")
  }

  private func parent(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
    return String(path[..<slash])
  }

  private func isInside(_ path: String, _ folder: String) -> Bool {
    path == folder || path.hasPrefix(folder + "/")
  }

  private func overlaps(_ a: String, _ b: String) -> Bool { isInside(a, b) || isInside(b, a) }

  // MARK: - The carry-over plan

  private func carryOver(obsidian: Bool) -> CarryOverPlan {
    let current = settings.dailyNotes
    let target = obsidian ? Self.obsidianDaily : current
    let yesterday = today.adding(days: -1).iso
    var daily: [CarryOverDailyNote] = []
    var notes: [ImportMove] = []
    var collisions: [ImportMove] = []
    for path in vault.files.keys.sorted() where !FakeVaultPaths.isHidden(path) {
      if let date = DailyNotes.date(forPath: path, settings: current) {
        daily.append(
          CarryOverDailyNote(
            date: date.isoString, from: path,
            to: DailyNotes.path(for: date, settings: target, timeZone: calendar.timeZone),
            merged: obsidian && date.isoString == yesterday))
        continue
      }
      let to =
        obsidian && Self.obsidianNotes.contains(path)
        ? String(path.dropLast(3)) + " (Daily Do List).md" : path
      notes.append(ImportMove(from: path, to: to))
      if to != path { collisions.append(ImportMove(from: path, to: to)) }
    }
    let threadCount = self.threads.count
    return CarryOverPlan(
      vault: imports.vaultPath, dailyNotes: target,
      dailyNotesFrom: obsidian ? .obsidian : .dailyDoList,
      notes: ImportMoveList(count: notes.count, items: Array(notes.prefix(200))),
      daily: CarryOverDaily(
        count: daily.count, merged: daily.filter(\.merged).count, items: Array(daily.prefix(200))),
      collisions: ImportMoveList(count: collisions.count, items: collisions),
      routines: notes.filter { $0.from.hasPrefix("Routines/") }.count,
      drawings: notes.filter { $0.from.hasSuffix(".excalidraw.md") }.count,
      agent: CarryOverAgent(
        threads: threadCount, detached: threadCount > 0 ? 1 : 0, records: records.count,
        approvals: approvals.count, routines: routineStates.count, trackedNotes: daily.count,
        journal: 0),
      watchedOpenTasks: obsidian ? 3 : 0, actOnExistingTasks: settings.agent.actOnExistingTasks,
      leftBehind: .empty)
  }

  private static let obsidianPlugins = [
    ObsidianPlugin(
      id: "dataview", name: "Dataview", support: .partial, note: "Queries show as text."),
    ObsidianPlugin(
      id: "obsidian-excalidraw-plugin", name: "Excalidraw", support: .supported,
      note: "Drawings open and edit here."),
    ObsidianPlugin(
      id: "obsidian-kanban", name: "Kanban", support: .unsupported,
      note: "Boards show as their markdown lists."),
    ObsidianPlugin(
      id: "obsidian-tasks-plugin", name: "Tasks", support: .partial,
      note: "Task lines work; query blocks show as text."),
    ObsidianPlugin(
      id: "word-sprint", name: "Word Sprint", support: .unknown,
      note: "Doesn't run here; its files are kept and it still works in Obsidian."),
  ]
}

/// The fake's vault location, the vaults it imported, and the running or last job.
struct FakeImports: Sendable {
  var vaultPath: String
  /// Folders made by imports (the new vaults).
  var folders: Set<String> = []
  /// Where each imported vault came from.
  var origins: [String: ObsidianImportOrigin] = [:]
  var job: ObsidianImportJob?
  /// Bumped by every job start and cancel: steps of an older job do nothing.
  var generation = 0
  /// Simulation: this client is a paired device, `DDL_VAULT` fixes the vault.
  var pairedDevice = false
  var lockedByEnv = false

  init(vaultName: String) {
    vaultPath = FakeDaemon.fakeHome + "/" + vaultName
  }
}
