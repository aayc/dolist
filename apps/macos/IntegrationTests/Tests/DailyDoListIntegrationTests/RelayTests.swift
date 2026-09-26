import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

/// The laptop relaying to the always-on machine. While the link is up, its agent reads and
/// actions go to the machine and the machine's agent events reach the laptop's clients; while it
/// isn't, the synced copy answers reads and actions get 503 with the relay's reason. Every test
/// starts the sync service and two daemons and waits for the machine to run the agent as the
/// always-on machine (a lease renewal or two), so this suite is slow.
@MainActor
@Suite(
  "The relay to the always-on machine",
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() },
  .enabled(IntegrationEnvironment.syncSkipReason) { IntegrationEnvironment.isSyncAvailable })
struct Relay {
  /// The relay's reasons (the daemon's `RELAY_PROBLEMS`).
  static let unreachable = "The always-on machine can't be reached."
  static let notPaired = "This device isn't paired with the always-on machine."
  static let rejected = "The always-on machine no longer accepts this device. Pair it again."

  @Test func theLaptopWorksThroughTheMachineAndReadsTheSyncedCopyWithoutIt() async throws {
    try await withRelayedLaptop { devices in
      let client = devices.client
      let log = devices.log
      let onMachine = devices.onMachine

      // Paired: the relay connects first (nothing wrong yet), then forwards.
      let reported = log.items[devices.pairedMark...].compactMap { item -> AgentStatusResponse? in
        guard case .event(.agentStatus(let status)) = item, let relay = status.placement?.relay,
          relay != .off
        else { return nil }
        return status
      }
      #expect(reported.first?.placement?.relay == .connecting)
      #expect(reported.first?.problem == nil, "connecting isn't a problem")

      // Connected: the machine's agent under the laptop's own placement, nothing wrong with it.
      let status = try await client.agentStatus()
      let placement = try #require(status.placement)
      #expect(placement.placement == .alwaysOnMachine && placement.relay == .connected)
      #expect(
        placement.runsOn
          == AgentRunsOn(
            deviceId: devices.machineId, name: "vm-name", thisDevice: false,
            alwaysOnMachine: true))
      #expect(status.problem == nil, "the machine runs the agent")
      #expect(status.mode == .mock && status.enabled)

      // The orchestrator's chat: the message goes to the machine's orchestrator, and the
      // thread's updates come back to the laptop's clients.
      let chatMark = log.mark
      let question = "What's left for today? \(unique())"
      #expect(try await client.postMessage(threadId: OrchestratorThread.id, text: question).ok)
      _ = try await log.event(from: chatMark, "the message, from the machine") { event -> Bool? in
        guard case .threadMessage(let update) = event, update.threadId == OrchestratorThread.id,
          case .text(let text) = update.message, text.text == question
        else { return nil }
        return true
      }
      #expect(try await onMachine.thread(OrchestratorThread.id).texts.contains(question))

      // An approval: the laptop writes the task, the machine's agent asks, the laptop decides.
      let task = "Order a replacement water filter \(unique())"
      let taskMark = log.mark
      _ = try await addTask(task, with: client)
      let record = try await log.record(from: taskMark, text: task, timeout: .seconds(90))
      let approval = try await log.pendingApproval(
        for: record, from: taskMark, timeout: .seconds(90))
      let pendingHere = try await client.approvals(status: .pending).map(\.id)
      #expect(try await pendingHere == onMachine.approvals(status: .pending).map(\.id))
      let decided = try await client.decideApproval(
        approval.id, ApprovalDecisionRequest(decision: .approve, scope: .once))
      #expect(decided.status == .approved)
      let there = try await onMachine.approvals(status: nil).first { $0.id == approval.id }
      #expect(there?.status == .approved)
      let done = try await log.record(from: taskMark, text: task, status: .done)
      let taskThread = try #require(done.threadId)
      _ = try await log.event(from: taskMark, "the task's thread") { event -> Bool? in
        if case .threadUpsert(let thread) = event, thread.id == taskThread { return true }
        return nil
      }
      let threadsHere = try await client.threads(notePath: nil, taskId: nil).map(\.id)
      let threadsThere = try await onMachine.threads(notePath: nil, taskId: nil).map(\.id)
      #expect(threadsHere.sorted() == threadsThere.sorted())

      // A routine: written on the laptop (a file), announced and run by the machine once it has
      // synced there. The laptop's own routine events are muted while it relays.
      let routineMark = log.mark
      let routine = try await client.createRoutine(
        CreateRoutineRequest(
          name: "Morning brief \(unique())", schedule: "every day at 7:00",
          instructions: "Summarize today's tasks."))
      _ = try await log.event(from: routineMark, "the machine's routines") { event -> Bool? in
        guard case .routinesChanged(let routines) = event else { return nil }
        return routines.contains { $0.id == routine.id } ? true : nil
      }
      _ = try await eventually("the routine on the machine", timeout: .seconds(30)) {
        try await onMachine.routines().routines.first { $0.id == routine.id }
      }
      let runMark = log.mark
      let run = try await client.runRoutine(routine.id)
      #expect(run.routine.id == routine.id)
      _ = try await log.event(from: runMark, "the run's thread") { event -> Bool? in
        if case .threadUpsert(let thread) = event, thread.id == run.threadId { return true }
        return nil
      }
      _ = try await log.event(from: runMark, "the run, in the routines") { event -> Bool? in
        guard case .routinesChanged(let routines) = event,
          let updated = routines.first(where: { $0.id == routine.id }), updated.runCount > 0
        else { return nil }
        return true
      }
      let runs = try await onMachine.threads(routineId: routine.id)
      #expect(runs.contains { $0.id == run.threadId })

      // Unreachable: the laptop serves the synced copy read-only and refuses actions.
      let downMark = log.mark
      await devices.machine.supervisor.stop()
      _ = try await log.placement(from: downMark, "the machine can't be reached") {
        $0.relay == .unreachable
      }
      let down = try await client.agentStatus()
      #expect(down.placement?.relay == .unreachable)
      #expect(down.problem == Self.unreachable)
      _ = try await log.event(from: downMark, "this device's routines again") { event -> Bool? in
        guard case .routinesChanged(let routines) = event else { return nil }
        return routines.contains { $0.id == routine.id } ? true : nil
      }
      _ = try await eventually("the synced threads", timeout: .seconds(30)) {
        let ids = Set(try await client.threads(notePath: nil, taskId: nil).map(\.id))
        return ids.isSuperset(of: [taskThread, run.threadId]) ? true : nil
      }
      #expect(try await client.thread(taskThread).thread.status == .done)
      #expect(try await client.routines().routines.contains { $0.id == routine.id })
      try await expectRefused(
        client, reason: Self.unreachable, thread: taskThread, routineId: routine.id)

      // Back: the laptop reconnects to the restarted machine and acts through it again.
      let upMark = log.mark
      #expect(await devices.machine.supervisor.start() != nil, "\(devices.machine.logTail)")
      _ = try await log.placement(from: upMark, timeout: .seconds(90), "connected again") {
        $0.relay == .connected
      }
      _ = try await eventually("the machine's agent back", timeout: .seconds(90)) {
        let status = try await client.agentStatus()
        return status.placement?.relay == .connected && status.problem == nil ? true : nil
      }
      let again = "Still there? \(unique())"
      #expect(try await client.postMessage(threadId: OrchestratorThread.id, text: again).ok)
      #expect(try await onMachine.thread(OrchestratorThread.id).texts.contains(again))
    }
  }

  @Test func aRevokedThenForgottenLaptopIsNotPaired() async throws {
    try await withRelayedLaptop { devices in
      let client = devices.client
      let log = devices.log

      // Revoked: the machine drops the laptop's credential, and the laptop says to pair again.
      let laptopEntry = try #require(
        try await devices.onMachine.pairedDevices().first { $0.kind == .daemon })
      let revokeMark = log.mark
      try await devices.onMachine.revokeDevice(laptopEntry.id)
      _ = try await log.placement(from: revokeMark, "the machine refuses the laptop") {
        $0.relay == .notPaired
      }
      let revoked = try await client.agentStatus()
      #expect(revoked.problem == Self.rejected)
      let check = try await client.checkMachine()
      #expect(check.paired && check.reachable == true && check.version == nil)
      #expect(check.error == "vm-name no longer accepts this device's credential: pair again.")
      _ = try await client.threads(notePath: nil, taskId: nil)
      try await expectRefused(client, reason: Self.rejected, thread: OrchestratorThread.id)

      // Paired again: relaying again.
      let pairMark = log.mark
      try await devices.pair()
      _ = try await log.placement(from: pairMark, "relaying again") { $0.relay == .connected }

      // Forgotten: not paired, until it's paired again.
      _ = try await client.forgetMachine()
      let forgotten = try await client.agentStatus()
      #expect(forgotten.placement?.relay == .notPaired)
      #expect(forgotten.problem == Self.notPaired)
      try await expectRefused(client, reason: Self.notPaired, thread: OrchestratorThread.id)
    }
  }

  /// Every relayed action answers 503 `agent_unavailable` with the relay's reason.
  private func expectRefused(
    _ client: HTTPDaemonClient, reason: String, thread: String, routineId: String? = nil,
    sourceLocation: SourceLocation = #_sourceLocation
  ) async throws {
    let refused = DaemonClientError.http(
      status: 503, body: ApiErrorBody(error: .agentUnavailable, message: reason))
    let message = await captureError {
      try await client.postMessage(threadId: OrchestratorThread.id, text: "Hello?")
    }
    #expect(message == refused, "posting a message", sourceLocation: sourceLocation)
    let retry = await captureError { try await client.retryThread(thread) }
    #expect(retry == refused, "retrying", sourceLocation: sourceLocation)
    let approval = await captureError {
      try await client.decideApproval("apr_unknown", ApprovalDecisionRequest(decision: .deny))
    }
    #expect(approval == refused, "deciding an approval", sourceLocation: sourceLocation)
    if let routineId {
      let run = await captureError { try await client.runRoutine(routineId) }
      #expect(run == refused, "running a routine", sourceLocation: sourceLocation)
    }
  }
}

