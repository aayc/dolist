import AppKit
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// The permissions state machine: macOS's prompt first, then the exact System Settings list (with
/// fallbacks), a guide that checks each permission off while polling, polling that stops, and the
/// relaunch Screen Recording needs.
@MainActor
@Suite("Computer access")
struct ComputerAccessTests {
  static let accessibilityLink =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  static let screenRecordingLink =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"

  private func make(_ fakes: ComputerAccessFakes, _ scheduler: ManualScheduler) -> ComputerAccess {
    ComputerAccess(system: fakes.system(), scheduler: scheduler)
  }

  @Test func readsBothPermissions() {
    let fakes = ComputerAccessFakes(granted: [.accessibility])
    let access = make(fakes, ManualScheduler())
    #expect(access.accessibility == .granted)
    #expect(access.screenRecording == .notGranted)
    #expect(access.missing == [.screenRecording])
    #expect(!access.isComplete)
    #expect(!access.isPolling, "nothing is showing, so nothing polls")
    #expect(fakes.probe.prompts.isEmpty, "reading never prompts")
  }

  @Test func accessibilityPromptsFirstThenOpensItsListWithTheGuide() throws {
    let fakes = ComputerAccessFakes()
    let access = make(fakes, ManualScheduler())
    access.request(.accessibility)
    #expect(fakes.log == ["prompt accessibility", "open \(Self.accessibilityLink)"])
    let guide = try #require(access.guide)
    #expect(guide.permission == .accessibility)
    #expect(guide.phase == .waiting)
    #expect(guide.steps == [.accessibility, .screenRecording])
    #expect(guide.stepLabel == "Step 1 of 2")
    #expect(fakes.presenter.showCount == 1)
    #expect(access.isPolling)
    #expect(access.accessibility == .notGranted)
  }

  @Test func linksFallBackUntilOneOpens() {
    let fakes = ComputerAccessFakes()
    let links = ComputerPermission.accessibility.settingsURLs
    fakes.opener.rejected = Set(links.prefix(2))
    let access = make(fakes, ManualScheduler())
    access.request(.accessibility)
    #expect(fakes.opener.attempts == Array(links.prefix(3)), "the first that opens wins")
    #expect(access.guide != nil)
    #expect(access.problem == nil)
  }

