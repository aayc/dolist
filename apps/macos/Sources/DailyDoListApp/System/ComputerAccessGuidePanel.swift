import AppKit
import QuartzCore
import SwiftUI

/// Where the guide panel goes: the right edge of the screen, a little above the middle, clear of
/// System Settings, which opens near the center.
enum ComputerAccessGuideLayout {
  static let cardWidth: CGFloat = 320
  static let cornerRadius: CGFloat = 14
  /// Transparent room around the card for its shadow.
  static let margin: CGFloat = 24
  /// From the card to the screen's right edge (the margin fits inside it).
  static let screenInset: CGFloat = 24
  /// The card is top-aligned in a panel tall enough for its tallest state. The rest of the panel
  /// is transparent, and clicks there go to the window underneath.
  static let panelSize = CGSize(width: cardWidth + 2 * margin, height: 440)

  static func frame(in visibleFrame: NSRect) -> NSRect {
    let size = panelSize
    let x = visibleFrame.maxX - screenInset - cardWidth - margin
    let centered = visibleFrame.midY - size.height / 2 + 40
    let y = max(
      visibleFrame.minY - margin, min(centered, visibleFrame.maxY - size.height + margin))
    return NSRect(origin: CGPoint(x: x, y: y), size: size)
  }
}

/// Shows the guide in a floating panel that never activates Daily Do List, so System Settings
/// keeps the focus while the user flips the switch. It stays up while the app is in the
/// background, fades and slides in, and fades out.
@MainActor
final class ComputerAccessGuidePanelPresenter: ComputerAccessGuidePresenting {
  private var panel: NSPanel?
  /// Bumped by every show and hide, so a finished fade can't order out a newer panel.
  private var generation = 0

  func show(_ access: ComputerAccess) {
    generation += 1
    let panel = self.panel ?? Self.makePanel()
    self.panel = panel
    panel.contentView = GuideHostingView(rootView: ComputerAccessGuideView(access: access))
    let screen = NSScreen.main ?? NSScreen.screens.first
    let frame = ComputerAccessGuideLayout.frame(in: screen?.visibleFrame ?? .zero)
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    panel.setFrame(reduceMotion ? frame : frame.offsetBy(dx: 18, dy: 0), display: false)
    panel.alphaValue = 0
    panel.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.28
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().alphaValue = 1
      if !reduceMotion { panel.animator().setFrame(frame, display: true) }
    }
  }

  func hide() {
    guard let panel, panel.isVisible else { return }
    generation += 1
    let generation = self.generation
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.2
      context.timingFunction = CAMediaTimingFunction(name: .easeIn)
      panel.animator().alphaValue = 0
    } completionHandler: { [weak self] in
      Task { @MainActor in
        guard let self, self.generation == generation else { return }
        self.panel?.orderOut(nil)
        self.panel?.contentView = nil
      }
    }
  }

  private static func makePanel() -> NSPanel {
    let panel = GuidePanel(
      contentRect: NSRect(origin: .zero, size: ComputerAccessGuideLayout.panelSize),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.title = "Set Up Computer Use"
    panel.isFloatingPanel = true
    panel.level = .floating
    // Panels hide when their app deactivates by default, and Daily Do List is in the background
    // the whole time System Settings is in front.
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.isExcludedFromWindowsMenu = true
    return panel
  }
}

private final class GuidePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

/// Clicks work on the first try although the panel isn't key.
private final class GuideHostingView: NSHostingView<ComputerAccessGuideView> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A transparent drag source over the app's icon that drags its bundle: dropping it into a list in
/// System Settings → Privacy & Security adds Daily Do List to it.
struct AppIconDragSource: NSViewRepresentable {
  let icon: NSImage
  let bundleURL: URL

  func makeNSView(context: Context) -> AppIconDragView {
    AppIconDragView(icon: icon, bundleURL: bundleURL)
  }

  func updateNSView(_ view: AppIconDragView, context: Context) {
    view.icon = icon
    view.bundleURL = bundleURL
  }
}

final class AppIconDragView: NSView, NSDraggingSource {
  /// The image that follows the pointer.
  var icon: NSImage
  var bundleURL: URL
  private var mouseDown: NSEvent?

  init(icon: NSImage, bundleURL: URL) {
    self.icon = icon
    self.bundleURL = bundleURL
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.image)
    setAccessibilityLabel("Daily Do List app icon")
    setAccessibilityHelp("Drag it into the list in System Settings.")
  }

  required init?(coder: NSCoder) { nil }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }

  override func mouseDown(with event: NSEvent) {
    mouseDown = event
  }

  override func mouseDragged(with event: NSEvent) {
    guard let mouseDown else { return }
    self.mouseDown = nil
    beginDraggingSession(with: [draggingItem()], event: mouseDown, source: self)
  }

  override func mouseUp(with event: NSEvent) {
    mouseDown = nil
  }

  /// The app bundle's file URL (what dragging the app from Finder provides), shown as its icon.
  func draggingItem() -> NSDraggingItem {
    let item = NSDraggingItem(pasteboardWriter: bundleURL as NSURL)
    item.setDraggingFrame(bounds, contents: icon)
    return item
  }

  func draggingSession(
    _ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext
  ) -> NSDragOperation {
    Self.operations(for: context)
  }

  /// Never a move: dropped on a Finder window, the app must stay where it is.
  static func operations(for context: NSDraggingContext) -> NSDragOperation {
    context == .outsideApplication ? [.copy, .link, .generic] : []
  }
}
