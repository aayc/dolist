import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Offscreen renders of the shell with sample data, light and dark, written to
/// `apps/macos/.build/app-snapshots/` for review (not committed).
@MainActor
@Suite("Snapshots", .serialized)
struct SnapshotTests {
  static let outputDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent(".build/app-snapshots", isDirectory: true)

  /// Snapshot windows report to a center that never shows anything.
  static let quietTooltips = QuietTooltips.makeCenter()

  static let sampleNotes: [String: String] = [
    "Daily/2026-09-23.md": """
    # Wednesday
    - [x] Compare standing desks under $400
      - Example Rise Pro is the pick at $449, dual motor ([Desks Example](https://desks.example/rise-pro)) %%agent:thr_sample_desks%%
    - [ ] Reserve a table for Friday dinner
    - [ ] Call Trattoria Sole to confirm the table %%agent:thr_sample_booking%%
    - [ ] Draft the offsite agenda
      - 3 sessions, 1 walk
    How tall is Ridge Tower downtown?
    - [ ] Renew passport

    Notes from standup: ship the [[Launch Plan]] review by Friday.
    """,
    "Daily/2026-09-22.md": "- [x] Book dentist\n- [x] Pay electricity bill",
    "Daily/2026-09-19.md": "- [x] Plan hiking weekend",
    "Projects/Launch Plan.md": "# Launch plan\n- [ ] Draft announcement",
    "Projects/Reading List.md": "- The Pragmatic Programmer",
    "Templates/Daily.md": "- [ ] ",
    "Ideas.md": "Garden: raised beds",
    "Welcome.md": "Welcome to Daily Do List",
  ]