  @Test func whenNoLinkOpensItSaysWhereToGo() {
    let fakes = ComputerAccessFakes()
    fakes.opener.rejected = Set(ComputerPermission.screenRecording.settingsURLs)
    let access = ComputerAccess(
      system: fakes.system(macOSMajorVersion: 15), scheduler: ManualScheduler())
    access.request(.screenRecording)
    #expect(fakes.opener.attempts == ComputerPermission.screenRecording.settingsURLs)
    #expect(
      access.problem
        == "Couldn't open System Settings. Open it and go to Privacy & Security → Screen & System Audio Recording."
    )
    #expect(access.guide == nil)
    #expect(fakes.presenter.showCount == 0)
    #expect(!access.isPolling)
    #expect(access.screenRecording == .notGranted, "never sent there, so no relaunch is offered")
  }

  @Test func aGrantIsSeenWhilePollingAndTheNextStepIsOffered() throws {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.request(.accessibility)
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.guide?.phase == .waiting)

    fakes.probe.granted.insert(.accessibility)
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.accessibility == .granted)
    #expect(access.guide?.phase == .granted)
    #expect(access.nextPermission == .screenRecording)
    #expect(fakes.presenter.isShowing, "the guide waits for Next or Later")

    access.finishGuide()
    #expect(access.guide == nil)
    #expect(fakes.presenter.hideCount == 1)
    #expect(fakes.activations == 1, "Later brings Daily Do List back")
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(!access.isPolling, "nothing shows anymore")
    #expect(scheduler.pendingCount == 0)
  }

  @Test func theLastGrantSaysAllSetThenClosesAndBringsTheAppBack() throws {
    let fakes = ComputerAccessFakes(granted: [.screenRecording])
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.request(.accessibility)
    #expect(access.guide?.steps == [.accessibility])
    #expect(access.guide?.stepLabel == nil)

    fakes.probe.granted.insert(.accessibility)
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.isComplete)
    #expect(access.guide?.phase == .allSet)
    #expect(!access.isPolling, "everything is granted")

    scheduler.advance(by: ComputerAccess.allSetDuration - 0.1)
    #expect(access.guide?.phase == .allSet)
    #expect(fakes.activations == 0)
    scheduler.advance(by: 0.1)
    #expect(access.guide == nil)
    #expect(fakes.presenter.hideCount == 1)
    #expect(fakes.activations == 1)
    #expect(scheduler.pendingCount == 0)
  }

  @Test func screenRecordingPromptsOpensItsListAndOffersARelaunch() throws {
    let fakes = ComputerAccessFakes(granted: [.accessibility])
    let access = make(fakes, ManualScheduler())
    let requested = Captured<[ComputerPermission]>([])
    access.onRequest = { requested.value.append($0) }
    access.request(.screenRecording)
    #expect(fakes.log == ["prompt screenRecording", "open \(Self.screenRecordingLink)"])
    #expect(access.screenRecording == .awaitingRelaunch)
    #expect(access.needsRelaunch)
    #expect(
      access.guide
        == ComputerAccessGuide(
          permission: .screenRecording, phase: .waiting, steps: [.screenRecording]))
    #expect(requested.value == [.screenRecording])
  }

  @Test func relaunchRunsOnceAtATime() async throws {
    let fakes = ComputerAccessFakes()
    let access = make(fakes, ManualScheduler())
    let relaunches = Captured(0)
    let release = Captured<CheckedContinuation<Void, Never>?>(nil)
    access.onRelaunch = {
      relaunches.value += 1
      await withCheckedContinuation { release.value = $0 }
    }
    access.relaunch()
    try await eventually { release.value != nil }
    #expect(access.isRelaunching)
    access.relaunch()
    await settle()
    #expect(relaunches.value == 1)
    release.value?.resume()
    try await eventually { !access.isRelaunching }
  }

  @Test func relaunchIsntOfferedWhereItCantWork() {
    let fakes = ComputerAccessFakes()
    fakes.relauncher.unavailableReason = "Only the packaged app can relaunch itself."
    let access = make(fakes, ManualScheduler())
    let relaunches = Captured(0)
    access.onRelaunch = { relaunches.value += 1 }
    access.relaunch()
    #expect(!access.isRelaunching)
    #expect(relaunches.value == 0)
    #expect(access.relaunchUnavailableReason == "Only the packaged app can relaunch itself.")
  }

  @Test func nextGoesFromAccessibilityToScreenRecordingInTheSamePanel() throws {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.request(.accessibility)
    fakes.probe.granted.insert(.accessibility)
    scheduler.advance(by: ComputerAccess.pollInterval)
    access.continueGuide()
    #expect(fakes.probe.prompts == [.accessibility, .screenRecording])
    #expect(fakes.opener.attempts.last?.absoluteString == Self.screenRecordingLink)
    let guide = try #require(access.guide)
    #expect(guide.permission == .screenRecording)
    #expect(guide.phase == .waiting)
    #expect(guide.stepLabel == "Step 2 of 2")
    #expect(fakes.presenter.showCount == 1, "the panel stays up and changes")
    #expect(fakes.presenter.hideCount == 0)
  }

  @Test func nothingIsAskedForWhatsAlreadyGranted() {
    let fakes = ComputerAccessFakes(granted: [.accessibility, .screenRecording])
    let access = make(fakes, ManualScheduler())
    access.request(.accessibility)
    access.request(.screenRecording)
    #expect(fakes.log.isEmpty)
    #expect(access.guide == nil)

    let trusted = ComputerAccessFakes()
    trusted.probe.grantsOnRequest = [.accessibility]
    let second = make(trusted, ManualScheduler())
    second.request(.accessibility)
    #expect(trusted.log == ["prompt accessibility"], "macOS said yes at once: no System Settings")
    #expect(second.accessibility == .granted)
    #expect(second.guide == nil)
  }

  @Test func pollsOnlyWhileTheSettingsShowOrSystemSettingsIsInFront() {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.settingsPaneAppeared()
    #expect(access.isPolling)
    scheduler.advance(by: ComputerAccess.pollInterval * 3)
    #expect(access.isPolling)
    access.settingsPaneDisappeared()
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(!access.isPolling)
    #expect(scheduler.pendingCount == 0)

    fakes.systemSettings.isFrontmost = true
    access.settingsPaneAppeared()
    access.settingsPaneDisappeared()
    scheduler.advance(by: ComputerAccess.pollInterval * 3)
    #expect(access.isPolling, "System Settings is in front")
    fakes.systemSettings.isFrontmost = false
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(!access.isPolling)
  }

  @Test func pollingStopsOnceEverythingIsGranted() {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.settingsPaneAppeared()
    fakes.probe.granted = [.accessibility, .screenRecording]
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.isComplete)
    #expect(!access.isPolling, "the pane still shows, but there's nothing left to wait for")
    #expect(scheduler.pendingCount == 0)
  }

  @Test func quittingSystemSettingsClosesTheGuide() {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let access = make(fakes, scheduler)
    access.request(.accessibility)
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.guide != nil, "System Settings may still be launching")
    fakes.systemSettings.isRunning = true
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.guide != nil)
    fakes.systemSettings.isRunning = false
    scheduler.advance(by: ComputerAccess.pollInterval)
    #expect(access.guide == nil)
    #expect(fakes.presenter.hideCount == 1)
    #expect(fakes.activations == 0, "the user left System Settings for somewhere else")
  }

  @Test func settingsLinksAndListNames() {
    #expect(
      ComputerPermission.accessibility.settingsURLs.map(\.absoluteString) == [
        Self.accessibilityLink,
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
        "x-apple.systempreferences:com.apple.preference.security",
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
      ])
    #expect(
      ComputerPermission.screenRecording.settingsURLs.prefix(2).map(\.absoluteString) == [
        Self.screenRecordingLink,
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
      ])
    #expect(
      ComputerPermission.accessibility.settingsListName(macOSMajorVersion: 26) == "Accessibility")
    #expect(
      ComputerPermission.screenRecording.settingsListName(macOSMajorVersion: 14)
        == "Screen Recording")
    #expect(
      ComputerPermission.screenRecording.settingsListName(macOSMajorVersion: 26)
        == "Screen & System Audio Recording")
  }

  @Test func voiceOverHearsEachPermissionComeThrough() {
    let waiting = ComputerAccessGuide(
      permission: .accessibility, phase: .waiting, steps: [.accessibility, .screenRecording])
    var granted = waiting
    granted.phase = .granted
    var allSet = waiting
    allSet.phase = .allSet
    #expect(ComputerAccessGuideView.announcement(from: nil, to: waiting) == nil)
    #expect(
      ComputerAccessGuideView.announcement(from: waiting, to: granted) == "Accessibility is on")
    #expect(ComputerAccessGuideView.announcement(from: granted, to: granted) == nil)
    #expect(
      ComputerAccessGuideView.announcement(from: granted, to: allSet)
        == "All set. Agents can use your apps now.")
  }

  @Test func theAdHocCheckRunsOnceWhenFirstAsked() {
    let fakes = ComputerAccessFakes()
    let checks = Captured(0)
    var system = fakes.system()
    system.isSignedAdHoc = {
      checks.value += 1
      return true
    }
    let access = ComputerAccess(system: system, scheduler: ManualScheduler())
    #expect(checks.value == 0)
    #expect(access.isSignedAdHoc)
    #expect(access.isSignedAdHoc)
    #expect(checks.value == 1)
  }
}

