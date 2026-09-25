import Foundation
import Testing

@testable import DailyDoListModels

/// `orchestrator.activity` and `AgentStatusResponse.orchestrator`, decoded from JSON shaped like
/// the spec's wire (`docs/specs/orchestrator-activity.md`).
struct OrchestratorActivityTests {
  static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder.daemon.decode(T.self, from: Data(json.utf8))
  }

  @Test func aNoticedLineDecodes() throws {
    let json = #"""
      {"type":"orchestrator.activity","activity":{"phase":"noticed",
       "trigger":{"kind":"note","notePath":"Daily/2026-09-25.md",
        "lines":[{"line":4,"text":"find a quiet dishwasher?"}],"summary":"“find a quiet dishwasher?”"}}}
      """#
    let event = try Self.decode(ServerEvent.self, json)
    #expect(event.type == "orchestrator.activity")
    guard case .orchestratorActivity(let activity) = event else {
      Issue.record("expected orchestrator.activity, got \(event)")
      return
    }
    #expect(activity.phase == .noticed)
    #expect(!activity.phase.isWorking)
    #expect(activity.turnId == nil && activity.startedAt == nil && activity.outcome == nil)
    let trigger = try #require(activity.trigger)
    #expect(trigger.kind == .note)
    #expect(trigger.notePath == "Daily/2026-09-25.md")
    #expect(trigger.lines == [OrchestratorTriggerLine(line: 4, text: "find a quiet dishwasher?")])
    #expect(trigger.summary == "“find a quiet dishwasher?”")
  }

  @Test func aTurnInEveryPhaseDecodes() throws {
    for phase in ["reading", "thinking", "acting"] {
      let json = """
        {"type":"orchestrator.activity","activity":{"phase":"\(phase)","turnId":"msg_0007",
         "startedAt":1790000000000,"trigger":{"kind":"task","notePath":"Daily/2026-09-25.md",
         "lines":[{"line":2,"text":"- [ ] Renew the passport"}],"summary":"“Renew the passport”"}}}
        """
      guard case .orchestratorActivity(let activity) = try Self.decode(ServerEvent.self, json)
      else {
        Issue.record("\(phase) did not decode as orchestrator.activity")
        continue
      }
      #expect(activity.phase.rawValue == phase)
      #expect(activity.phase.isWorking)
      #expect(activity.turnId == "msg_0007")
      #expect(activity.startedAt == 1_790_000_000_000)
      #expect(activity.trigger?.kind == .task)
    }
  }

  @Test func theOutcomeOfATurnDecodes() throws {
    let json = #"""
      {"type":"orchestrator.activity","activity":{"phase":"idle","turnId":"msg_0007",
       "trigger":{"kind":"message","summary":"your message"},
       "outcome":{"kind":"tasks_added","count":3,"threadId":"thr_0003","text":"Added 3 tasks under “Trip”"}}}
      """#
    guard case .orchestratorActivity(let activity) = try Self.decode(ServerEvent.self, json) else {
      Issue.record("expected orchestrator.activity")
      return
    }
    #expect(activity.phase == .idle)
    #expect(activity.trigger?.notePath == nil && activity.trigger?.lines == nil)
    #expect(
      activity.outcome
        == OrchestratorOutcome(
          kind: .tasksAdded, count: 3, threadId: "thr_0003", text: "Added 3 tasks under “Trip”"))
  }

  @Test func everyOutcomeKindOfTheSpecIsKnown() throws {
    let kinds: [(String, OrchestratorOutcomeKind)] = [
      ("no_action", .noAction), ("tasks_added", .tasksAdded), ("note_edited", .noteEdited),
      ("replied", .replied), ("delegated", .delegated), ("routine_created", .routineCreated),
      ("asked_approval", .askedApproval),
    ]
    for (raw, kind) in kinds {
      let outcome = try Self.decode(OrchestratorOutcome.self, #"{"kind":"\#(raw)"}"#)
      #expect(outcome.kind == kind)
    }
    let triggers: [(String, OrchestratorTriggerKind)] = [
      ("note", .note), ("task", .task), ("message", .message), ("routine", .routine),
      ("approval", .approval), ("other", .other),
    ]
    for (raw, kind) in triggers {
      let trigger = try Self.decode(OrchestratorTrigger.self, #"{"kind":"\#(raw)","summary":"x"}"#)
      #expect(trigger.kind == kind)
    }
  }

  /// A newer daemon may add phases and kinds: they decode, and a phase this build doesn't know
  /// counts as work in progress.
  @Test func unknownPhasesAndKindsDecodeLeniently() throws {
    let json = #"""
      {"phase":"reflecting","trigger":{"kind":"calendar","summary":"your 3 PM meeting"},
       "outcome":{"kind":"meeting_moved"}}
      """#
    let activity = try Self.decode(OrchestratorActivity.self, json)
    #expect(activity.phase.rawValue == "reflecting")
    #expect(activity.phase.isWorking)
    #expect(activity.trigger?.kind.rawValue == "calendar")
    #expect(activity.outcome?.kind.rawValue == "meeting_moved")
  }

  @Test func encodingIsCanonical() throws {
    let activity = OrchestratorActivity(
      phase: .thinking, turnId: "msg_1",
      trigger: OrchestratorTrigger(
        kind: .note, notePath: "Daily/2026-09-25.md",
        lines: [OrchestratorTriggerLine(line: 0, text: "Plan the trip?")], summary: "your note"),
      startedAt: 1_000)
    let json = String(
      decoding: try JSONEncoder.daemon.encode(ServerEvent.orchestratorActivity(activity)),
      as: UTF8.self)
    #expect(
      json
        == #"{"activity":{"phase":"thinking","startedAt":1000,"trigger":{"kind":"note","lines":[{"line":0,"text":"Plan the trip?"}],"notePath":"Daily/2026-09-25.md","summary":"your note"},"turnId":"msg_1"},"type":"orchestrator.activity"}"#
    )
    let idle = String(
      decoding: try JSONEncoder.daemon.encode(OrchestratorActivity.idle), as: UTF8.self)
    #expect(idle == #"{"phase":"idle"}"#)
  }

  @Test func theStatusCarriesTheActivityForAClientJoiningMidTurn() throws {
    let json = #"""
      {"mode":"live","enabled":true,"model":"m","running":0,"queued":0,"pendingApprovals":0,
       "connectors":[],"execution":{"provider":"local","capabilities":{"shell":true,"browser":true,"computer":false}},
       "orchestrator":{"phase":"acting","turnId":"msg_9","startedAt":5,
        "trigger":{"kind":"routine","summary":"Morning briefing"}}}
      """#
    let status = try Self.decode(AgentStatusResponse.self, json)
    #expect(status.orchestrator?.phase == .acting)
    #expect(status.orchestrator?.trigger?.kind == .routine)
    guard
      case .agentStatus(let pushed) = try Self.decode(
        ServerEvent.self, #"{"type":"agent.status","status":\#(json)}"#)
    else {
      Issue.record("expected agent.status")
      return
    }
    #expect(pushed == status)
  }

  @Test func anOlderDaemonsStatusHasNoActivity() throws {
    let json = #"""
      {"mode":"live","enabled":true,"model":"m","running":0,"queued":0,"pendingApprovals":0,
       "connectors":[],"execution":{"provider":"local","capabilities":{"shell":true,"browser":true,"computer":false}}}
      """#
    let status = try Self.decode(AgentStatusResponse.self, json)
    #expect(status.orchestrator == nil)
    let encoded = String(decoding: try JSONEncoder.daemon.encode(status), as: UTF8.self)
    #expect(!encoded.contains("orchestrator"))
  }
}
