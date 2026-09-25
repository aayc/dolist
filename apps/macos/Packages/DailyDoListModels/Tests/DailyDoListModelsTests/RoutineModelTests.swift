import Foundation
import Testing

@testable import DailyDoListModels

struct RoutineModelTests {
  @Test func routesEncodeTheRoutineId() {
    #expect(APIRoute.routines == "/api/routines")
    #expect(APIRoute.routine("rtn_0a1b") == "/api/routines/rtn_0a1b")
    #expect(APIRoute.routineRun("rtn_0a1b") == "/api/routines/rtn_0a1b/run")
    #expect(APIRoute.routinePause("rtn_0a1b") == "/api/routines/rtn_0a1b/pause")
    #expect(APIRoute.routineResume("rtn_0a1b") == "/api/routines/rtn_0a1b/resume")
    #expect(APIRoute.threads(routineId: "rtn_0a1b") == "/api/threads?routineId=rtn_0a1b")
  }

  @Test func runThreadsCarryTheirRoutine() throws {
    let json = #"""
      {"id":"thr_1","taskId":"run_1","notePath":"Routines/Morning briefing.md","title":"Morning briefing",
       "status":"done","createdAt":1,"updatedAt":2,"messageCount":0,"artifactCount":0,"surfaces":[],
       "pendingApprovals":0,"routineId":"rtn_0a1b"}
      """#
    let summary = try JSONDecoder.daemon.decode(ThreadSummary.self, from: Data(json.utf8))
    #expect(summary.isRoutineRun)
    #expect(summary.routineId == "rtn_0a1b")
    let task = ThreadSummary(
      id: "thr_2", taskId: "tsk_1", notePath: nil, title: "x", status: .idle, createdAt: 0,
      updatedAt: 0, messageCount: 0, artifactCount: 0, surfaces: [], pendingApprovals: 0)
    #expect(!task.isRoutineRun)
    let encoded = String(decoding: try JSONEncoder.daemon.encode(task), as: UTF8.self)
    #expect(!encoded.contains("routineId"))
  }

  @Test func aRoutineIsRunningWhileItsLastRunIsActive() {
    var routine = Routine(
      id: "rtn_1", path: "Routines/A.md", name: "A", schedule: "hourly", instructions: "x")
    #expect(!routine.isRunning)
    routine.lastRun = RoutineRun(
      threadId: "thr_1", trigger: .manual, status: .waitingApproval, startedAt: 1)
    #expect(routine.isRunning)
    routine.lastRun?.status = .done
    #expect(!routine.isRunning)
  }
}