/// A value the closures under test can change.
@MainActor
final class Captured<Value> {
  var value: Value

  init(_ value: Value) {
    self.value = value
  }
}

@MainActor
@Suite("Computer access banner")
struct ComputerAccessBannerTests {
  static let agentOn = AgentStatusResponse(
    mode: .live, enabled: true, model: "test/model", running: 0, queued: 0, pendingApprovals: 0,
    connectors: [],
    execution: ExecutionStatus(
      provider: "local",
      capabilities: ExecutionCapabilities(shell: true, browser: false, computer: true)))

  private func kind(
    _ accessibility: ComputerPermissionStatus = .notGranted,
    _ screenRecording: ComputerPermissionStatus = .notGranted,
    agent: AgentStatusResponse? = agentOn, host: DaemonHost = .thisApp, dismissed: Bool = false
  ) -> ComputerAccessBannerKind? {
    ComputerAccessBannerKind(
      accessibility: accessibility, screenRecording: screenRecording, agent: agent, host: host,
      dismissed: dismissed)
  }

  @Test func showsWhileAccessIsMissingAndTheAgentIsOn() {
    #expect(kind() == .setUp)
    #expect(kind(.granted, .notGranted) == .setUp)
    #expect(kind(.notGranted, .granted) == .setUp)
    #expect(kind(.notGranted, .awaitingRelaunch) == .setUp, "Accessibility is still to do")
    #expect(kind(.granted, .awaitingRelaunch) == .relaunch)
    #expect(kind(.granted, .granted) == nil)
  }

  @Test func staysAwayWhenTheAgentIsOffPausedOrCantRun() {
    var paused = Self.agentOn
    paused.enabled = false
    var off = Self.agentOn
    off.mode = .off
    var broken = Self.agentOn
    broken.problem = "OPENROUTER_API_KEY is missing"
    #expect(kind(agent: nil) == nil, "no status yet")
    #expect(kind(agent: paused) == nil)
    #expect(kind(agent: off) == nil)
    #expect(kind(agent: broken) == nil)
  }

