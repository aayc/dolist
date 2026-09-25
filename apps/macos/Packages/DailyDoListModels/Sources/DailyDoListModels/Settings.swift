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
  /// Vim startup commands, one ex command per line (`imap jj <Esc>`, `set clipboard=unnamed`);
  /// lines starting with `"` are comments. Applied when vim starts and whenever this changes.
  public var vimrc: String
  /// Obsidian-style live preview (hide markdown syntax away from the cursor).
  public var livePreview: Bool
  public var readableLineLength: Bool
  public var fontSize: Double
  public var spellcheck: Bool
  public var showLineNumbers: Bool

  public init(
    vimMode: Bool, vimrc: String = "", livePreview: Bool, readableLineLength: Bool,
    fontSize: Double,
    spellcheck: Bool, showLineNumbers: Bool
  ) {
    self.vimMode = vimMode
    self.vimrc = vimrc
    self.livePreview = livePreview
    self.readableLineLength = readableLineLength
    self.fontSize = fontSize
    self.spellcheck = spellcheck
    self.showLineNumbers = showLineNumbers
  }

  /// Daemons older than the vimrc setting don't send it.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    vimMode = try container.decode(Bool.self, forKey: .vimMode)
    vimrc = try container.decodeIfPresent(String.self, forKey: .vimrc) ?? ""
    livePreview = try container.decode(Bool.self, forKey: .livePreview)
    readableLineLength = try container.decode(Bool.self, forKey: .readableLineLength)
    fontSize = try container.decode(Double.self, forKey: .fontSize)
    spellcheck = try container.decode(Bool.self, forKey: .spellcheck)
    showLineNumbers = try container.decode(Bool.self, forKey: .showLineNumbers)
  }

  public static let defaults = EditorSettings(
    vimMode: false, vimrc: "", livePreview: true, readableLineLength: true, fontSize: 16,
    spellcheck: false, showLineNumbers: false)
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

/// What runs the orchestrator and subagent conversations: `pi` (the Pi coding-agent SDK on the
/// OpenRouter `model`) or `cursor` (the Cursor CLI's agent on `cursorModel`, signed in with the
/// user's Cursor account). Closed, like every value clients send: decoding it on its own rejects
/// unknown values (`AgentSettings` tolerates them, see `harness`).
public enum AgentHarnessKind: String, Codable, Hashable, Sendable, CaseIterable {
  case pi, cursor
}

/// When agents ask before acting (`ApprovalPolicy` in `@ddl/core`), from strictest to loosest:
/// every action that changes something, what the safety check flags (the default), only high-risk
/// actions, or never. Actions the safety check denies stay blocked under every policy. Closed like
/// every value clients send: decoding it on its own rejects unknown values (`AgentSettings`
/// tolerates them, see `approvalPolicy`).
public enum ApprovalPolicy: String, Codable, Hashable, Sendable, CaseIterable {
  case askEveryAction = "ask_every_action"
  case askRisky = "ask_risky"
  case askHighRisk = "ask_high_risk"
  case runEverything = "run_everything"

  public static let `default` = ApprovalPolicy.askRisky
}

