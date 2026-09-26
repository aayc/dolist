import Foundation

// Swift mirror of the vault switch and Obsidian import shapes of
// `packages/contract/src/wire/imports.ts`. Enums a newer daemon may extend are `WireEnum`s.

// MARK: - Switching vaults

/// How a daemon that exits to apply a change comes back: the Mac app's supervisor starts it again
/// (`supervisor`), or the user does (`manual`).
public struct DaemonRestart: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let supervisor: Self = "supervisor"
  public static let manual: Self = "manual"
}

/// `PUT /api/device/vault`: the vault the daemon should open.
public struct DeviceVaultRequest: Codable, Hashable, Sendable {
  /// An existing folder: absolute, or starting with `~/`.
  public var path: String

  public init(path: String) { self.path = path }
}

/// `GET`/`PUT /api/device/vault`: the vault the daemon opens.
public struct DeviceVaultResponse: Codable, Hashable, Sendable {
  /// The vault's folder (absolute).
  public var path: String
  /// `DDL_VAULT` sets it: switching answers 409 `locked_by_env`.
  public var lockedByEnv: Bool
  /// Set when switching: the daemon exits with `DaemonSupervisor.restartExitStatus` right after
  /// answering and opens the new vault when it starts again.
  public var restart: DaemonRestart?

  public init(path: String, lockedByEnv: Bool, restart: DaemonRestart? = nil) {
    self.path = path
    self.lockedByEnv = lockedByEnv
    self.restart = restart
  }
}

// MARK: - Report lists

/// Paths (vault-relative, sorted, at most 200); `count` is the full number.
public struct ImportPathList: Codable, Hashable, Sendable {
  public var count: Int
  public var paths: [String]

  public init(count: Int, paths: [String]) {
    self.count = count
    self.paths = paths
  }

  public static let empty = ImportPathList(count: 0, paths: [])
}

/// A file and where it goes.
public struct ImportMove: Codable, Hashable, Sendable {
  public var from: String
  public var to: String

  public init(from: String, to: String) {
    self.from = from
    self.to = to
  }
}

/// Moves sorted by `from` (at most 200); `count` is the full number.
public struct ImportMoveList: Codable, Hashable, Sendable {
  public var count: Int
  public var items: [ImportMove]

  public init(count: Int, items: [ImportMove]) {
    self.count = count
    self.items = items
  }
}

/// Why a file isn't copied.
public struct ImportSkipReason: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  /// A link to something outside the vault (never followed).
  public static let symlinkOutside: Self = "symlink_outside"
  /// A link to a folder inside the vault (its target is copied where it is).
  public static let symlinkFolder: Self = "symlink_folder"
  public static let specialFile: Self = "special_file"
  public static let unreadable: Self = "unreadable"
  /// The vault's own `.daily-do-list/` folder.
  public static let sidecar: Self = "sidecar"
}

public struct ImportSkipped: Codable, Hashable, Sendable {
  public var path: String
  public var reason: ImportSkipReason

  public init(path: String, reason: ImportSkipReason) {
    self.path = path
    self.reason = reason
  }
}

/// Files not copied, sorted by path (at most 200); `count` is the full number.
public struct ImportSkippedList: Codable, Hashable, Sendable {
  public var count: Int
  public var items: [ImportSkipped]

  public init(count: Int, items: [ImportSkipped]) {
    self.count = count
    self.items = items
  }
}

// MARK: - The preview report

public struct AttachmentType: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let image: Self = "image"
  public static let pdf: Self = "pdf"
  public static let audio: Self = "audio"
  public static let video: Self = "video"
  public static let other: Self = "other"
}

public struct AttachmentTypeSummary: Codable, Hashable, Sendable {
  public var type: AttachmentType
  public var count: Int
  public var bytes: Int

  public init(type: AttachmentType, count: Int, bytes: Int) {
    self.type = type
    self.count = count
    self.bytes = bytes
  }
}

