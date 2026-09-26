import Foundation

// Swift mirror of the routine shapes in `packages/contract/src/wire`.

/// When a finished run notifies: every time, only when it found something new, or never.
public struct RoutineNotify: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let always: Self = "always"
  /// The file spells it `when changed`.
  public static let whenChanged: Self = "when_changed"
  public static let never: Self = "never"
}

/// A capability a routine's runs get (the `uses` hint of its file).
public struct RoutineUse: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let web: Self = "web"
  public static let browser: Self = "browser"
  public static let computer: Self = "computer"
  public static let shell: Self = "shell"
  public static let files: Self = "files"
  public static let connectors: Self = "connectors"
}

/// What started a run: its schedule, a slot missed while the Mac slept, or the user.
public struct RoutineRunTrigger: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let schedule: Self = "schedule"
  /// Once, however many slots were missed while the Mac slept or the daemon was down.
  public static let catchUp: Self = "catch_up"
  public static let manual: Self = "manual"
}

/// One run of a routine; its thread holds the conversation.
public struct RoutineRun: Codable, Hashable, Sendable {
  public var threadId: String
  public var trigger: RoutineRunTrigger
  public var status: TaskAgentStatus
  public var startedAt: EpochMillis
  public var finishedAt: EpochMillis?
  /// One line: the run's badge text.
  public var summary: String?
  /// Whether the run found something new since the previous one.
  public var changed: Bool?

  public init(
    threadId: String, trigger: RoutineRunTrigger, status: TaskAgentStatus,
    startedAt: EpochMillis, finishedAt: EpochMillis? = nil, summary: String? = nil,
    changed: Bool? = nil
  ) {
    self.threadId = threadId
    self.trigger = trigger
    self.status = status
    self.startedAt = startedAt
    self.finishedAt = finishedAt
    self.summary = summary
    self.changed = changed
  }
}

/// A standing job the agent runs on a schedule: the file `Routines/<name>.md` plus the
/// scheduler's state (next and last run).
public struct Routine: Codable, Hashable, Sendable, Identifiable {
  /// Stable id derived from the file's path (`rtn_…`).
  public var id: String
  /// `Routines/<name>.md`.
  public var path: String
  /// The file name without `.md`.
  public var name: String
  /// The schedule as written in the file.
  public var schedule: String
  /// The schedule in words (`Every weekday at 7:30 AM`); nil when it can't be read.
  public var scheduleText: String?
  public var notify: RoutineNotify
  public var uses: [RoutineUse]
  public var paused: Bool
  /// What each run does (the file's body).
  public var instructions: String
  /// Why the routine can't run.
  public var error: String?
  /// Nil while paused, invalid or unscheduled.
  public var nextRunAt: EpochMillis?
  public var lastRun: RoutineRun?
  public var runCount: Int
  /// Runs that may still start today beyond the schedule (Run Now included).
  public var extraRunsLeft: Int

  public init(
    id: String, path: String, name: String, schedule: String, scheduleText: String? = nil,
    notify: RoutineNotify = .always, uses: [RoutineUse] = [], paused: Bool = false,
    instructions: String, error: String? = nil, nextRunAt: EpochMillis? = nil,
    lastRun: RoutineRun? = nil, runCount: Int = 0, extraRunsLeft: Int = 5
  ) {
    self.id = id
    self.path = path
    self.name = name
    self.schedule = schedule
    self.scheduleText = scheduleText
    self.notify = notify
    self.uses = uses
    self.paused = paused
    self.instructions = instructions
    self.error = error
    self.nextRunAt = nextRunAt
    self.lastRun = lastRun
    self.runCount = runCount
    self.extraRunsLeft = extraRunsLeft
  }

  /// A run is going (or waiting on the user).
  public var isRunning: Bool { lastRun.map { $0.status.isActive } ?? false }
}

/// A starter routine offered by "New Routine…".
public struct RoutineTemplate: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  /// One line for the picker.
  public var description: String
  public var schedule: String
  public var notify: RoutineNotify
  public var uses: [RoutineUse]
  public var instructions: String

  public init(
    id: String, name: String, description: String, schedule: String,
    notify: RoutineNotify = .always, uses: [RoutineUse] = [], instructions: String
  ) {
    self.id = id
    self.name = name
    self.description = description
    self.schedule = schedule
    self.notify = notify
    self.uses = uses
    self.instructions = instructions
  }
}

/// A finished run to tell the user about (sent according to the routine's `notify`).
public struct RoutineNotification: Codable, Hashable, Sendable {
  public var routineId: String
  /// The routine's name.
  public var title: String
  /// The run's result in a line or two.
  public var body: String
  public var threadId: String
  public var status: TaskAgentStatus
  public var at: EpochMillis

  public init(
    routineId: String, title: String, body: String, threadId: String, status: TaskAgentStatus,
    at: EpochMillis
  ) {
    self.routineId = routineId
    self.title = title
    self.body = body
    self.threadId = threadId
    self.status = status
    self.at = at
  }
}

// MARK: - REST

public struct RoutineListResponse: Codable, Hashable, Sendable {
  /// Sorted by name.
  public var routines: [Routine]
  public var templates: [RoutineTemplate]

  public init(routines: [Routine], templates: [RoutineTemplate]) {
    self.routines = routines
    self.templates = templates
  }
}

public struct RoutineResponse: Codable, Hashable, Sendable {
  public var routine: Routine
  public init(routine: Routine) { self.routine = routine }
}

/// Body of `POST /api/routines`: a new routine file `Routines/<name>.md`.
public struct CreateRoutineRequest: Codable, Hashable, Sendable {
  public var name: String
  public var schedule: String
  public var instructions: String
  public var notify: RoutineNotify?
  public var uses: [RoutineUse]?
  public var paused: Bool?

  public init(
    name: String, schedule: String, instructions: String, notify: RoutineNotify? = nil,
    uses: [RoutineUse]? = nil, paused: Bool? = nil
  ) {
    self.name = name
    self.schedule = schedule
    self.instructions = instructions
    self.notify = notify
    self.uses = uses
    self.paused = paused
  }
}

public struct RoutineRunResponse: Codable, Hashable, Sendable {
  public var routine: Routine
  /// The new run's thread.
  public var threadId: String

  public init(routine: Routine, threadId: String) {
    self.routine = routine
    self.threadId = threadId
  }
}

extension AgentThread {
  /// One run of a routine (listed under its routine, not in the task inbox).
  public var isRoutineRun: Bool { routineId != nil }
}

extension ThreadSummary {
  /// One run of a routine (listed under its routine, not in the task inbox).
  public var isRoutineRun: Bool { routineId != nil }
}