public struct AgentSettings: Codable, Hashable, Sendable {
  /// Master switch.
  public var enabled: Bool
  /// Quiet period after the last edit to a task before the orchestrator looks at it.
  public var settleMs: Int
  public var maxConcurrentSubagents: Int
  /// What runs the agent. Daemons older than this setting don't send it, and a harness this client
  /// doesn't know (added by a newer daemon) also decodes as `.pi`, the harness the daemon's
  /// `agentModel` falls back to. Patches only carry fields the user changes, so it is never
  /// written back unless the user picks a harness.
  public var harness: AgentHarnessKind
  /// OpenRouter model id for the orchestrator and subagents with the Pi harness.
  public var model: String
  /// Model for the orchestrator and subagents with the Cursor harness (`claude-opus-5-5`,
  /// `composer-2.5`). The CLI's agent mode runs one preset per model; a variant id from
  /// `agent models` (`claude-opus-5-5-high-fast`) runs as its model's preset.
  public var cursorModel: String
  /// OpenRouter model id for the safety judge (with either harness).
  public var judgeModel: String
  public var watch: AgentWatchWindow
  /// Treat tasks that already exist when a note is first seen as new work.
  public var actOnExistingTasks: Bool
  /// How long an approval request waits before it is auto-denied.
  public var approvalTimeoutMs: Int
  /// When agents ask before acting. Daemons older than this setting don't send it, and a policy
  /// this client doesn't know (added by a newer daemon) also decodes as the default, the way the
  /// daemon treats a value it doesn't know. Only sent back when the user picks a policy.
  public var approvalPolicy: ApprovalPolicy

  public init(
    enabled: Bool, settleMs: Int, maxConcurrentSubagents: Int, harness: AgentHarnessKind = .pi,
    model: String, cursorModel: String = AgentSettings.defaultCursorModel, judgeModel: String,
    watch: AgentWatchWindow, actOnExistingTasks: Bool, approvalTimeoutMs: Int,
    approvalPolicy: ApprovalPolicy = .default
  ) {
    self.enabled = enabled
    self.settleMs = settleMs
    self.maxConcurrentSubagents = maxConcurrentSubagents
    self.harness = harness
    self.model = model
    self.cursorModel = cursorModel
    self.judgeModel = judgeModel
    self.watch = watch
    self.actOnExistingTasks = actOnExistingTasks
    self.approvalTimeoutMs = approvalTimeoutMs
    self.approvalPolicy = approvalPolicy
  }

  /// Daemons older than the harness setting send neither `harness` nor `cursorModel`, and older
  /// than the approval policy no `approvalPolicy`.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try container.decode(Bool.self, forKey: .enabled)
    settleMs = try container.decode(Int.self, forKey: .settleMs)
    maxConcurrentSubagents = try container.decode(Int.self, forKey: .maxConcurrentSubagents)
    harness =
      try container.decodeIfPresent(String.self, forKey: .harness)
      .flatMap(AgentHarnessKind.init(rawValue:)) ?? .pi
    model = try container.decode(String.self, forKey: .model)
    cursorModel =
      try container.decodeIfPresent(String.self, forKey: .cursorModel) ?? Self.defaultCursorModel
    judgeModel = try container.decode(String.self, forKey: .judgeModel)
    watch = try container.decode(AgentWatchWindow.self, forKey: .watch)
    actOnExistingTasks = try container.decode(Bool.self, forKey: .actOnExistingTasks)
    approvalTimeoutMs = try container.decode(Int.self, forKey: .approvalTimeoutMs)
    approvalPolicy =
      try container.decodeIfPresent(String.self, forKey: .approvalPolicy)
      .flatMap(ApprovalPolicy.init(rawValue:)) ?? .default
  }

  public static let defaultModel = "deepseek/deepseek-v4.1-flash"
  public static let defaultCursorModel = "claude-opus-5-5"

  /// The model id the configured harness runs its conversations on (`agentModel` in `@ddl/core`).
  public var agentModel: String { harness == .cursor ? cursorModel : model }

  public static let defaults = AgentSettings(
    enabled: true, settleMs: 2500, maxConcurrentSubagents: 3, harness: .pi, model: defaultModel,
    cursorModel: defaultCursorModel, judgeModel: defaultModel,
    watch: AgentWatchWindow(pastDays: 0, futureDays: 7), actOnExistingTasks: true,
    approvalTimeoutMs: 12 * 60 * 60 * 1000, approvalPolicy: .default)
}

/// The always-on machine every device of the vault can hand the agent to. Its name and address
/// sync with the settings; each device pairs with it once and keeps its own credential.
public struct AlwaysOnMachine: Codable, Hashable, Sendable {
  /// 1–64 characters.
  public var name: String
  /// `https://<host>[:port]`, lowercase, without a trailing `/` (plain http only to loopback).
  public var url: String