/// Files other than notes, canvases and drawings, by type.
public struct AttachmentSummary: Codable, Hashable, Sendable {
  public var count: Int
  public var bytes: Int
  public var byType: [AttachmentTypeSummary]

  public init(count: Int, bytes: Int, byType: [AttachmentTypeSummary]) {
    self.count = count
    self.bytes = bytes
    self.byType = byType
  }
}

/// How an Obsidian community plugin fares here.
public struct ObsidianPluginSupport: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let supported: Self = "supported"
  public static let partial: Self = "partial"
  public static let unsupported: Self = "unsupported"
  public static let unknown: Self = "unknown"
}

/// An enabled community plugin.
public struct ObsidianPlugin: Codable, Hashable, Sendable {
  public var id: String
  /// From the plugin's manifest, when readable.
  public var name: String?
  public var support: ObsidianPluginSupport
  /// How it fares here, one sentence.
  public var note: String

  public init(id: String, name: String? = nil, support: ObsidianPluginSupport, note: String) {
    self.id = id
    self.name = name
    self.support = support
    self.note = note
  }
}

/// The editor preferences Obsidian's `app.json` holds that are imported.
public struct ObsidianEditorSettings: Codable, Hashable, Sendable {
  public var vimMode: Bool?
  public var livePreview: Bool?
  public var readableLineLength: Bool?
  public var showLineNumbers: Bool?
  public var spellcheck: Bool?

  public init(
    vimMode: Bool? = nil, livePreview: Bool? = nil, readableLineLength: Bool? = nil,
    showLineNumbers: Bool? = nil, spellcheck: Bool? = nil
  ) {
    self.vimMode = vimMode
    self.livePreview = livePreview
    self.readableLineLength = readableLineLength
    self.showLineNumbers = showLineNumbers
    self.spellcheck = spellcheck
  }
}

/// The settings found in the Obsidian vault's config, and what is imported from them.
public struct ObsidianSettingsFound: Codable, Hashable, Sendable {
  /// Config files found (`.obsidian/daily-notes.json`, `.obsidian.vimrc`, …).
  public var files: [String]
  /// Obsidian's daily notes (its defaults when the plugin is on without a config); nil when it
  /// keeps none.
  public var dailyNotes: DailyNoteSettings?
  public var editor: ObsidianEditorSettings
  /// A vimrc is imported with the editor settings.
  public var vimrc: Bool
  public var theme: ThemePreference?

  public init(
    files: [String], dailyNotes: DailyNoteSettings?, editor: ObsidianEditorSettings, vimrc: Bool,
    theme: ThemePreference? = nil
  ) {
    self.files = files
    self.dailyNotes = dailyNotes
    self.editor = editor
    self.vimrc = vimrc
    self.theme = theme
  }

  enum CodingKeys: String, CodingKey { case files, dailyNotes, editor, vimrc, theme }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(files, forKey: .files)
    // Required on the wire: null when Obsidian keeps no daily notes.
    try c.encode(dailyNotes, forKey: .dailyNotes)
    try c.encode(editor, forKey: .editor)
    try c.encode(vimrc, forKey: .vimrc)
    try c.encodeIfPresent(theme, forKey: .theme)
  }
}

public struct ObsidianTemplates: Codable, Hashable, Sendable {
  /// Core Templates' folder, else Templater's; nil when none is set.
  public var folder: String?
  public var count: Int

  public init(folder: String?, count: Int) {
    self.folder = folder
    self.count = count
  }

  enum CodingKeys: String, CodingKey { case folder, count }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    // Required on the wire: null when no templates folder is set.
    try c.encode(folder, forKey: .folder)
    try c.encode(count, forKey: .count)
  }
}

/// Where the new vault's daily-note settings come from.
public struct DailyNotesSource: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let obsidian: Self = "obsidian"
  public static let obsidianDefaults: Self = "obsidian_defaults"
  public static let dailyDoList: Self = "daily_do_list"
}

