import AppKit
import SwiftUI
import Testing

@testable import DailyDoListUI

/// Offscreen renders written to the package's `.build/ui-snapshots/` for review (not committed):
/// tooltips, keycaps and the controls' states, light and dark.
@MainActor
@Suite("Snapshots", .serialized)
struct SnapshotTests {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent(".build/ui-snapshots", isDirectory: true)

  /// Light and dark backgrounds of the app (the note's).
  static func background(dark: Bool) -> Color {
    Color(nsColor: NSColor(rgb: dark ? 0x0E1116 : 0xFFFFFF))
  }

  @discardableResult
  static func render<V: View>(_ view: V, name: String, size: CGSize, dark: Bool) throws -> URL {
    let root = view.frame(width: size.width, height: size.height)
      .background(background(dark: dark))
      .environment(\.colorScheme, dark ? .dark : .light)
    let host = NSHostingView(rootView: root)
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    defer { window.close() }
    for _ in 0..<4 {
      host.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    let data = try #require(rep.representation(using: .png, properties: [:]))
    #expect(data.count > 2_000, "\(name) drew something")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
    try data.write(to: url, options: .atomic)
    return url
  }

  static let samples: [TooltipContent] = [
    TooltipContent("New note", keys: KeyShortcut("n", .command)),
    TooltipContent("Open today's note", keys: KeyShortcut("d", [.shift, .command])),
    TooltipContent(
      "Show agent panel", keys: KeyShortcut("\\", .command), detail: "2 waiting for approval"),
    TooltipContent(lines: [
      .init("Send", keys: .returnKey), .init("New line", keys: .shiftReturn),
    ]),
    TooltipContent("Written by the agent — open thread"),
    .path("Projects/Research/2026/Standing desks under $500 — comparison.md"),
    TooltipContent(
      "Example Rise Pro", detail: "desks.example\nhttps://desks.example/rise-pro/reviews?sort=new"),
  ]

  @Test(arguments: [false, true])
  func tooltips(dark: Bool) throws {
    let view = VStack(alignment: .leading, spacing: 18) {
      ForEach(Array(Self.samples.enumerated()), id: \.offset) { _, content in
        TooltipBubble(content: content).fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 280, alignment: .leading)
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    try Self.render(view, name: "tooltips", size: CGSize(width: 360, height: 480), dark: dark)
  }

  @Test(arguments: [false, true])
  func keycaps(dark: Bool) throws {
    let shortcuts: [KeyShortcut] = [
      KeyShortcut("n", .command), KeyShortcut("d", [.shift, .command]),
      KeyShortcut("s", [.control, .command]), KeyShortcut("\t", [.control, .shift]),
      .returnKey, .escapeKey, KeyShortcut(.space, [.control, .option, .command]),
    ]
    let view = VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(shortcuts.enumerated()), id: \.offset) { _, shortcut in
        HStack(spacing: 8) {
          Text(verbatim: shortcut.spokenDescription).font(.system(size: 12))
            .foregroundStyle(UIPalette.text)
          Spacer()
          Keycaps(shortcut)
        }
      }
      HStack(spacing: 8) {
        Keycaps([.upArrow, .downArrow])
        Text("navigate").font(.system(size: 11)).foregroundStyle(UIPalette.faintText)
      }
    }
    .padding(20)
    try Self.render(view, name: "keycaps", size: CGSize(width: 320, height: 250), dark: dark)
  }

  /// Rest, hover, pressed, active and disabled, as the styles draw them.
  @Test(arguments: [false, true])
  func controlStates(dark: Bool) throws {
    let states: [(String, ControlState)] = [
      ("rest", ControlState()), ("hover", ControlState(isHovered: true)),
      ("pressed", ControlState(isHovered: true, isPressed: true)),
      ("active", ControlState(isActive: true)), ("disabled", ControlState(isEnabled: false)),
    ]
    let view = VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 18) {
        ForEach(states, id: \.0) { name, state in
          VStack(spacing: 6) {
            IconButtonFace(size: .regular, state: state) {
              Image(systemName: "sidebar.left").font(.system(size: 13))
            }
            IconButtonFace(size: .compact, state: state) {
              Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
            }
            Text(name).font(.system(size: 10)).foregroundStyle(UIPalette.faintText)
          }
        }
      }
      HStack(spacing: 10) {
        ForEach(states, id: \.0) { name, state in
          Text("Today")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(state.isHovered ? UIPalette.text : UIPalette.mutedText)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(state.fill))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(UIPalette.separator))
            .opacity(state.isEnabled ? 1 : ControlState.disabledOpacity)
        }
      }
    }
    .padding(20)
    try Self.render(view, name: "control-states", size: CGSize(width: 380, height: 150), dark: dark)
  }

  /// The real presenter's bubble view, the way the panel shows it.
  @Test(arguments: [false, true])
  func panelContent(dark: Bool) throws {
    let presenter = TooltipPanelPresenter(clock: ManualTooltipClock())
    let window = TooltipPanelTests.makeWindow()
    defer { window.close() }
    let anchor = window.convertToScreen(NSRect(x: 200, y: 400, width: 28, height: 28))
    presenter.show(
      TooltipPresentation(
        content: TooltipContent("Toggle agent panel", keys: KeyShortcut("\\", .command)),
        anchor: anchor, window: window, placement: .automatic),
      animation: .immediate)
    let bubble = presenter.bubbleView
    let rep = try #require(bubble.bitmapImageRepForCachingDisplay(in: bubble.bounds))
    bubble.cacheDisplay(in: bubble.bounds, to: rep)
    let data = try #require(rep.representation(using: .png, properties: [:]))
    try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
    try data.write(
      to: Self.directory.appendingPathComponent("panel-\(dark ? "dark" : "light").png"))
    #expect(data.count > 1_000)
    #expect(bubble.bounds.width > 100 && bubble.bounds.width < 300)
  }
}
