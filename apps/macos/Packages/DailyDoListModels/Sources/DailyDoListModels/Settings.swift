import Foundation

/// Mirrors Obsidian's `.obsidian/daily-notes.json`.
public struct DailyNoteSettings: Codable, Hashable, Sendable {
  /// Vault folder for daily notes (e.g. `Daily`). Empty string = vault root.
  public var folder: String
  /// Moment-style file name format; may contain `/` for nested folders.
  public var format: String
  /// Template note path (with or without `.md`). Empty string = no template.
  public var template: String

  public init(folder: String, format: String, template: String) {
    self.folder = folder
    self.format = format
    self.template = template
  }

  public static let defaults = DailyNoteSettings(
    folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily.md")
}

public struct WeeklyNoteSettings: Codable, Hashable, Sendable {
  public var folder: String
  public var format: String
  public var template: String

  public init(folder: String, format: String, template: String) {
    self.folder = folder
    self.format = format
    self.template = template
  }

  public static let defaults = WeeklyNoteSettings(
    folder: "Weekly", format: "gggg-[W]ww", template: "Templates/Weekly.md")
}

public enum ThemePreference: String, Codable, Hashable, Sendable, CaseIterable {
  case system, light, dark
}

public struct EditorSettings: Codable, Hashable, Sendable {
  public var vimMode: Bool
  /// Obsidian-style live preview (hide markdown syntax away from the cursor).
  public var livePreview: Bool
  public var readableLineLength: Bool
  public var fontSize: Double
  public var spellcheck: Bool
  public var showLineNumbers: Bool

  public init(
    vimMode: Bool, livePreview: Bool, readableLineLength: Bool, fontSize: Double,
    spellcheck: Bool, showLineNumbers: Bool
  ) {
    self.vimMode = vimMode
    self.livePreview = livePreview
    self.readableLineLength = readableLineLength
    self.fontSize = fontSize
    self.spellcheck = spellcheck
    self.showLineNumbers = showLineNumbers
  }

  public static let defaults = EditorSettings(
    vimMode: false, livePreview: true, readableLineLength: true, fontSize: 16, spellcheck: false,
    showLineNumbers: false)
}

/// Days around today whose daily notes the orchestrator watches.
public struct AgentWatchWindow: Codable, Hashable, Sendable {
  public var pastDays: Int
  public var futureDays: Int

  public init(pastDays: Int, futureDays: Int) {
    self.pastDays = pastDays
    self.futureDays = futureDays
  }
}

public struct AgentSettings: Codable, Hashable, Sendable {
  /// Master switch.
  public var enabled: Bool
  /// Quiet period after the last edit to a task before the orchestrator looks at it.
  public var settleMs: Int
  public var maxConcurrentSubagents: Int
  /// OpenRouter model id for the orchestrator and subagents.
  public var model: String
  /// OpenRouter model id for the safety judge.
  public var judgeModel: String
  public var watch: AgentWatchWindow
  /// Treat tasks that already exist when a note is first seen as new work.
  public var actOnExistingTasks: Bool
  /// How long an approval request waits before it is auto-denied.
  public var approvalTimeoutMs: Int

  public init(
    enabled: Bool, settleMs: Int, maxConcurrentSubagents: Int, model: String, judgeModel: String,
    watch: AgentWatchWindow, actOnExistingTasks: Bool, approvalTimeoutMs: Int
  ) {
    self.enabled = enabled
    self.settleMs = settleMs
    self.maxConcurrentSubagents = maxConcurrentSubagents
    self.model = model
    self.judgeModel = judgeModel
    self.watch = watch
    self.actOnExistingTasks = actOnExistingTasks
    self.approvalTimeoutMs = approvalTimeoutMs
  }

  public static let defaultModel = "deepseek/deepseek-v4.1-flash"

  public static let defaults = AgentSettings(
    enabled: true, settleMs: 2500, maxConcurrentSubagents: 3, model: defaultModel,
    judgeModel: defaultModel, watch: AgentWatchWindow(pastDays: 0, futureDays: 7),
    actOnExistingTasks: true, approvalTimeoutMs: 12 * 60 * 60 * 1000)
}

public struct AppSettings: Codable, Hashable, Sendable {
  public var theme: ThemePreference
  public var editor: EditorSettings
  public var dailyNotes: DailyNoteSettings
  public var weeklyNotes: WeeklyNoteSettings
  public var agent: AgentSettings

  public init(
    theme: ThemePreference, editor: EditorSettings, dailyNotes: DailyNoteSettings,
    weeklyNotes: WeeklyNoteSettings, agent: AgentSettings
  ) {
    self.theme = theme
    self.editor = editor
    self.dailyNotes = dailyNotes
    self.weeklyNotes = weeklyNotes
    self.agent = agent
  }

  public static let defaults = AppSettings(
    theme: .system, editor: .defaults, dailyNotes: .defaults, weeklyNotes: .defaults,
    agent: .defaults)
}

/// Accepted value ranges (same as the daemon's settings schema in `@ddl/contract`).
public enum SettingsRanges {
  public static let fontSize: ClosedRange<Double> = 8...48
  public static let settleMs: ClosedRange<Int> = 0...120_000
  public static let maxConcurrentSubagents: ClosedRange<Int> = 1...32
  public static let watchDays: ClosedRange<Int> = 0...366
  public static let approvalTimeoutMs: ClosedRange<Int> = 60_000...(30 * 24 * 60 * 60 * 1000)
  public static let folderLength = 512
  public static let formatLength = 128
  public static let templateLength = 512
}

// MARK: - Settings patch (UpdateSettingsRequest = DeepPartial<AppSettings>)

/// A deep partial of `AppSettings`: only non-nil fields are sent (PATCH semantics).
public struct SettingsPatch: Codable, Hashable, Sendable {
  public var theme: ThemePreference?
  public var editor: EditorPatch?
  public var dailyNotes: DailyNotesPatch?
  public var weeklyNotes: WeeklyNotesPatch?
  public var agent: AgentPatch?