public struct CarryOverDailyNote: Codable, Hashable, Sendable {
  /// YYYY-MM-DD.
  public var date: String
  public var from: String
  public var to: String
  /// Obsidian has a note for this date: it's kept and this one appended under
  /// `## From Daily Do List`.
  public var merged: Bool

  public init(date: String, from: String, to: String, merged: Bool) {
    self.date = date
    self.from = from
    self.to = to
    self.merged = merged
  }
}

public struct CarryOverDaily: Codable, Hashable, Sendable {
  public var count: Int
  /// Dates Obsidian also has.
  public var merged: Int
  public var items: [CarryOverDailyNote]

  public init(count: Int, merged: Int, items: [CarryOverDailyNote]) {
    self.count = count
    self.merged = merged
    self.items = items
  }
}

public struct CarryOverAgent: Codable, Hashable, Sendable {
  public var threads: Int
  /// Threads whose task isn't in its note in the new vault: kept, marked detached.
  public var detached: Int
  public var records: Int
  public var approvals: Int
  public var routines: Int
  /// Daily notes whose task identities carry over.
  public var trackedNotes: Int
  /// Agent journal files; thread journals get the new note paths and routine ids.
  public var journal: Int

  public init(
    threads: Int, detached: Int, records: Int, approvals: Int, routines: Int, trackedNotes: Int,
    journal: Int
  ) {
    self.threads = threads
    self.detached = detached
    self.records = records
    self.approvals = approvals
    self.routines = routines
    self.trackedNotes = trackedNotes
    self.journal = journal
  }
}

/// What happens to the current vault's notes, routines, drawings and agent history.
public struct CarryOverPlan: Codable, Hashable, Sendable {
  /// The current vault: left untouched (it's the backup).
  public var vault: String
  /// The new vault's daily-note settings.
  public var dailyNotes: DailyNoteSettings
  public var dailyNotesFrom: DailyNotesSource
  /// Every other file: at the same path unless it collides.
  public var notes: ImportMoveList
  public var daily: CarryOverDaily
  /// Files renamed because the Obsidian vault has one at that path: `Name (Daily Do List).md`.
  public var collisions: ImportMoveList
  public var routines: Int
  public var drawings: Int
  public var agent: CarryOverAgent
  /// Open tasks in Obsidian's daily notes inside the agent's watch window; the agent acts on them
  /// after the switch only when `actOnExistingTasks` is on.
  public var watchedOpenTasks: Int
  public var actOnExistingTasks: Bool
  /// Hidden files and folders of the current vault that stay behind (other than the sidecar and
  /// `.trash/`), and links leading out of it.
  public var leftBehind: ImportPathList

  public init(
    vault: String, dailyNotes: DailyNoteSettings, dailyNotesFrom: DailyNotesSource,
    notes: ImportMoveList, daily: CarryOverDaily, collisions: ImportMoveList, routines: Int,
    drawings: Int, agent: CarryOverAgent, watchedOpenTasks: Int, actOnExistingTasks: Bool,
    leftBehind: ImportPathList
  ) {
    self.vault = vault
    self.dailyNotes = dailyNotes
    self.dailyNotesFrom = dailyNotesFrom
    self.notes = notes
    self.daily = daily
    self.collisions = collisions
    self.routines = routines
    self.drawings = drawings
    self.agent = agent
    self.watchedOpenTasks = watchedOpenTasks
    self.actOnExistingTasks = actOnExistingTasks
    self.leftBehind = leftBehind
  }
}

/// `POST /api/import/obsidian/preview`.
public struct ObsidianImportPreviewRequest: Codable, Hashable, Sendable {
  /// The Obsidian vault's folder: absolute or `~/…`. Only ever read.
  public var source: String

  public init(source: String) { self.source = source }
}

