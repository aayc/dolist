import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListDrawing
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Offscreen renders of the key screens with sample data, light and dark, written to
/// `apps/macos/.build/app-snapshots/` for reviewing UI changes by eye (not committed): the main
/// window, the agent panel with a thread, settings, and a note with a drawing. They only check
/// that something was drawn; behavior belongs in the other suites.
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

  /// The sample workspace: notes, records and the sample agent store, today's note active.
  func bootedModel() async throws -> (AppModel, Workspace) {
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
    let environment = makeEnvironment(client: client)
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
      model.ui.selectedThreadId = SampleData.bookingThreadId
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1440, height: 800), dark: dark,
        name: "main-window-thread", afterDisplay: repaintBadges)
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
      ("settings-agent", AnyView(AgentSettingsPane(model: model, settings: model.settings))),
    ]
    for dark in [false, true] {
      for (name, view) in panes {
        try await render(
          view.frame(width: 600, height: 640), size: CGSize(width: 600, height: 640), dark: dark,
          name: name)
      }
    }
    await model.teardown()
  }

  /// A note with a floated drawing the text wraps around.
  @Test func drawings() async throws {
    var box = DrawingFiles.element("box", x: 0)
    box.width = 180
    box.height = 110
    box.backgroundColor = "#b2f2bb"
    box.fillStyle = .solid
    var oval = ExcalidrawElement(id: "oval", type: .ellipse)
    oval.x = 240
    oval.y = 0
    oval.width = 160
    oval.height = 110
    oval.seed = 3
    oval.strokeColor = "#1971c2"
    let plan = ExcalidrawMarkdown.newFile(for: ExcalidrawScene(elements: [box, oval]))
    let note = """
      # Kitchen remodel
      ![[Plan.excalidraw|300|right-wrap]]
      The plan floats on the right and this paragraph wraps around it, line after line, the way \
      Obsidian's live preview does it. Typing here never runs into the drawing.

      - [ ] Measure the counter
      - [ ] Pick tiles
      """
    let client = FakeDaemonClient(notes: [
      "Kitchen.md": note, "Excalidraw/Plan.excalidraw.md": plan, "Templates/Daily.md": "- [ ] ",
    ])
    let scheduler = ManualScheduler()
    let model = AppModel(environment: makeEnvironment(client: client, scheduler: scheduler))
    await model.boot()
    let workspace = try #require(model.workspace)
    await workspace.openNote("Kitchen.md")
    _ = workspace.drawingState(forDocument: "Excalidraw/Plan.excalidraw.md", revision: 0)
    try await eventually { workspace.drawings.has("Excalidraw/Plan.excalidraw.md") }
    scheduler.advance(by: 0)
    let controller = workspace.editor.controller
    controller.moveCaretToEnd()
    for dark in [false, true] {
      model.ui.inspectorPresented = false
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1200, height: 760), dark: dark,
        name: "main-window-drawing")
    }
    await model.teardown()
  }

  // MARK: - Rendering

  @discardableResult
  func render<V: View>(
    _ view: V, size: CGSize, dark: Bool, name: String, afterDisplay: (() -> Void)? = nil
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
  static func pumpRunLoop(_ interval: TimeInterval) {
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
