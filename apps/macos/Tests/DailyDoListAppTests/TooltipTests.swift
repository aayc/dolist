import AppKit
import DailyDoListAgent
import DailyDoListAgentTestSupport
import DailyDoListClientTestSupport
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Shortcuts come from the command catalog, never from text: every control that runs a command
/// shows the catalog's keys as keycaps, and no tooltip or label spells a shortcut out.
@MainActor
@Suite("Tooltips", .serialized)
struct TooltipTests {
  static let modifierGlyphs: Set<Character> = ["⌘", "⌥", "⌃", "⇧"]

  /// The tooltips of the workspace, laid out in an offscreen window.
  private func anchors(_ model: AppModel, _ workspace: Workspace) -> [TooltipAnchorView] {
    let size = CGSize(width: 1440, height: 800)
    let center = QuietTooltips.makeCenter()
    let hosting = NSHostingView(
      rootView: WorkspaceView(model: model, workspace: workspace, ui: model.ui)
        .agentReferenceDate(referenceNow)
        .environment(\.tooltipCenter, center))
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<6 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    }
    let anchors = tooltipAnchors(in: hosting)
    window.close()
    return anchors
  }

  @Test func controlsShowTheCatalogsShortcuts() async throws {
    let (model, workspace) = try await SnapshotTests().bootedModel()
    var seen: [String: KeyShortcut] = [:]
    func check(_ anchors: [TooltipAnchorView]) throws {
      #expect(anchors.count > 10)
      for anchor in anchors {
        guard let content = anchor.tooltipContent(), let first = content.lines.first else {
          continue
        }
        #expect(
          !content.plainText.contains(where: Self.modifierGlyphs.contains),
          "“\(content.plainText)” spells a shortcut out")
        if let command = anchor.command {
          let id = try #require(CommandID(rawValue: command), "\(command) is a command")
          if let keys = first.keys {
            #expect(keys == id.shortcut, "\(first.text) shows \(keys.display)")
          }
        }
        if let keys = first.keys { seen[first.text] = keys }
      }
    }
    // Sidebar, tabs, the daily note header, the status bar, and a thread in the agent panel.
    model.ui.inspectorPresented = true
    model.ui.selectedThreadId = SampleData.bookingThreadId
    try check(anchors(model, workspace))
    // The same controls in their other state.
    model.ui.sidebarVisible = false
    model.ui.inspectorPresented = false
    try check(anchors(model, workspace))

    var expected: [String: CommandID] = [
      "New note": .newNote, "Search vault": .search, "Hide sidebar": .toggleSidebar,
      "Show sidebar": .toggleSidebar, "Previous daily note": .previousDaily,
      "Close tab": .closeTab, "Open agent inbox": .agentInbox,
      "Hide agent panel": .toggleAgentPanel, "Back to inbox": .agentInbox,
      "Show agent panel": .toggleAgentPanel, "Stop": .stopTask,
    ]
    if workspace.tabs.canGoBack { expected["Back"] = .back }
    for (label, id) in expected {
      #expect(seen[label] == id.shortcut, "\(label) shows \(id.shortcut?.display ?? "no keys")")
    }
    await model.teardown()
  }

  /// The agent panel's Routines tab, New Routine button and way back show the catalog's keys.
  @Test func theRoutinesControlsShowTheCatalogsShortcuts() async throws {
    let (model, workspace) = try await SnapshotTests().bootedModel()
    func find(_ label: String) -> TooltipAnchorView? {
      anchors(model, workspace).first { $0.tooltipContent()?.lines.first?.text == label }
    }
    model.ui.showInbox()
    let tab = try #require(find("Routines"))
    #expect(tab.command == CommandID.showRoutines.rawValue)
    #expect(tab.tooltipContent()?.lines.first?.keys == CommandID.showRoutines.shortcut)
    #expect(
      find("Agent inbox")?.tooltipContent()?.lines.first?.keys == CommandID.agentInbox.shortcut)

    model.ui.showRoutines()
    let new = try #require(find("New routine"))
    #expect(new.command == CommandID.newRoutine.rawValue)
    #expect(new.tooltipContent()?.lines.first?.keys == CommandID.newRoutine.shortcut)

    model.ui.showRoutine(try #require(model.agent?.routines.first?.id))
    let back = try #require(find("Back to routines"))
    #expect(back.tooltipContent()?.lines.first?.keys == CommandID.showRoutines.shortcut)
    #expect(find("Pause routine") != nil && find("Edit routine file") != nil)
    await model.teardown()
  }

  /// The computer use banner's button runs the catalog's command; its dismiss button says that
  /// dismissing is for good.
  @Test func theComputerUseBannerRunsItsCommand() throws {
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), computerAccess: ComputerAccessFakes().system()))
    let size = CGSize(width: 900, height: 34)
    let hosting = NSHostingView(
      rootView: ComputerAccessBanner(model: model, kind: .setUp)
        .environment(\.tooltipCenter, QuietTooltips.makeCenter()))
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    defer { window.close() }
    for _ in 0..<4 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let anchors = tooltipAnchors(in: hosting)
    let setUp = try #require(
      anchors.first { $0.command == CommandID.setUpComputerUse.rawValue }, "Set Up… runs it")
    #expect(setUp.tooltipContent()?.plainText == "Open Settings → Computer Use")
    #expect(setUp.tooltipContent()?.lines.first?.keys == CommandID.setUpComputerUse.shortcut)
    #expect(anchors.contains { $0.tooltipContent()?.plainText == "Don't show again" })
    #expect(
      !anchors.contains { $0.tooltipContent()?.plainText.contains("apps that have no") == true },
      "the detail fits at this width, so it has no tooltip")
  }

  /// The status bar names a policy other than the default, and clicking it runs the command that
  /// opens Settings → Agent.
  @Test func theApprovalPolicyItemRunsItsCommand() async throws {
    let (model, workspace) = try await SnapshotTests().bootedModel()
    let item = { (anchors: [TooltipAnchorView]) in
      anchors.first { $0.command == CommandID.approvalPolicy.rawValue }
    }
    #expect(item(anchors(model, workspace)) == nil, "quiet with the default policy")

    await model.settings.update(SettingsPatch(agent: .init(approvalPolicy: .runEverything)))
    let everything = try #require(item(anchors(model, workspace)))
    #expect(
      everything.tooltipContent()?.plainText
        == "Agents run everything without asking — click to change")
    #expect(everything.tooltipContent()?.lines.first?.keys == CommandID.approvalPolicy.shortcut)

    await model.settings.update(SettingsPatch(agent: .init(approvalPolicy: .askEveryAction)))
    let every = try #require(item(anchors(model, workspace)))
    #expect(
      every.tooltipContent()?.plainText
        == "Agents ask before every action that changes something — click to change")
    await model.teardown()
  }

  /// The orchestrator's indicators (the note header while it works on the open note, the status
  /// bar while it works elsewhere) say what woke it and open its chat.
  @Test func theOrchestratorIndicatorsOpenItsChat() async throws {
    let (model, workspace) = try await SnapshotTests().bootedModel()
    let daily = "Daily/2026-09-23.md"
    func indicators() -> [TooltipAnchorView] {
      anchors(model, workspace).filter { $0.command == CommandID.orchestratorChat.rawValue }
    }
    #expect(indicators().isEmpty, "nothing while it's idle")

    workspace.orchestrator.apply(
      .note(.thinking, daily, [(10, "Notes from standup")], turn: "msg_1"))
    let header = try #require(indicators().first)
    #expect(
      header.tooltipContent()?.plainText
        == "Woken by “Notes from standup” — open the orchestrator chat")
    #expect(header.tooltipContent()?.lines.first?.keys == CommandID.orchestratorChat.shortcut)

    workspace.orchestrator.apply(
      .note(.acting, "Projects/Launch Plan.md", [(1, "- [ ] Draft announcement")], turn: "msg_2"))
    let item = try #require(indicators().first)
    #expect(
      item.tooltipContent()?.plainText
        == "Woken by “- [ ] Draft announcement” — open the orchestrator chat")
    #expect(indicators().count == 1, "the header's indicator is only for the open note")
    await model.teardown()
  }

  @Test func thePaletteShowsTheCatalogsShortcuts() async throws {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    await model.boot()
    let palette = PaletteModel(
      mode: .commands, commands: CommandCatalog(model: model).paletteCommands)
    #expect(!palette.items.isEmpty)
    for item in palette.items {
      guard case .command(let id) = item.kind else { continue }
      #expect(item.shortcut == id.shortcut, "\(id)")
    }
    await model.teardown()
  }

  /// A shortcut written into a string would drift from the catalog: `.help` is gone, and glyph
  /// strings only exist where keys are formatted or typed shortcuts parsed.
  @Test func noShortcutIsWrittenIntoText() throws {
    let macos = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let allowed: Set<String> = [
      // Formats keycaps.
      "Packages/DailyDoListUI/Sources/DailyDoListUI/Keys/KeyShortcut.swift",
      // Parses the global shortcut typed in Settings, and explains a rejected one.
      "Sources/DailyDoListApp/System/GlobalShortcut.swift",
      "Sources/DailyDoListApp/System/GlobalHotKeyCenter.swift",
    ]
    let roots =
      [macos.appendingPathComponent("Sources")]
      + (try FileManager.default.contentsOfDirectory(
        at: macos.appendingPathComponent("Packages"), includingPropertiesForKeys: nil)).map {
        $0.appendingPathComponent("Sources")
      }
    let glyphString = try Regex(#""[^"]*[⌘⌥⌃⇧][^"]*""#)
    var offenders: [String] = []
    var scanned = 0
    for root in roots {
      guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
      else { continue }
      for case let file as URL in files where file.pathExtension == "swift" {
        scanned += 1
        let relative = String(file.path.dropFirst(macos.path.count + 1))
        let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
          let code = line.components(separatedBy: "//").first ?? line
          if code.contains(".help(") { offenders.append("\(relative):\(index + 1): .help") }
          if !allowed.contains(relative), code.contains(glyphString) {
            offenders.append(
              "\(relative):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
          }
        }
      }
    }
    #expect(scanned > 100, "scanned \(scanned) files")
    #expect(offenders.isEmpty, "\n\(offenders.joined(separator: "\n"))")
  }
}