/// What importing the Obsidian vault would do, computed without writing anything.
public struct ObsidianImportPreview: Codable, Hashable, Sendable {
  /// The resolved source folder.
  public var source: String
  /// The suggested new vault: next to the current one, never inside the source.
  public var defaultDestination: String
  /// It has an `.obsidian/` folder.
  public var isObsidianVault: Bool
  /// Everything copied, `.obsidian/` and attachments included.
  public var files: Int
  public var bytes: Int
  /// Markdown notes outside hidden folders (drawings not included).
  public var notes: Int
  public var folders: Int
  public var attachments: AttachmentSummary
  public var settings: ObsidianSettingsFound
  public var templates: ObsidianTemplates
  /// Enabled community plugins.
  public var plugins: [ObsidianPlugin]
  /// Canvas files: copied, not viewable here yet.
  public var canvases: ImportPathList
  /// Excalidraw drawings (`*.excalidraw.md`).
  public var drawings: ImportPathList
  public var skipped: ImportSkippedList
  public var carryOver: CarryOverPlan
  /// Things to know first, one sentence each.
  public var warnings: [String]

  public init(
    source: String, defaultDestination: String, isObsidianVault: Bool, files: Int, bytes: Int,
    notes: Int, folders: Int, attachments: AttachmentSummary, settings: ObsidianSettingsFound,
    templates: ObsidianTemplates, plugins: [ObsidianPlugin], canvases: ImportPathList,
    drawings: ImportPathList, skipped: ImportSkippedList, carryOver: CarryOverPlan,
    warnings: [String]
  ) {
    self.source = source
    self.defaultDestination = defaultDestination
    self.isObsidianVault = isObsidianVault
    self.files = files
    self.bytes = bytes
    self.notes = notes
    self.folders = folders
    self.attachments = attachments
    self.settings = settings
    self.templates = templates
    self.plugins = plugins
    self.canvases = canvases
    self.drawings = drawings
    self.skipped = skipped
    self.carryOver = carryOver
    self.warnings = warnings
  }
}

// MARK: - Jobs

/// `POST /api/import/obsidian`.
public struct ObsidianImportRequest: Codable, Hashable, Sendable {
  public var source: String
  /// A new or empty folder, never inside the source; nil: the preview's `defaultDestination`.
  public var destination: String?

  public init(source: String, destination: String? = nil) {
    self.source = source
    self.destination = destination
  }
}

public struct ObsidianImportJobKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let `import`: Self = "import"
  public static let update: Self = "update"
}

public struct ObsidianImportJobState: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let running: Self = "running"
  public static let done: Self = "done"
  public static let failed: Self = "failed"
  public static let cancelled: Self = "cancelled"
}

public struct ObsidianImportPhase: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let checking: Self = "checking"
  public static let copying: Self = "copying"
  public static let carryingOver: Self = "carrying_over"
  public static let finishing: Self = "finishing"
}

public struct ObsidianImportProgress: Codable, Hashable, Sendable {
  public var files: Int
  public var totalFiles: Int
  public var bytes: Int
  public var totalBytes: Int

  public init(files: Int, totalFiles: Int, bytes: Int, totalBytes: Int) {
    self.files = files
    self.totalFiles = totalFiles
    self.bytes = bytes
    self.totalBytes = totalBytes
  }
}

public struct ObsidianImportCopied: Codable, Hashable, Sendable {
  public var files: Int
  public var bytes: Int

  public init(files: Int, bytes: Int) {
    self.files = files
    self.bytes = bytes
  }
}

/// What an import did.
public struct ObsidianImportResult: Codable, Hashable, Sendable {
  public var copied: ObsidianImportCopied
  public var skipped: ImportSkippedList
  public var carryOver: CarryOverPlan
  /// The manifest (`.daily-do-list/import/obsidian.json`).
  public var manifest: String

  public init(
    copied: ObsidianImportCopied, skipped: ImportSkippedList, carryOver: CarryOverPlan,
    manifest: String
  ) {
    self.copied = copied
    self.skipped = skipped
    self.carryOver = carryOver
    self.manifest = manifest
  }
}

