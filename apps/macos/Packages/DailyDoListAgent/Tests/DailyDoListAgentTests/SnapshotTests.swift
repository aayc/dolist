import AppKit
import DailyDoListClient
import DailyDoListModels
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// Renders views offscreen (an `NSHostingView` in a borderless window, so AppKit-backed controls
/// draw too) and writes PNGs to `.build/agent-snapshots/` for review. Assertions only check that
/// something non-trivial was drawn; the images are for eyes.
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

  static func render<V: View>(_ view: V, name: String, size: CGSize, dark: Bool) throws -> Rendered {
    let root = view
      .frame(width: size.width, height: size.height, alignment: .top)
      .background(Color(nsColor: .windowBackgroundColor))
      .environment(\.colorScheme, dark ? .dark : .light)
    let host = NSHostingView(rootView: root)
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    defer { window.close() }
    for _ in 0..<3 {
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
    }
    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
      throw SnapshotError.noBitmap
    }
    host.cacheDisplay(in: host.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { throw SnapshotError.noPNG }
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
        let r = UInt32(color.redComponent * 255), g = UInt32(color.greenComponent * 255)
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
  let store = SampleData.makeStore(now: SnapshotTests.now)

  private func check(_ rendered: SnapshotRenderer.Rendered, minimumColors: Int = 12) {
    #expect(FileManager.default.fileExists(atPath: rendered.url.path))
    #expect(rendered.bytes > 4_000, "\(rendered.url.lastPathComponent) is not empty")
    #expect(rendered.distinctColors >= minimumColors, "\(rendered.url.lastPathComponent) has content")
  }

  @Test(arguments: [false, true])
  func agentPanelInbox(dark: Bool) throws {
    let view = AgentPanel(store: store, selectedThreadId: .constant(nil)).agentReferenceDate(Self.now)
    check(try SnapshotRenderer.render(view, name: "agent-panel-inbox", size: CGSize(width: 400, height: 820), dark: dark))
  }

  @Test(arguments: [false, true])
  func threadWithEveryMessageKind(dark: Bool) throws {
    // Plus a message kind from a newer daemon.
    let raw: JSONValue = ["kind": "poll", "id": "msg_future", "author": "orchestrator", "createdAt": .number(Self.now.epochMillis)]
    store.apply(
      .threadMessage(
        ThreadMessageEvent(threadId: SampleData.bookingThreadId, message: .unknown(kind: "poll", id: "msg_future", raw: raw))))
    let view = AgentPanel(
      store: store, selectedThreadId: .constant(SampleData.bookingThreadId), onShowInNote: { _ in }
    ).agentReferenceDate(Self.now)
    check(try SnapshotRenderer.render(view, name: "thread-booking", size: CGSize(width: 440, height: 2_300), dark: dark))
  }

  /// A thread moving to another inbox section redraws its row (LazyVStack used to keep the old
  /// one: a Done thread still showed "Idle").
  @Test func inboxRowsFollowStatusChanges() throws {
    let store = AgentStore(client: SampleDaemonClient())
    let now = Self.now.epochMillis
    store.apply(.threadUpsert(Fixture.summary("thr_a", title: "Research espresso", status: .idle, createdAt: now, updatedAt: now)))
    let size = CGSize(width: 360, height: 300)
    let host = NSHostingView(
      rootView: InboxView(store: store, onSelect: { _ in }).agentReferenceDate(Self.now).frame(width: size.width, height: size.height))
    let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
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
    /// Green pixels in the status-icon column (the Done checkmark; the Idle circle is gray).
    func greenIconPixels(_ rep: NSBitmapImageRep) -> Int {
      let scale = CGFloat(rep.pixelsWide) / size.width
      var count = 0
      for y in stride(from: 0, to: Int(120 * scale), by: 1) {
        for x in stride(from: 0, to: Int(40 * scale), by: 1) {
          guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
          if c.greenComponent - max(c.redComponent, c.blueComponent) > 0.15 { count += 1 }
        }
      }
      return count
    }
    #expect(greenIconPixels(try render()) == 0)
    store.apply(.threadUpsert(Fixture.summary("thr_a", title: "Research espresso", status: .done, createdAt: now, updatedAt: now + 5, preview: "Summary ready")))
    #expect(greenIconPixels(try render()) > 20, "the row still shows the thread's old status")
  }

  @Test(arguments: [false, true])
  func approvalCardStates(dark: Bool) throws {
    let base = try #require(store.approvals[SampleData.reserveApprovalId])
    func variant(_ status: ApprovalStatus, scope: ApprovalScope? = nil, note: String? = nil) -> ApprovalRequest {
      var approval = base
      approval.status = status
      approval.scope = scope
      approval.decisionNote = note
      approval.decidedAt = Self.now.epochMillis - 60_000
      return approval
    }
    let view = ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        ApprovalCard(approval: base) { _, _, _ in }
        ApprovalCard(approval: base, isDeciding: true) { _, _, _ in }
        ApprovalCard(approval: variant(.approved, scope: .once)) { _, _, _ in }
        ApprovalCard(approval: variant(.approved, scope: .task)) { _, _, _ in }
        ApprovalCard(approval: variant(.denied, note: "No deposits — pick a place that doesn't need one.")) { _, _, _ in }
        ApprovalCard(approval: variant(.expired)) { _, _, _ in }
      }
      .padding(16)
    }
    .tint(AgentTheme.accent)
    .agentReferenceDate(Self.now)
    check(try SnapshotRenderer.render(view, name: "approval-cards", size: CGSize(width: 440, height: 1_900), dark: dark))
  }

  @Test(arguments: [false, true])
  func toolCallsAndMessages(dark: Bool) throws {
    let booking = try #require(store.thread(SampleData.bookingThreadId))
    let calls = booking.messages.compactMap { message -> ToolCallMessage? in
      if case .toolCall(let call) = message { return call }
      return nil
    }
    let view = VStack(alignment: .leading, spacing: 10) {
      ForEach(calls, id: \.id) { call in ToolCallRow(call: call, expanded: call.status == .blocked) }
    }
    .padding(16)
    check(try SnapshotRenderer.render(view, name: "tool-calls", size: CGSize(width: 440, height: 520), dark: dark))
  }

  @Test(arguments: [("art_sample_desks", SampleData.desksThreadId), ("art_sample_script", SampleData.desksThreadId), ("art_sample_options", SampleData.bookingThreadId)])
  func artifactViewer(artifactId: String, threadId: String) throws {
    let snapshot = SampleData.snapshot(now: Self.now)
    let meta = try #require(store.artifactMeta(threadId: threadId, artifactId: artifactId))
    let payload = try #require(snapshot.artifacts[artifactId])
    for dark in [false, true] {
      let view = ArtifactViewerContent(meta: meta, phase: .ready(payload))
      check(try SnapshotRenderer.render(view, name: "artifact-\(meta.kind.rawValue)", size: CGSize(width: 720, height: 560), dark: dark))
    }
  }

  @Test(arguments: [false, true])
  func artifactViewerStates(dark: Bool) throws {
    let meta = store.artifactMeta(threadId: SampleData.bookingThreadId, artifactId: "art_sample_summary")
    let view = VStack(spacing: 0) {
      ArtifactViewerContent(meta: meta, phase: .loading).frame(height: 280)
      Divider()
      ArtifactViewerContent(meta: meta, phase: .failed("Can't reach the Daily Do List daemon (connection refused).")).frame(height: 420)
    }
    check(try SnapshotRenderer.render(view, name: "artifact-states", size: CGSize(width: 720, height: 700), dark: dark), minimumColors: 6)
  }

  @Test(arguments: [false, true])
  func browserSurface(dark: Bool) throws {
    let view = BrowserSurfaceView(store: store, threadId: SampleData.bookingThreadId)
      .agentReferenceDate(Self.now)
    check(try SnapshotRenderer.render(view, name: "surface-browser", size: CGSize(width: 440, height: 380), dark: dark))
  }

  @Test(arguments: [false, true])
  func computerSurface(dark: Bool) throws {
    let view = ComputerSurfaceView(store: store, threadId: SampleData.coffeeThreadId)
      .agentReferenceDate(Self.now.addingTimeInterval(120))
    check(try SnapshotRenderer.render(view, name: "surface-computer", size: CGSize(width: 440, height: 480), dark: dark))
  }

  @Test(arguments: [false, true])
  func menuBarContent(dark: Bool) throws {
    let view = AgentMenuBarContent(store: store, openTodaysNote: {}, openMainWindow: {}, openThread: { _ in })
    check(try SnapshotRenderer.render(view, name: "menu-bar", size: CGSize(width: 320, height: 540), dark: dark))
  }

  @Test(arguments: [false, true])
  func emptyInboxAndPausedComposer(dark: Bool) throws {
    let empty = AgentStore(client: SampleDaemonClient())
    empty.apply(.agentStatus(Fixture.status(enabled: false, running: 0)))
    empty.apply(.threadUpsert(Fixture.summary(status: .done, createdAt: Self.now.epochMillis, updatedAt: Self.now.epochMillis)))
    let view = HStack(spacing: 0) {
      AgentPanel(store: AgentStore(client: SampleDaemonClient()), selectedThreadId: .constant(nil))
        .frame(width: 360)
      Divider()
      Composer(store: empty, threadId: "thr_1").frame(width: 360).frame(maxHeight: .infinity, alignment: .bottom)
    }
    .agentReferenceDate(Self.now)
    check(try SnapshotRenderer.render(view, name: "empty-inbox-and-paused-composer", size: CGSize(width: 721, height: 420), dark: dark), minimumColors: 4)
  }
}