/// Two daemons syncing one vault: the always-on machine (renamed `vm-name`) and a laptop that
/// chose it for the orchestrator before pairing, so the agent never moves.
@MainActor
struct RelayedLaptop {
  let machine: DaemonFixture
  let onMachine: HTTPDaemonClient
  let machineId: String
  let client: HTTPDaemonClient
  let log: EventLog
  /// Where the laptop's events stood when it was first paired.
  let pairedMark: Int

  /// Pairs the laptop through the machine's loopback address (plain http is fine there).
  func pair() async throws {
    let port = try machine.connection.baseURL.port ?? 0
    let code = try await onMachine.createPairingCode(PairingCodeRequest())
    _ = try await client.pairMachine(
      MachinePairRequest(url: "http://127.0.0.1:\(port)", code: code.code, name: "vm-name"))
  }
}

/// Runs `body` once the laptop relays to the machine running the agent as the always-on machine.
@MainActor
func withRelayedLaptop(_ body: (RelayedLaptop) async throws -> Void) async throws {
  let sync = try await SyncServiceFixture.launch()
  defer { sync.shutdown() }
  let machineEnvironment = sync.environment.merging(["DDL_AGENT_PLACEMENT": "always_on_host"]) {
    $1
  }
  try await withDaemon(environment: machineEnvironment) { machine in
    try await withDaemon { laptop in
      let onMachine = try machine.makeClient()
      let machineDevice = try await onMachine.updateDeviceSettings(
        DeviceSettingsPatch(name: "vm-name"))
      _ = try await eventually("the machine runs its agent", timeout: .seconds(120)) {
        try await onMachine.agentStatus().placement?.runsOn?.thisDevice == true ? true : nil
      }
      let (client, log) = try await connectedClient(laptop)
      _ = try await client.setUpSync(
        DeviceSyncSetupRequest(url: sync.url, vault: sync.vault, token: sync.token))
      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .alwaysOnMachine))
      let devices = RelayedLaptop(
        machine: machine, onMachine: onMachine, machineId: machineDevice.device.id,
        client: client, log: log, pairedMark: log.mark)
      try await devices.pair()
      _ = try await log.placement(
        from: devices.pairedMark, timeout: .seconds(120),
        "the laptop relays to the always-on machine"
      ) { placement in
        placement.relay == .connected && placement.runsOn?.deviceId == machineDevice.device.id
          && placement.runsOn?.alwaysOnMachine == true
      }
      do {
        try await body(devices)
      } catch {
        await client.disconnect()
        throw error
      }
      await client.disconnect()
    }
  }
}