  public init(name: String, url: String) {
    self.name = name
    self.url = url
  }
}

/// Remote access settings shared by every device (non-secret).
public struct RemoteSettings: Codable, Hashable, Sendable {
  public var alwaysOnMachine: AlwaysOnMachine?

  public init(alwaysOnMachine: AlwaysOnMachine? = nil) {
    self.alwaysOnMachine = alwaysOnMachine
  }

  public static let defaults = RemoteSettings()

  enum CodingKeys: String, CodingKey { case alwaysOnMachine }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    // Required on the wire: null without an always-on machine.
    try c.encode(alwaysOnMachine, forKey: .alwaysOnMachine)
  }
}

public struct AppSettings: Codable, Hashable, Sendable {
  public var theme: ThemePreference
  public var editor: EditorSettings
  public var dailyNotes: DailyNoteSettings
  public var weeklyNotes: WeeklyNoteSettings
  public var agent: AgentSettings
  /// Daemons older than the always-on machine don't send it: they decode as having none.
  public var remote: RemoteSettings

  public init(
    theme: ThemePreference, editor: EditorSettings, dailyNotes: DailyNoteSettings,
    weeklyNotes: WeeklyNoteSettings, agent: AgentSettings, remote: RemoteSettings = .defaults
  ) {
    self.theme = theme
    self.editor = editor
    self.dailyNotes = dailyNotes
    self.weeklyNotes = weeklyNotes
    self.agent = agent
    self.remote = remote
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    theme = try container.decode(ThemePreference.self, forKey: .theme)
    editor = try container.decode(EditorSettings.self, forKey: .editor)
    dailyNotes = try container.decode(DailyNoteSettings.self, forKey: .dailyNotes)
    weeklyNotes = try container.decode(WeeklyNoteSettings.self, forKey: .weeklyNotes)
    agent = try container.decode(AgentSettings.self, forKey: .agent)
    remote = try container.decodeIfPresent(RemoteSettings.self, forKey: .remote) ?? .defaults
  }

  public static let defaults = AppSettings(
    theme: .dark, editor: .defaults, dailyNotes: .defaults, weeklyNotes: .defaults,
    agent: .defaults, remote: .defaults)
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
  public static let vimrcLength = 16_384
  /// Model ids (`model`, `cursorModel`, `judgeModel`) after trimming: `WIRE_LIMITS.modelIdLength`.
  public static let modelIdLength = 200
}

// MARK: - Settings patch (UpdateSettingsRequest = DeepPartial<AppSettings>)

/// A deep partial of `AppSettings`: only non-nil fields are sent (PATCH semantics).
public struct SettingsPatch: Codable, Hashable, Sendable {
  public var theme: ThemePreference?
  public var editor: EditorPatch?
  public var dailyNotes: DailyNotesPatch?
  public var weeklyNotes: WeeklyNotesPatch?
  public var agent: AgentPatch?
  public var remote: RemotePatch?

  public init(
    theme: ThemePreference? = nil, editor: EditorPatch? = nil,
    dailyNotes: DailyNotesPatch? = nil, weeklyNotes: WeeklyNotesPatch? = nil,
    agent: AgentPatch? = nil, remote: RemotePatch? = nil
  ) {
    self.theme = theme
    self.editor = editor
    self.dailyNotes = dailyNotes
    self.weeklyNotes = weeklyNotes
    self.agent = agent
    self.remote = remote
  }

  public var isEmpty: Bool {
    theme == nil && editor == nil && dailyNotes == nil && weeklyNotes == nil && agent == nil
      && remote == nil
  }

  /// A change to the always-on machine: a whole new one, or none.
  public enum AlwaysOnMachineChange: Hashable, Sendable {
    case set(AlwaysOnMachine)
    /// Sent as `null`.
    case clear
  }

