import AppKit
import DailyDoListModels
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

/// The app on a 5,000-note vault with the daily notes folder open in the sidebar (2,000 rows) and
/// a 2,000-line note restored as the last session's active tab, in an offscreen window: each
/// sample includes SwiftUI's layout and drawing. Numbers: docs/PERFORMANCE.md.
@MainActor
@Suite("Performance", .serialized)
struct PerformanceTests {
  static let paths =
    (0..<2_000).map { "Daily/Day \($0).md" }
    + (0..<3_000).map { "Projects/\($0 / 50)/Plan \($0).md" }
  static let longNote = "Projects/0/Plan 0.md"
  static let notes = Dictionary(uniqueKeysWithValues: paths.map { ($0, "- [ ] Follow up") })
    .merging([
      longNote: (0..<2_000).map { "- [ ] Call vendor \($0) about [[Plan \($0)]]" }
        .joined(separator: "\n")
    ]) { $1 }

  func booted() async throws -> (AppModel, Workspace) {
    let environment = makeEnvironment(client: FakeDaemonClient(notes: Self.notes))
    environment.preferences.expandedFolders = ["Daily"]
    environment.preferences.lastOpenTabs = [Self.longNote, "Daily/Day 1.md"]
    environment.preferences.lastActiveTab = Self.longNote
    let model = AppModel(environment: environment)
    await model.boot()
    return (model, try #require(model.workspace))
  }

  func window(_ model: AppModel, _ workspace: Workspace) -> NSWindow {
    Perf.window(
      WorkspaceView(model: model, workspace: workspace, ui: model.ui)
        .environment(\.tooltipCenter, SnapshotTests.quietTooltips),
      size: CGSize(width: 1_280, height: 800))
  }

  @Test func bootToTodaysNote() async throws {
    var models: [AppModel] = []
    let ms = try await Perf.median("boot to today's note", runs: 5) { _ in
      models.append(try await booted().0)
    }
    #expect(models.allSatisfy { $0.workspace?.activePath == "Daily/2026-09-23.md" })
    #expect(ms < 500 * Perf.multiplier)
    for model in models { await model.teardown() }
  }

  @Test func windowOpens() async throws {
    let (model, workspace) = try await booted()
    let ms = await Perf.median("window opens", runs: 5) { _ in
      let window = window(model, workspace)
      window.render()
      window.close()
    }
    #expect(ms < 1_000 * Perf.multiplier)
    await model.teardown()
  }

  @Test func vaultChangedAddsANote() async throws {
    let (model, workspace) = try await booted()
    let window = window(model, workspace)
    window.render()
    let ms = await Perf.median("vault.changed adds a note", runs: 21) { i in
      model.route(
        .vaultChanged(
          VaultChangedEvent(
            changes: [VaultChange(path: "Daily/New \(i).md", kind: .created, version: "v1")],
            origin: .external)))
      window.render()
    }
    #expect(ms < 250 * Perf.multiplier)
    window.close()
    await model.teardown()
  }

  @Test func quickSwitcherKeystroke() async {
    let palette = PaletteModel(mode: .switcher, files: Self.paths)
    let query = Array("plan 2345")
    let ms = await Perf.median("quick switcher keystroke", runs: query.count) { i in
      palette.query.append(query[i])
    }
    #expect(palette.items.first?.title == "Plan 2345")
    #expect(ms < 150 * Perf.multiplier)
  }
}