  public init(
    theme: ThemePreference? = nil, editor: EditorPatch? = nil,
    dailyNotes: DailyNotesPatch? = nil, weeklyNotes: WeeklyNotesPatch? = nil,
    agent: AgentPatch? = nil
  ) {
    self.theme = theme
    self.editor = editor
    self.dailyNotes = dailyNotes
    self.weeklyNotes = weeklyNotes
    self.agent = agent
  }

  public var isEmpty: Bool {
    theme == nil && editor == nil && dailyNotes == nil && weeklyNotes == nil && agent == nil
  }

  public struct EditorPatch: Codable, Hashable, Sendable {
    public var vimMode: Bool?
    public var livePreview: Bool?
    public var readableLineLength: Bool?
    public var fontSize: Double?
    public var spellcheck: Bool?
    public var showLineNumbers: Bool?

    public init(
      vimMode: Bool? = nil, livePreview: Bool? = nil, readableLineLength: Bool? = nil,
      fontSize: Double? = nil, spellcheck: Bool? = nil, showLineNumbers: Bool? = nil
    ) {
      self.vimMode = vimMode
      self.livePreview = livePreview
      self.readableLineLength = readableLineLength
      self.fontSize = fontSize
      self.spellcheck = spellcheck
      self.showLineNumbers = showLineNumbers
    }
  }

  public struct DailyNotesPatch: Codable, Hashable, Sendable {
    public var folder: String?
    public var format: String?
    public var template: String?

    public init(folder: String? = nil, format: String? = nil, template: String? = nil) {
      self.folder = folder
      self.format = format
      self.template = template
    }
  }

  public struct WeeklyNotesPatch: Codable, Hashable, Sendable {
    public var folder: String?
    public var format: String?
    public var template: String?

    public init(folder: String? = nil, format: String? = nil, template: String? = nil) {
      self.folder = folder
      self.format = format
      self.template = template
    }
  }

  public struct AgentPatch: Codable, Hashable, Sendable {
    public var enabled: Bool?
    public var settleMs: Int?
    public var maxConcurrentSubagents: Int?
    public var model: String?
    public var judgeModel: String?
    public var watch: WatchPatch?
    public var actOnExistingTasks: Bool?
    public var approvalTimeoutMs: Int?

    public init(
      enabled: Bool? = nil, settleMs: Int? = nil, maxConcurrentSubagents: Int? = nil,
      model: String? = nil, judgeModel: String? = nil, watch: WatchPatch? = nil,
      actOnExistingTasks: Bool? = nil, approvalTimeoutMs: Int? = nil
    ) {
      self.enabled = enabled
      self.settleMs = settleMs
      self.maxConcurrentSubagents = maxConcurrentSubagents
      self.model = model
      self.judgeModel = judgeModel
      self.watch = watch
      self.actOnExistingTasks = actOnExistingTasks
      self.approvalTimeoutMs = approvalTimeoutMs
    }
  }

  public struct WatchPatch: Codable, Hashable, Sendable {
    public var pastDays: Int?
    public var futureDays: Int?

    public init(pastDays: Int? = nil, futureDays: Int? = nil) {
      self.pastDays = pastDays
      self.futureDays = futureDays
    }
  }
}

extension AppSettings {
  /// Applies a patch locally (optimistic update), mirroring the daemon's deep merge.
  public func applying(_ patch: SettingsPatch) -> AppSettings {
    var next = self
    if let theme = patch.theme { next.theme = theme }
    if let p = patch.editor {
      if let v = p.vimMode { next.editor.vimMode = v }
      if let v = p.livePreview { next.editor.livePreview = v }
      if let v = p.readableLineLength { next.editor.readableLineLength = v }
      if let v = p.fontSize { next.editor.fontSize = v }
      if let v = p.spellcheck { next.editor.spellcheck = v }
      if let v = p.showLineNumbers { next.editor.showLineNumbers = v }
    }
    if let p = patch.dailyNotes {
      if let v = p.folder { next.dailyNotes.folder = v }
      if let v = p.format { next.dailyNotes.format = v }
      if let v = p.template { next.dailyNotes.template = v }
    }
    if let p = patch.weeklyNotes {
      if let v = p.folder { next.weeklyNotes.folder = v }
      if let v = p.format { next.weeklyNotes.format = v }
      if let v = p.template { next.weeklyNotes.template = v }
    }
    if let p = patch.agent {
      if let v = p.enabled { next.agent.enabled = v }
      if let v = p.settleMs { next.agent.settleMs = v }
      if let v = p.maxConcurrentSubagents { next.agent.maxConcurrentSubagents = v }
      if let v = p.model { next.agent.model = v }
      if let v = p.judgeModel { next.agent.judgeModel = v }
      if let w = p.watch {
        if let v = w.pastDays { next.agent.watch.pastDays = v }
        if let v = w.futureDays { next.agent.watch.futureDays = v }
      }
      if let v = p.actOnExistingTasks { next.agent.actOnExistingTasks = v }
      if let v = p.approvalTimeoutMs { next.agent.approvalTimeoutMs = v }
    }
    return next
  }
}