  public struct RemotePatch: Codable, Hashable, Sendable {
    /// nil leaves the machine as it is.
    public var alwaysOnMachine: AlwaysOnMachineChange?

    public init(alwaysOnMachine: AlwaysOnMachineChange? = nil) {
      self.alwaysOnMachine = alwaysOnMachine
    }

    enum CodingKeys: String, CodingKey { case alwaysOnMachine }

    /// Absent → nil, `null` → `.clear`, an object → `.set`.
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      if !c.contains(.alwaysOnMachine) {
        alwaysOnMachine = nil
      } else if try c.decodeNil(forKey: .alwaysOnMachine) {
        alwaysOnMachine = .clear
      } else {
        alwaysOnMachine = .set(try c.decode(AlwaysOnMachine.self, forKey: .alwaysOnMachine))
      }
    }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch alwaysOnMachine {
      case nil: break
      case .clear: try c.encodeNil(forKey: .alwaysOnMachine)
      case .set(let machine): try c.encode(machine, forKey: .alwaysOnMachine)
      }
    }
  }

  public struct EditorPatch: Codable, Hashable, Sendable {
    public var vimMode: Bool?
    public var vimrc: String?
    public var livePreview: Bool?
    public var readableLineLength: Bool?
    public var fontSize: Double?
    public var spellcheck: Bool?
    public var showLineNumbers: Bool?

    public init(
      vimMode: Bool? = nil, vimrc: String? = nil, livePreview: Bool? = nil,
      readableLineLength: Bool? = nil, fontSize: Double? = nil, spellcheck: Bool? = nil,
      showLineNumbers: Bool? = nil
    ) {
      self.vimMode = vimMode
      self.vimrc = vimrc
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
    public var harness: AgentHarnessKind?
    public var model: String?
    public var cursorModel: String?
    public var judgeModel: String?
    public var watch: WatchPatch?
    public var actOnExistingTasks: Bool?
    public var approvalTimeoutMs: Int?
    public var approvalPolicy: ApprovalPolicy?

    public init(
      enabled: Bool? = nil, settleMs: Int? = nil, maxConcurrentSubagents: Int? = nil,
      harness: AgentHarnessKind? = nil, model: String? = nil, cursorModel: String? = nil,
      judgeModel: String? = nil, watch: WatchPatch? = nil, actOnExistingTasks: Bool? = nil,
      approvalTimeoutMs: Int? = nil, approvalPolicy: ApprovalPolicy? = nil
    ) {
      self.enabled = enabled
      self.settleMs = settleMs
      self.maxConcurrentSubagents = maxConcurrentSubagents
      self.harness = harness
      self.model = model
      self.cursorModel = cursorModel
      self.judgeModel = judgeModel
      self.watch = watch
      self.actOnExistingTasks = actOnExistingTasks
      self.approvalTimeoutMs = approvalTimeoutMs
      self.approvalPolicy = approvalPolicy
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
      if let v = p.vimrc { next.editor.vimrc = v }
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
      if let v = p.harness { next.agent.harness = v }
      if let v = p.model { next.agent.model = v }
      if let v = p.cursorModel { next.agent.cursorModel = v }
      if let v = p.judgeModel { next.agent.judgeModel = v }
      if let w = p.watch {
        if let v = w.pastDays { next.agent.watch.pastDays = v }
        if let v = w.futureDays { next.agent.watch.futureDays = v }
      }
      if let v = p.actOnExistingTasks { next.agent.actOnExistingTasks = v }
      if let v = p.approvalTimeoutMs { next.agent.approvalTimeoutMs = v }
      if let v = p.approvalPolicy { next.agent.approvalPolicy = v }
    }
    switch patch.remote?.alwaysOnMachine {
    case nil: break
    case .clear: next.remote.alwaysOnMachine = nil
    case .set(let machine): next.remote.alwaysOnMachine = machine
    }
    return next
  }
}