  @Test func agentPanelFitsTheDefaultWindow() async throws {
    let (model, workspace) = try await bootedModel()
    model.ui.inspectorPresented = true
    model.ui.selectedThreadId = SampleData.bookingThreadId
    let size = NSSize(width: 1180, height: 780)
    let hosting = NSHostingView(
      rootView: WorkspaceView(model: model, workspace: workspace, ui: model.ui).agentReferenceDate(
        referenceNow))
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<6 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      Self.pumpRunLoop(0.03)
    }
    #expect(
      hosting.fittingSize.width <= size.width,
      "sidebar, note and agent panel need \(hosting.fittingSize.width)pt")
    #expect(hosting.frame.width <= size.width, "the workspace grew to \(hosting.frame.width)pt")
    window.close()
    await model.teardown()
  }

  /// The sample workspace: notes, records and the sample agent store, today's note active. With a
  /// supervisor, the app manages the daemon.
  func bootedModel(
    supervisor: FakeSupervisor? = nil, computerAccess: ComputerAccessSystem = .inert
  ) async throws -> (AppModel, Workspace) {
    let client = FakeDaemonClient(notes: Self.sampleNotes)
    let daily = "Daily/2026-09-23.md"
    var question = TaskAgentRecord.sample(
      SampleData.questionAnchorId, note: daily, text: "How tall is Ridge Tower downtown?", line: 7,
      status: .done,
      summary: "About 1,250 ft", threadId: SampleData.questionThreadId)
    question.anchor = .line
    client.withState {
      $0.records[daily] = [
        .sample(
          "t1", note: daily, text: "Compare standing desks under $400", line: 1, status: .done,
          summary: "3 options", threadId: SampleData.desksThreadId),
        .sample(
          "t2", note: daily, text: "Reserve a table for Friday dinner", line: 3,
          status: .waitingApproval, threadId: SampleData.bookingThreadId),
        .sample(
          "t3", note: daily, text: "Draft the offsite agenda", line: 5, status: .working,
          summary: "Outlining sessions", threadId: SampleData.emailThreadId),
        question,
      ]
      $0.agentStatus.running = 1
    }
    let environment = makeEnvironment(
      client: client, supervisor: supervisor ?? FakeSupervisor(),
      mode: supervisor == nil ? .external : .managed, computerAccess: computerAccess)
    environment.preferences.expandedFolders = ["Daily", "Projects"]
    let model = AppModel(environment: environment)
    await model.boot()
    let workspace = try #require(model.workspace)
    let agent = SampleData.makeStore(now: referenceNow)
    model.agent = agent
    workspace.agent = agent
    await workspace.openNote("Projects/Launch Plan.md", OpenOptions(newTab: true))
    workspace.activateTab(daily)
    await settle()
    agent.apply(
      .taskRecords(
        TaskRecordsEvent(notePath: daily, records: client.withState { $0.records[daily] ?? [] })))
    workspace.editor.recomputeBadges()
    #expect(
      workspace.editor.controller.badges.map(\.label) == [
        "Done · 3 options", "Needs approval", "Outlining sessions", "Done · About 1,250 ft",
      ])
    #expect(
      workspace.editor.controller.badges.map(\.highlightsLine) == [false, false, false, true])
    return (model, workspace)
  }

  @Test func mainWindow() async throws {
    let (model, workspace) = try await bootedModel()
    let controller = workspace.editor.controller
    // The editor repaints badges in its visible rect, which only exists once it's on screen.
    let repaintBadges = { controller.setBadges(controller.badges) }
    for dark in [false, true] {
      model.ui.inspectorPresented = false
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1200, height: 760), dark: dark,
        name: "main-window", afterDisplay: repaintBadges)
      model.ui.inspectorPresented = true
      model.ui.selectedThreadId = nil
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1440, height: 800), dark: dark,
        name: "main-window-agent-panel", afterDisplay: repaintBadges)
      model.ui.selectedThreadId = SampleData.bookingThreadId
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1440, height: 800), dark: dark,
        name: "main-window-thread", afterDisplay: repaintBadges)
      // The anchored question's thread: an answer citing its sources and a note.
      model.ui.selectedThreadId = SampleData.questionThreadId
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1440, height: 800), dark: dark,
        name: "main-window-citations", afterDisplay: repaintBadges)
    }
    await model.teardown()
  }

  /// Demo mode as launched with `--demo`: the in-memory daemon's seed, with the agent's lines,
  /// its task, the anchored question and a thread citing its sources.
  @Test func demoWindow() async throws {
    let environment = makeEnvironment(
      client: FakeDaemonClient(), demo: true,
      demoClient: { InMemoryDaemonClient(seed: .demo, clock: .immediate(), agent: .enabled) })
    let model = AppModel(environment: environment)
    await model.boot()
    let workspace = try #require(model.workspace)
    await workspace.openToday()
    let controller = workspace.editor.controller
    try await eventually("demo badges", timeout: 5) {
      workspace.editor.recomputeBadges()
      return controller.badges.contains { $0.highlightsLine }
    }
    #expect(controller.text.contains("%%agent:thr_"))
    let question = try #require(controller.badges.first { $0.highlightsLine })
    let repaint = { controller.setBadges(controller.badges) }
    for dark in [false, true] {
      model.ui.inspectorPresented = true
      model.ui.selectedThreadId = question.threadId
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1440, height: 800), dark: dark,
        name: "main-window-demo", afterDisplay: repaint)
    }
    await model.teardown()
  }

  /// Tooltips where the app shows them (the real bubble, placed by the app's rules): a header
  /// button's, below it with its keycaps; a status bar item's; the agent panel's; and the empty
  /// state's rows with their keycaps.
  @Test func tooltips() async throws {
    let (model, workspace) = try await bootedModel()
    let controller = workspace.editor.controller
    let repaintBadges = { controller.setBadges(controller.badges) }
    model.ui.inspectorPresented = true
    model.ui.selectedThreadId = SampleData.bookingThreadId
    let size = CGSize(width: 1440, height: 800)
    let shots: [(name: String, label: String, index: Int)] = [
      ("tooltip-header", "New note", 1), ("tooltip-status-bar", "Open agent inbox", 0),
      ("tooltip-agent-panel", "Back to inbox", 0),
    ]
    for dark in [false, true] {
      for shot in shots {
        var found = false
        try await render(
          MainWindowView(model: model), size: size, dark: dark, name: shot.name,
          afterDisplay: repaintBadges
        ) { hosting in
          let snapshot = TooltipSnapshot.of(shot.label, in: hosting, index: shot.index)
          found = snapshot != nil
          return snapshot
        }
        #expect(found, "\(shot.label) has a tooltip")
      }
    }
    await model.teardown()
  }

  @Test func emptyState() async throws {
    let (model, workspace) = try await bootedModel()
    for dark in [false, true] {
      try await render(
        EmptyNoteView(workspace: workspace), size: CGSize(width: 700, height: 420), dark: dark,
        name: "empty-state")
    }
    await model.teardown()
  }

  @Test func paletteAndSwitcher() async throws {
    let (model, workspace) = try await bootedModel()
    let commands = PaletteModel(
      mode: .commands, commands: CommandCatalog(model: model).paletteCommands)
    let switcher = PaletteModel(
      mode: .switcher, files: workspace.vault.files, recent: workspace.recent,
      openTabs: workspace.tabs.tabs)
    switcher.query = "pla"
    for dark in [false, true] {
      try await render(
        panel(commands), size: CGSize(width: 640, height: 520), dark: dark, name: "command-palette")
      try await render(
        panel(switcher), size: CGSize(width: 640, height: 360), dark: dark, name: "quick-switcher")
    }
    await model.teardown()
  }

  @Test func settingsPanes() async throws {
    let (model, _) = try await bootedModel()
    let panes: [(String, AnyView)] = [
      (
        "settings-general",
        AnyView(GeneralSettingsPane(model: model, preferences: model.preferences))
      ),
      (
        "settings-appearance",
        AnyView(AppearanceSettingsPane(model: model, settings: model.settings))
      ),
      (
        "settings-daily-notes",
        AnyView(DailyNotesSettingsPane(model: model, settings: model.settings))
      ),
      ("settings-agent", AnyView(AgentSettingsPane(model: model, settings: model.settings))),
      ("settings-connectors", AnyView(ConnectorsSettingsPane(model: model))),
      ("settings-about", AnyView(AboutSettingsPane(model: model))),
    ]
    for dark in [false, true] {
      for (name, view) in panes {
        try await render(
          view.frame(width: 600, height: 640), size: CGSize(width: 600, height: 640), dark: dark,
          name: name)
      }
    }
    await model.settings.update(
      SettingsPatch(agent: .init(harness: .cursor, cursorModel: "gpt-5.5[reasoning=high]")))
    for dark in [false, true] {
      try await render(
        AgentSettingsPane(model: model, settings: model.settings).frame(width: 600, height: 1_000),
        size: CGSize(width: 600, height: 1_000), dark: dark, name: "settings-agent-cursor")
    }
    await model.teardown()
  }

  /// Settings → Computer Use in its states, the guide beside System Settings in each phase, and the
  /// main window's banner.
  @Test func computerUse() async throws {
    let fakes = ComputerAccessFakes()
    let scheduler = ManualScheduler()
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed, scheduler: scheduler,
        computerAccess: fakes.system()))
    await model.boot()
    supervisor.state = .running(pid: 42, connection: ComputerAccessAppTests.connection)
    let access = model.computerAccess
    let paneSize = CGSize(width: 600, height: 620)
    let pane = {
      ComputerUseSettingsPane(model: model, access: access).frame(width: 600, height: 620)
    }
    let guide = { (dark: Bool) in
      ComputerAccessGuideView(access: access)
        .background(Color(white: dark ? 0.16 : 0.9))
    }
    let bannerSize = CGSize(width: 900, height: 34)
    for dark in [false, true] {
      try await render(pane(), size: paneSize, dark: dark, name: "settings-computer-use")
      try await render(
        ComputerAccessBanner(model: model, kind: .setUp), size: bannerSize, dark: dark,
        name: "computer-access-banner")
    }

    access.request(.accessibility)
    for dark in [false, true] {
      try await render(
        guide(dark), size: ComputerAccessGuideLayout.panelSize, dark: dark,
        name: "computer-access-guide-accessibility")
    }
    fakes.probe.granted.insert(.accessibility)
    scheduler.advance(by: ComputerAccessSetup.pollInterval)
    for dark in [false, true] {
      try await render(
        guide(dark), size: ComputerAccessGuideLayout.panelSize, dark: dark,
        name: "computer-access-guide-granted")
    }
    access.continueGuide()
    for dark in [false, true] {
      try await render(
        guide(dark), size: ComputerAccessGuideLayout.panelSize, dark: dark,
        name: "computer-access-guide-screen-recording")
      try await render(pane(), size: paneSize, dark: dark, name: "settings-computer-use-relaunch")
      try await render(
        ComputerAccessBanner(model: model, kind: .relaunch), size: bannerSize, dark: dark,
        name: "computer-access-banner-relaunch")
    }
    fakes.probe.granted.insert(.screenRecording)
    scheduler.advance(by: ComputerAccessSetup.pollInterval)
    #expect(access.guide?.phase == .allSet)
    for dark in [false, true] {
      try await render(
        guide(dark), size: ComputerAccessGuideLayout.panelSize, dark: dark,
        name: "computer-access-guide-all-set")
      try await render(pane(), size: paneSize, dark: dark, name: "settings-computer-use-granted")
    }
    await model.teardown()

    // A daemon the app didn't start, in a copy signed ad hoc.
    let adHoc = ComputerAccessFakes(granted: [.accessibility])
    let other = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), mode: .managed, computerAccess: adHoc.system(adHoc: true)))
    await other.boot()
    #expect(other.daemonHost == .otherApp)
    for dark in [false, true] {
      try await render(
        ComputerUseSettingsPane(model: other, access: other.computerAccess)
          .frame(width: 600, height: 720), size: CGSize(width: 600, height: 720), dark: dark,
        name: "settings-computer-use-other-daemon")
    }
    await other.teardown()
  }

  /// The banner where it shows: under the tabs, above the note.
  @Test func mainWindowWithTheComputerUseBanner() async throws {
    let supervisor = FakeSupervisor()
    let (model, workspace) = try await bootedModel(
      supervisor: supervisor, computerAccess: ComputerAccessFakes().system())
    supervisor.state = .running(pid: 42, connection: ComputerAccessAppTests.connection)
    try await eventually { model.computerAccessBanner == .setUp }
    let controller = workspace.editor.controller
    let repaintBadges = { controller.setBadges(controller.badges) }
    for dark in [false, true] {
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1200, height: 760), dark: dark,
        name: "main-window-computer-use-banner", afterDisplay: repaintBadges)
    }
    await model.teardown()
  }

  /// Agent → Orchestrator Chat: the chat in its own window, and the window without an agent.
  @Test func orchestratorWindow() async throws {
    let (model, _) = try await bootedModel()
    let offline = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    for dark in [false, true] {
      try await render(
        OrchestratorWindowView(model: model), size: CGSize(width: 460, height: 720), dark: dark,
        name: "orchestrator-window")
      try await render(
        OrchestratorWindowView(model: offline), size: CGSize(width: 460, height: 420), dark: dark,
        name: "orchestrator-window-offline")
    }
    await model.teardown()
  }

  @Test func statusBarAndBootScreen() async throws {
    let (model, workspace) = try await bootedModel()
    let failed = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    failed.phase = .failed(
      .nodeMissing(
        detail:
          "Node.js 24.4 or newer is required to run the Daily Do List daemon, but no Node binary was found."
      ))
    let bar = StatusBar(model: model, workspace: workspace)
    let size = CGSize(width: 1000, height: 26)
    for dark in [false, true] {
      try await render(bar, size: size, dark: dark, name: "status-bar-quiet")
      try await render(
        BootScreen(model: failed), size: CGSize(width: 900, height: 520), dark: dark,
        name: "boot-error")
    }
    type("- [ ] unsaved change", in: workspace)
    model.connection.update(.reconnecting(attempt: 2, reason: nil))
    for dark in [false, true] {
      try await render(bar, size: size, dark: dark, name: "status-bar")
    }
    model.connection.setKind(.demo)
    model.connection.update(.connected(serverVersion: "demo"))
    for dark in [false, true] {
      try await render(bar, size: size, dark: dark, name: "status-bar-demo")
    }
    await model.teardown()
  }

  @Test func noteHeaders() async throws {
    let (model, workspace) = try await bootedModel()
    let headers = [
      ("note-header-today", "Daily/2026-09-23.md"), ("note-header-past-day", "Daily/2026-09-19.md"),
      ("note-header-note", "Projects/Launch Plan.md"),
    ]
    for dark in [false, true] {
      for (name, path) in headers {
        try await render(
          NoteHeaderView(workspace: workspace, path: path).frame(
            maxHeight: .infinity, alignment: .top
          ).background(Theme.background),
          size: CGSize(width: 760, height: 90), dark: dark, name: name)
      }
    }
    await model.teardown()
  }

  // MARK: - Rendering

  private func panel(_ palette: PaletteModel) -> some View {
    PalettePanel(palette: palette, onKey: { _ in }, onChoose: { _, _ in })
      .padding(30)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Theme.background)
  }

  @discardableResult
  private func render<V: View>(
    _ view: V, size: CGSize, dark: Bool, name: String, afterDisplay: (() -> Void)? = nil,
    tooltip: (@MainActor (NSView) -> TooltipSnapshot?)? = nil
  ) async throws -> URL {
    _ = NSApplication.shared
    let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    let content = SnapshotContent()
    let hosting = NSHostingView(
      rootView: SnapshotHost(content: content) {
        view.environment(\.colorScheme, dark ? .dark : .light).tint(Theme.accent)
          .agentReferenceDate(referenceNow)
          .environment(\.tooltipCenter, Self.quietTooltips)
      })
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.appearance = appearance
    window.isReleasedWhenClosed = false
    hosting.appearance = appearance
    hosting.frame = NSRect(origin: .zero, size: size)
    window.contentView = hosting
    // Ordered in, but off every screen: AppKit only builds some content (grouped forms, table
    // rows) for windows that are actually displayed.
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for pass in 0..<8 {
      if pass == 4 { afterDisplay?() }
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      Self.pumpRunLoop(0.03)
      try await Task.sleep(for: .milliseconds(10))
    }
    let bounds = hosting.bounds
    let drawn = try #require(hosting.bitmapImageRepForCachingDisplay(in: bounds))
    hosting.cacheDisplay(in: bounds, to: drawn)
    // Layer-backed content (grouped forms) only shows up when rendering the layer tree, and
    // split-view columns only in the window server's copy of the window.
    let candidates = [
      drawn, Self.renderLayers(of: hosting, appearance: appearance),
      Self.windowServerCapture(window),
    ]
    .compactMap { $0 }
    let rep = candidates.max { Self.distinctColors($0) < Self.distinctColors($1) } ?? drawn
    if let snapshot = tooltip?(hosting) {
      try snapshot.draw(into: rep, windowSize: bounds.size)
    }
    window.close()
    // The host outlives this call; emptied, it stops laying out views it shares with the next
    // snapshot (the one editor), which would otherwise get this window's geometry.
    content.isShown = false
    hosting.layoutSubtreeIfNeeded()
    let data = try #require(rep.representation(using: .png, properties: [:]))
    #expect(data.count > 2_000, "\(name) rendered something")
    #expect(Self.distinctColors(rep) > 4, "\(name) isn't a blank image")
    try FileManager.default.createDirectory(
      at: Self.outputDirectory, withIntermediateDirectories: true)
    let url = Self.outputDirectory.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
    try data.write(to: url)
    return url
  }

  /// Renders `view`'s layer tree into a bitmap (2x), over the window background color.
  private static func renderLayers(of view: NSView, appearance: NSAppearance?) -> NSBitmapImageRep?
  {
    guard let layer = view.layer else { return nil }
    let scale: CGFloat = 2
    let width = Int(view.bounds.width * scale)
    let height = Int(view.bounds.height * scale)
    guard
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
      ),
      let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return nil }
    let cg = context.cgContext
    var background = NSColor.windowBackgroundColor.cgColor
    (appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
      background = NSColor.windowBackgroundColor.cgColor
    }
    cg.setFillColor(background)
    cg.fill(CGRect(x: 0, y: 0, width: width, height: height))
    cg.scaleBy(x: scale, y: scale)
    if view.isFlipped {
      cg.translateBy(x: 0, y: view.bounds.height)
      cg.scaleBy(x: 1, y: -1)
    }
    layer.render(in: cg)
    return rep
  }

  /// The window server's image of `window` (nil without screen-capture access).
  private static func windowServerCapture(_ window: NSWindow) -> NSBitmapImageRep? {
    guard
      let image = CGWindowListCreateImage(
        .null, .optionIncludingWindow, CGWindowID(window.windowNumber),
        [.boundsIgnoreFraming, .bestResolution])
    else { return nil }
    return NSBitmapImageRep(cgImage: image)
  }

  /// AppKit-backed content (grouped forms, lists) commits on run-loop turns.
  private static func pumpRunLoop(_ interval: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(interval))
  }

  /// Distinct colors on a coarse grid (a blank render has one or two).
  private static func distinctColors(_ rep: NSBitmapImageRep) -> Int {
    var colors = Set<String>()
    let stepX = max(1, rep.pixelsWide / 40)
    let stepY = max(1, rep.pixelsHigh / 40)
    for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
      for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        colors.insert(
          String(
            format: "%.2f-%.2f-%.2f", color.redComponent, color.greenComponent, color.blueComponent)
        )
      }
    }
    return colors.count
  }
}

/// Whether a snapshot's host still shows its content.
@MainActor
@Observable
private final class SnapshotContent {
  var isShown = true
}

private struct SnapshotHost<Content: View>: View {
  let content: SnapshotContent
  @ViewBuilder let view: () -> Content

  var body: some View {
    if content.isShown { view() }
  }
}