  @Test func onlyForADaemonTheAppRunsItself() {
    #expect(kind(host: .otherApp) == nil)
    #expect(kind(host: .external) == nil)
    #expect(kind(host: .demo) == nil)
    #expect(kind(dismissed: true) == nil)
  }

  @Test func dismissalIsRememberedAcrossLaunches() async throws {
    let defaults = testDefaults()
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed, defaults: defaults,
        computerAccess: ComputerAccessFakes().system()))
    await model.boot()
    // The fake attaches when it starts; the app launched this one.
    supervisor.state = .running(pid: 42, connection: ComputerAccessAppTests.connection)
    try await eventually("the agent's status") { model.agent?.status != nil }
    #expect(model.daemonHost == .thisApp)
    #expect(model.computerAccessBanner == .setUp)

    model.dismissComputerAccessBanner()
    #expect(model.computerAccessBanner == nil)
    await model.teardown()

    let relaunched = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: FakeSupervisor(), mode: .managed,
        defaults: defaults, computerAccess: ComputerAccessFakes().system()))
    #expect(relaunched.preferences.computerAccessBannerDismissed)
    #expect(relaunched.computerAccessBanner == nil)
  }
}

@MainActor
@Suite("Computer access in the app")
struct ComputerAccessAppTests {
  static let connection = DaemonConnectionInfo(
    baseURL: URL(string: "http://127.0.0.1:7331")!, token: "test-token")

