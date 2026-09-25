import AppKit

/// Something the pointer can rest on to see a tooltip: a SwiftUI control (the `.tooltip` modifier's
/// anchor view) or a region a view tracks itself (an editor badge, the agent sparkle).
@MainActor
public protocol TooltipTarget: AnyObject {
  /// The target's frame in screen coordinates; nil while it isn't on screen.
  var tooltipScreenRect: NSRect? { get }
  /// The window the target is in (the tooltip panel becomes its child).
  var tooltipWindow: NSWindow? { get }
  var tooltipPlacement: TooltipPlacement { get }
  /// Asked when the tooltip shows (and when the target changes while shown); nil shows nothing.
  func tooltipContent() -> TooltipContent?
  /// Whether it has anything to say, asked when the pointer arrives (default: builds the content).
  func tooltipHasContent() -> Bool
}

extension TooltipTarget {
  public func tooltipHasContent() -> Bool { tooltipContent() != nil }
}

/// A region of a view that shows a tooltip: the view tracks the pointer and reports it to the
/// center (`MarkdownEditorController` does, for badges, sparkles and links). The content is built
/// only when the tooltip shows (a link preview asks the host for it).
@MainActor
public final class TooltipRegion: TooltipTarget {
  public private(set) weak var view: NSView?
  /// In the view's coordinates.
  public var rect: NSRect
  public var tooltipPlacement: TooltipPlacement
  private let content: @MainActor () -> TooltipContent?

  public init(
    view: NSView, rect: NSRect, placement: TooltipPlacement = .automatic,
    content: @escaping @MainActor () -> TooltipContent?
  ) {
    self.view = view
    self.rect = rect
    self.tooltipPlacement = placement
    self.content = content
  }

  public var tooltipScreenRect: NSRect? {
    guard let view, let window = view.window else { return nil }
    return window.convertToScreen(view.convert(rect, to: nil))
  }

  public var tooltipWindow: NSWindow? { view?.window }

  public func tooltipContent() -> TooltipContent? { content() }

  /// A region exists because the thing under the pointer has a tooltip.
  public func tooltipHasContent() -> Bool { true }
}

/// How a tooltip appears or goes away.
public struct TooltipAnimation: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    /// Fade in while scaling from 0.97 and sliding 3 pt away from the target.
    case enter
    /// Move from where the last tooltip was (warm mode).
    case glide
    /// Fade out.
    case exit
    /// No animation (hide at once, or a content update in place).
    case none
  }

  public var kind: Kind
  public var duration: TimeInterval
  /// Reduce Motion: opacity only.
  public var reduced: Bool

  public init(kind: Kind, duration: TimeInterval, reduced: Bool) {
    self.kind = kind
    self.duration = duration
    self.reduced = reduced
  }

  public static let immediate = TooltipAnimation(kind: .none, duration: 0, reduced: false)

  static func enter(reduced: Bool) -> TooltipAnimation {
    TooltipAnimation(
      kind: .enter,
      duration: reduced ? TooltipMetrics.reducedDuration : TooltipMetrics.enterDuration,
      reduced: reduced)
  }

  static func glide(reduced: Bool) -> TooltipAnimation {
    TooltipAnimation(
      kind: .glide,
      duration: reduced ? TooltipMetrics.reducedDuration : TooltipMetrics.glideDuration,
      reduced: reduced)
  }

  static func exit(reduced: Bool) -> TooltipAnimation {
    TooltipAnimation(
      kind: .exit,
      duration: reduced ? TooltipMetrics.reducedDuration : TooltipMetrics.exitDuration,
      reduced: reduced)
  }
}

/// One tooltip to show: what, where it points, and the window it belongs to.
@MainActor
public struct TooltipPresentation {
  public var content: TooltipContent
  /// The target's frame, screen coordinates.
  public var anchor: NSRect
  public var window: NSWindow?
  public var placement: TooltipPlacement

  public init(
    content: TooltipContent, anchor: NSRect, window: NSWindow?, placement: TooltipPlacement
  ) {
    self.content = content
    self.anchor = anchor
    self.window = window
    self.placement = placement
  }
}

/// Draws the tooltip (``TooltipPanelPresenter`` in the app; a recorder in tests).
@MainActor
public protocol TooltipPresenting: AnyObject {
  func show(_ presentation: TooltipPresentation, animation: TooltipAnimation)
  func hide(animation: TooltipAnimation)
}
