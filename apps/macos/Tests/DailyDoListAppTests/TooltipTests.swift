import AppKit
import DailyDoListAgent
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
      "Show agent panel": .toggleAgentPanel,
    ]
    if workspace.tabs.canGoBack { expected["Back"] = .back }
    for (label, id) in expected {
      #expect(seen[label] == id.shortcut, "\(label) shows \(id.shortcut?.display ?? "no keys")")
    }
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