/// What an update from Obsidian did. It never deletes.
public struct ObsidianUpdateReport: Codable, Hashable, Sendable {
  /// New in Obsidian: copied.
  public var added: ImportPathList
  /// Changed in Obsidian, unchanged here: replaced.
  public var updated: ImportPathList
  /// Changed in Obsidian after being deleted here: written back.
  public var restored: ImportPathList
  /// Changed on both sides: `from` is kept, the Obsidian version saved as `to`.
  public var conflicts: ImportMoveList
  /// Deleted in Obsidian: kept here.
  public var deletedInSource: ImportPathList
  public var unchanged: Int
  public var skipped: ImportSkippedList

  public init(
    added: ImportPathList, updated: ImportPathList, restored: ImportPathList,
    conflicts: ImportMoveList, deletedInSource: ImportPathList, unchanged: Int,
    skipped: ImportSkippedList
  ) {
    self.added = added
    self.updated = updated
    self.restored = restored
    self.conflicts = conflicts
    self.deletedInSource = deletedInSource
    self.unchanged = unchanged
    self.skipped = skipped
  }
}

/// An import or update from Obsidian: its phase, progress and outcome.
public struct ObsidianImportJob: Codable, Hashable, Sendable {
  public var id: String
  public var kind: ObsidianImportJobKind
  public var state: ObsidianImportJobState
  /// The current phase, or the last one reached.
  public var phase: ObsidianImportPhase
  public var source: String
  /// The new vault (`import`), or the vault being updated (`update`).
  public var destination: String
  public var startedAt: Int
  public var finishedAt: Int?
  public var progress: ObsidianImportProgress
  /// Why it failed.
  public var error: String?
  /// What an import did (`done`).
  public var result: ObsidianImportResult?
  /// What an update did (`done`).
  public var update: ObsidianUpdateReport?

  public init(
    id: String, kind: ObsidianImportJobKind, state: ObsidianImportJobState,
    phase: ObsidianImportPhase, source: String, destination: String, startedAt: Int,
    finishedAt: Int? = nil, progress: ObsidianImportProgress, error: String? = nil,
    result: ObsidianImportResult? = nil, update: ObsidianUpdateReport? = nil
  ) {
    self.id = id
    self.kind = kind
    self.state = state
    self.phase = phase
    self.source = source
    self.destination = destination
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.progress = progress
    self.error = error
    self.result = result
    self.update = update
  }
}

/// `POST /api/import/obsidian`, `…/cancel`, `…/update`: the job as it stands.
public struct ObsidianImportJobResponse: Codable, Hashable, Sendable {
  public var job: ObsidianImportJob

  public init(job: ObsidianImportJob) { self.job = job }
}

/// Where the vault the daemon serves was imported from (its import manifest).
public struct ObsidianImportOrigin: Codable, Hashable, Sendable {
  /// The Obsidian vault it was copied from (absolute).
  public var source: String
  public var importedAt: Int
  /// The last "Update from Obsidian".
  public var updatedAt: Int?
  /// The vault that was current at the import, left untouched: the backup.
  public var previousVault: String?

  public init(source: String, importedAt: Int, updatedAt: Int? = nil, previousVault: String? = nil)
  {
    self.source = source
    self.importedAt = importedAt
    self.updatedAt = updatedAt
    self.previousVault = previousVault
  }
}

/// `GET /api/import/obsidian`: the running job, or the last one since the daemon started, and
/// where this vault was imported from.
public struct ObsidianImportStatusResponse: Codable, Hashable, Sendable {
  /// nil: none since the daemon started.
  public var job: ObsidianImportJob?
  /// Set when this vault was imported from Obsidian (so it can be updated from there).
  public var imported: ObsidianImportOrigin?

  public init(job: ObsidianImportJob?, imported: ObsidianImportOrigin? = nil) {
    self.job = job
    self.imported = imported
  }

  enum CodingKeys: String, CodingKey { case job, imported }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    // Required on the wire: null when there was no job.
    try c.encode(job, forKey: .job)
    try c.encodeIfPresent(imported, forKey: .imported)
  }
}
