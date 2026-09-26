import AppKit
import DailyDoListAgentTestSupport
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// Renders views offscreen (an `NSHostingView` in a borderless window, so AppKit-backed controls
/// draw too) and writes PNGs to `.build/agent-snapshots/`. The app's snapshots are the ones to
/// review by eye; these tests check what a view does once it's drawn.
@MainActor
enum SnapshotRenderer {
  static let directory: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent(".build/agent-snapshots", isDirectory: true)

  struct Rendered {
    var url: URL
    var bytes: Int
    var distinctColors: Int
  }

  /// Renders after letting work the views queued on the main actor run (state they update on
  /// the next turn, like the composer's height).
  static func renderSettled<V: View>(_ view: V, name: String, size: CGSize, dark: Bool)
    async throws -> Rendered
  {
    let (host, window) = host(view, size: size, dark: dark)
    defer { window.close() }
    for _ in 0..<6 {
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      try await Task.sleep(for: .milliseconds(20))
    }
    return try capture(host, name: name, dark: dark)
  }

  private static func host<V: View>(_ view: V, size: CGSize, dark: Bool) -> (
    NSHostingView<some View>, NSWindow
  ) {
    let root =
      view
      .frame(width: size.width, height: size.height, alignment: .top)
      .background(Color(nsColor: .windowBackgroundColor))
      .environment(\.colorScheme, dark ? .dark : .light)
    let host = NSHostingView(rootView: root)
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    return (host, window)
  }

  private static func capture(_ host: NSView, name: String, dark: Bool) throws -> Rendered {
    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
      throw SnapshotError.noBitmap
    }
    host.cacheDisplay(in: host.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
      throw SnapshotError.noPNG
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
    try data.write(to: url, options: .atomic)
    return Rendered(url: url, bytes: data.count, distinctColors: distinctColors(in: bitmap))
  }

  /// Distinct colors on a sampling grid (a blank or single-color image has 1).
  static func distinctColors(in bitmap: NSBitmapImageRep) -> Int {
    var colors = Set<UInt32>()
    let step = max(1, min(bitmap.pixelsWide, bitmap.pixelsHigh) / 60)
    for y in stride(from: 0, to: bitmap.pixelsHigh, by: step) {
      for x in stride(from: 0, to: bitmap.pixelsWide, by: step) {
        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        let r = UInt32(color.redComponent * 255)
        let g = UInt32(color.greenComponent * 255)
        let b = UInt32(color.blueComponent * 255)
        colors.insert(r << 16 | g << 8 | b)
      }
    }
    return colors.count
  }

  enum SnapshotError: Error {
    case noBitmap, noPNG
  }
}

@MainActor
@Suite("Snapshots", .serialized)
struct SnapshotTests {
  static let now = FormattingTests.now

  /// A turn opened from the editor: the chat scrolls to its first message and highlights it, and
  /// the request is done (a chat opened later starts at the bottom again).
  @Test func orchestratorChatAtATurn() async throws {
    let store = SampleData.makeStore(now: Self.now)
    let thread = try #require(store.orchestratorThread)
    let turn = try #require(
      thread.messages.first { if case .status = $0 { true } else { false } })
    store.focusOrchestratorMessage(turn.id)
    let view = OrchestratorChatView(store: store, onOpenTask: { _ in })
      .agentReferenceDate(Self.now)
    _ = try await SnapshotRenderer.renderSettled(
      view, name: "orchestrator-window-turn", size: CGSize(width: 460, height: 420), dark: false)
    #expect(store.orchestratorFocus == nil, "the chat showed it")
  }

  /// A thread moving to another inbox section redraws its row (LazyVStack used to keep the old
  /// one: a Done thread still showed "Idle").
  @Test func inboxRowsFollowStatusChanges() throws {
    let store = AgentStore(client: FakeDaemonClient())
    let now = Self.now.epochMillis
    store.apply(
      .threadUpsert(
        Fixture.summary(
          "thr_a", title: "Research espresso", status: .idle, createdAt: now, updatedAt: now)))
    let size = CGSize(width: 360, height: 300)
    let host = NSHostingView(
      rootView: InboxView(store: store, onSelect: { _ in }).agentReferenceDate(Self.now).frame(
        width: size.width, height: size.height))
    let window = NSWindow(
      contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    defer { window.close() }
    func render() throws -> NSBitmapImageRep {
      for _ in 0..<6 {
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
      }
      let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: rep)
      return rep
    }
    /// Green pixels in the status-icon column (the Done checkmark; the Idle circle is gray), from
    /// the top through the first section (below the pinned orchestrator row, which has none).
    func greenIconPixels(_ rep: NSBitmapImageRep) -> Int {
      let scale = CGFloat(rep.pixelsWide) / size.width
      var count = 0
      for y in stride(from: 0, to: Int(220 * scale), by: 1) {
        for x in stride(from: 0, to: Int(40 * scale), by: 1) {
          guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
          if c.greenComponent - max(c.redComponent, c.blueComponent) > 0.15 { count += 1 }
        }
      }
      return count
    }
    #expect(greenIconPixels(try render()) == 0)
    store.apply(
      .threadUpsert(
        Fixture.summary(
          "thr_a", title: "Research espresso", status: .done, createdAt: now, updatedAt: now + 5,
          preview: "Summary ready")))
    #expect(greenIconPixels(try render()) > 20, "the row still shows the thread's old status")
  }
}
