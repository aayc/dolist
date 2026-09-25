import Foundation

// What the orchestrator is doing right now (`OrchestratorActivity` in `@ddl/core`): pushed as
// `orchestrator.activity` events and included in `AgentStatusResponse.orchestrator` for a client
// that joins mid-turn.

/// The orchestrator's phase: it `noticed` lines as soon as the watcher saw them (before the settle
/// delay), is `reading` while it builds its digest, `thinking` during the model turn and `acting`
/// while its tools run, then `idle` again (with an outcome right after a turn).
public struct OrchestratorPhase: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let idle: Self = "idle"
  public static let noticed: Self = "noticed"
  public static let reading: Self = "reading"
  public static let thinking: Self = "thinking"
  public static let acting: Self = "acting"

  /// A turn is under way (reading, thinking, acting, or a phase this build doesn't know).
  public var isWorking: Bool { self != .idle && self != .noticed }
}

/// What woke the orchestrator.
public struct OrchestratorTriggerKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let note: Self = "note"
  public static let task: Self = "task"
  public static let message: Self = "message"
  public static let routine: Self = "routine"
  public static let approval: Self = "approval"
  public static let other: Self = "other"
}

/// A line that woke the orchestrator, as it was when the watcher saw it.
public struct OrchestratorTriggerLine: Codable, Hashable, Sendable {
  /// 0-based.
  public var line: Int
  public var text: String

  public init(line: Int, text: String) {
    self.line = line
    self.text = text
  }
}

public struct OrchestratorTrigger: Codable, Hashable, Sendable {
  public var kind: OrchestratorTriggerKind
  public var notePath: String?
  /// The lines that woke it (for anchoring chips in the editor).
  public var lines: [OrchestratorTriggerLine]?
  /// Short and human: "your note", "“call mom tomorrow”".
  public var summary: String

  public init(
    kind: OrchestratorTriggerKind, notePath: String? = nil, lines: [OrchestratorTriggerLine]? = nil,
    summary: String
  ) {
    self.kind = kind
    self.notePath = notePath
    self.lines = lines
    self.summary = summary
  }
}

/// What a turn ended with.
public struct OrchestratorOutcomeKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let noAction: Self = "no_action"
  public static let tasksAdded: Self = "tasks_added"
  public static let noteEdited: Self = "note_edited"
  public static let replied: Self = "replied"
  public static let delegated: Self = "delegated"
  public static let routineCreated: Self = "routine_created"
  public static let askedApproval: Self = "asked_approval"
}

public struct OrchestratorOutcome: Codable, Hashable, Sendable {
  public var kind: OrchestratorOutcomeKind
  public var count: Int?
  /// The thread it created or acted in, when there is one.
  public var threadId: String?
  /// One short line for the chip's tooltip.
  public var text: String?

  public init(
    kind: OrchestratorOutcomeKind, count: Int? = nil, threadId: String? = nil, text: String? = nil
  ) {
    self.kind = kind
    self.count = count
    self.threadId = threadId
    self.text = text
  }
}

public struct OrchestratorActivity: Codable, Hashable, Sendable {
  public var phase: OrchestratorPhase
  /// The orchestrator chat message that starts this turn (to open it).
  public var turnId: String?
  public var trigger: OrchestratorTrigger?
  public var startedAt: EpochMillis?
  /// Present right after a turn ends (phase `idle`), shown briefly.
  public var outcome: OrchestratorOutcome?

  public init(
    phase: OrchestratorPhase, turnId: String? = nil, trigger: OrchestratorTrigger? = nil,
    startedAt: EpochMillis? = nil, outcome: OrchestratorOutcome? = nil
  ) {
    self.phase = phase
    self.turnId = turnId
    self.trigger = trigger
    self.startedAt = startedAt
    self.outcome = outcome
  }

  public static let idle = OrchestratorActivity(phase: .idle)
}
