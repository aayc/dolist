import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgentCore

@MainActor
@Suite("Phone approval review")
struct ReviewedApprovalTests {
  @Test(arguments: ["offline", "changed", "expired", "decided", "handover"])
  func refusesAnUnreviewedOrUnavailableDecision(condition: String) async {
    let client = FakeDaemonClient()
    let store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
    let reviewed = Fixture.approval(expiresAt: condition == "expired" ? 900 : 2_000)
    var current = reviewed
    if condition == "changed" { current.input = ["element": "A different order"] }
    if condition == "decided" { current.status = .denied }
    store.apply(.approvalUpsert(current))
    if condition == "handover" {
      store.apply(
        .agentStatus(
          Fixture.status(
            placement: AgentPlacementStatus(
              placement: .thisDevice,
              runsOn: AgentRunsOn(
                deviceId: "host_new", name: "Test host",
                thisDevice: true, alwaysOnMachine: false), relay: .off))))
    }

    #expect(
      await !store.decideReviewedApproval(
        reviewed, decision: .approve, scope: .always,
        reviewedRunner: nil, authorizationAvailable: condition != "offline"))
    #expect(client.calls.isEmpty)
    #expect(store.approvals[reviewed.id] == current)
  }

  @Test func sendsTheReviewedScopeAndAdoptsTheBrokerResponse() async {
    let client = FakeDaemonClient()
    let store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
    let reviewed = Fixture.approval(expiresAt: 2_000)
    store.apply(.approvalUpsert(reviewed))
    client.script {
      $0.decideApproval = { id, request in
        #expect(id == reviewed.id)
        #expect(request.scope == .task)
        var result = reviewed
        result.status = .approved
        result.scope = request.scope
        result.decidedAt = 1_100
        return result
      }
    }
    #expect(
      await store.decideReviewedApproval(
        reviewed, decision: .approve, scope: .task, reviewedRunner: nil,
        authorizationAvailable: true))
    #expect(store.approvals[reviewed.id]?.status == .approved)
    #expect(store.approvals[reviewed.id]?.decidedAt == 1_100)
  }
}