  @Test func daemonHostFollowsWhoStartedTheDaemon() {
    let supervisor = FakeSupervisor()
    let managed = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed))
    supervisor.state = .running(pid: 7, connection: Self.connection)
    #expect(managed.daemonHost == .thisApp)
    supervisor.state = .attached(connection: Self.connection)
    #expect(managed.daemonHost == .otherApp)
    supervisor.state = .restarting(attempt: 1, reason: "exited")
    #expect(managed.daemonHost == .thisApp, "it's about to run its own")

    let external = AppModel(
      environment: makeEnvironment(client: FakeDaemonClient(), mode: .external))
    #expect(external.daemonHost == .external)
    let demo = AppModel(environment: makeEnvironment(client: FakeDaemonClient(), demo: true))
    #expect(demo.daemonHost == .demo)
    #expect(DaemonHost.thisApp.permissionsNote == nil)
    #expect(DaemonHost.otherApp.permissionsNote?.contains("pnpm dev") == true)
  }

  @Test func theSetUpCommandOpensTheComputerUseSettings() throws {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    let catalog = CommandCatalog(model: model)
    let command = try #require(catalog.command(.setUpComputerUse))
    #expect(command.title == "Set Up Computer Use…")
    #expect(command.paletteTitle == "Set up computer use")
    #expect(command.shortcut == nil, "no default shortcut")
    #expect(
      catalog.paletteCommands.contains { $0.id == .setUpComputerUse },
      "in the palette even before the daemon connects")
    #expect(catalog.run(.setUpComputerUse))
    #expect(model.ui.settingsPane == .computerUse)
    #expect(CommandID(vimCommandID: "computerUse.setUp") == .setUpComputerUse)
  }

  @Test func relaunchStopsTheDaemonBeforeTheNewInstanceOpensThenQuits() async throws {
    let fakes = ComputerAccessFakes()
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed,
        computerAccess: fakes.system()))
    await model.boot()
    #expect(model.phase == .ready)
    let stopsWhenOpened = Captured<Int?>(nil)
    fakes.relauncher.onOpen = { stopsWhenOpened.value = supervisor.stopCount }
    await model.relaunch()
    #expect(stopsWhenOpened.value == 1, "the new instance starts its own daemon")
    #expect(fakes.relauncher.openCount == 1)
    #expect(fakes.relauncher.terminateCount == 1)
    #expect(fakes.log == ["open new instance", "terminate"])
  }

  @Test func aFailedRelaunchReconnectsAndSaysWhy() async throws {
    let fakes = ComputerAccessFakes()
    fakes.relauncher.failure = RelaunchFailed()
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed,
        computerAccess: fakes.system()))
    await model.boot()
    await model.relaunch()
    #expect(fakes.relauncher.terminateCount == 0)
    #expect(model.phase == .ready, "it booted again")
    #expect(supervisor.startCount == 2)
    #expect(model.toasts.toasts.contains { $0.title == "Couldn't relaunch Daily Do List" })
    await model.teardown()
  }

  @Test func requestingScreenRecordingIsRememberedForTheRelaunch() {
    let fakes = ComputerAccessFakes()
    let model = AppModel(
      environment: makeEnvironment(client: FakeDaemonClient(), computerAccess: fakes.system()))
    model.computerAccess.request(.accessibility)
    #expect(model.preferences.computerAccessRequestedAt == nil, "Accessibility applies live")
    model.computerAccess.request(.screenRecording)
    #expect(model.preferences.computerAccessRequestedAt == referenceNow)
  }

  @Test func aLaunchSoonAfterTheRequestContinuesTheSetup() {
    let defaults = testDefaults()
    let recent = AppModel(
      environment: makeEnvironment(client: FakeDaemonClient(), defaults: defaults))
    recent.preferences.computerAccessRequestedAt = referenceNow.addingTimeInterval(-90)
    recent.resumeComputerAccessSetup()
    #expect(recent.ui.settingsPane == .computerUse)
    #expect(recent.preferences.computerAccessRequestedAt == nil, "only once")

    let later = AppModel(
      environment: makeEnvironment(client: FakeDaemonClient(), defaults: defaults))
    later.preferences.computerAccessRequestedAt = referenceNow.addingTimeInterval(-3_600)
    later.resumeComputerAccessSetup()
    #expect(later.ui.settingsPane == .general, "an hour later it's just a launch")
    #expect(later.preferences.computerAccessRequestedAt == nil)
  }

  @Test func reopeningTheMainWindowBeforeTheRelaunchDoesntContinueTheSetup() {
    let fakes = ComputerAccessFakes(granted: [.accessibility])
    let model = AppModel(
      environment: makeEnvironment(client: FakeDaemonClient(), computerAccess: fakes.system()))
    model.computerAccess.request(.screenRecording)
    model.resumeComputerAccessSetup()
    #expect(model.ui.settingsPane == .general)
    #expect(model.preferences.computerAccessRequestedAt == referenceNow, "kept for the relaunch")
  }

  @Test func aRelaunchKeepsTheArgumentsAndDDLSettings() {
    let configuration = RelaunchConfiguration(
      arguments: ["/Applications/Daily Do List.app/Contents/MacOS/DailyDoList", "--demo"],
      environment: [
        "DDL_HOME": "/tmp/ddl-home", "DDL_AGENT_MODE": "mock", "PATH": "/usr/bin",
        "XPC_SERVICE_NAME": "application.app.dailydolist.mac.1",
      ])
    #expect(configuration.arguments == ["--demo"])
    #expect(configuration.environment == ["DDL_HOME": "/tmp/ddl-home", "DDL_AGENT_MODE": "mock"])
    #expect(
      RelaunchConfiguration.unavailableReason(
        bundleURL: URL(fileURLWithPath: "/Applications/Daily Do List.app")) == nil)
    #expect(
      RelaunchConfiguration.unavailableReason(
        bundleURL: URL(fileURLWithPath: "/tmp/ddl/.build/debug"))?.contains("packaged app") == true)
  }

  @Test func theGuideSitsAtTheRightEdgeOfTheScreen() {
    let screen = NSRect(x: 0, y: 0, width: 1512, height: 944)
    let frame = ComputerAccessGuideLayout.frame(in: screen)
    let cardRight = frame.maxX - ComputerAccessGuideLayout.margin
    #expect(cardRight == screen.maxX - ComputerAccessGuideLayout.screenInset)
    #expect(frame.maxX <= screen.maxX, "the shadow's margin stays on the screen")
    #expect(frame.minY >= screen.minY && frame.maxY <= screen.maxY)

    let second = NSRect(x: 1512, y: -200, width: 1280, height: 520)
    let small = ComputerAccessGuideLayout.frame(in: second)
    #expect(small.maxX - ComputerAccessGuideLayout.margin == second.maxX - 24)
    #expect(
      small.maxY - ComputerAccessGuideLayout.margin <= second.maxY, "the card's top is on screen")
  }

  @Test func theIconDragsTheAppBundle() throws {
    let url = URL(fileURLWithPath: "/Applications/Daily Do List.app")
    let view = AppIconDragView(icon: NSImage(size: NSSize(width: 32, height: 32)), bundleURL: url)
    view.frame = NSRect(x: 0, y: 0, width: 44, height: 44)
    let item = view.draggingItem()
    #expect((item.item as? NSURL) as URL? == url)
    #expect(item.draggingFrame == view.bounds)
    #expect(AppIconDragView.operations(for: .outsideApplication) == [.copy, .link, .generic])
    #expect(AppIconDragView.operations(for: .withinApplication) == [])
    #expect(view.acceptsFirstMouse(for: nil), "drags start although the panel isn't key")
  }
}
