import AppKit
import SwiftUI

extension View {
  /// A tooltip once the pointer rests on the view: `text`, then `keys` as keycaps. Pass the id of
  /// the command the control runs as `command` (tests check its keys against the catalog).
  /// Disabled views show none, unless `whenDisabled` explains why.
  public func tooltip(
    _ text: String, keys: KeyShortcut? = nil, detail: String? = nil,
    placement: TooltipPlacement = .automatic, whenDisabled: String? = nil,
    command: String? = nil, accessibility: TooltipAccessibility = .hint
  ) -> some View {
    tooltip(
      TooltipContent(text, keys: keys, detail: detail), placement: placement,
      whenDisabled: whenDisabled.map { TooltipContent($0) }, command: command,
      accessibility: accessibility)
  }

  /// A tooltip with any content; nil shows none.
  public func tooltip(
    _ content: TooltipContent?, placement: TooltipPlacement = .automatic,
    whenDisabled: TooltipContent? = nil, command: String? = nil,
    accessibility: TooltipAccessibility = .hint
  ) -> some View {
    modifier(
      TooltipModifier(
        source: .content(content), placement: placement, whenDisabled: whenDisabled,
        command: command, accessibility: accessibility))
  }

  /// The full text (or `showing`) as a tooltip, only while `text` doesn't fit: apply it to the
  /// `Text` itself (before any padding), with the font it's drawn in and its line limit.
  public func tooltip(
    ifTruncated text: String, font: NSFont, lineLimit: Int = 1, showing: TooltipContent? = nil,
    placement: TooltipPlacement = .automatic
  ) -> some View {
    modifier(
      TooltipModifier(
        source: .truncated(
          TruncatedText(
            text: text, font: font, lineLimit: lineLimit,
            shown: showing ?? TooltipContent(TooltipContent.wrappable(text)))),
        placement: placement, whenDisabled: nil, command: nil, accessibility: .none))
  }
}

/// What VoiceOver hears of a tooltip (`.help` used to provide it).
public enum TooltipAccessibility: Hashable, Sendable {
  /// The text and the spoken shortcut, as the accessibility hint.
  case hint
  /// Only the spoken shortcut (the text is already the control's label).
  case keysOnly
  case none
}

extension EnvironmentValues {
  /// The center tooltips report to; nil means ``TooltipCenter/shared`` (tests set their own).
  public var tooltipCenter: TooltipCenter? {
    get { self[TooltipCenterKey.self] }
    set { self[TooltipCenterKey.self] = newValue }
  }
}

private struct TooltipCenterKey: EnvironmentKey {
  static let defaultValue: TooltipCenter? = nil
}

/// A truncated-text tooltip, decided when the tooltip would show (not on every layout).
struct TruncatedText: Equatable {
  var text: String
  var font: NSFont
  var lineLimit: Int
  var shown: TooltipContent

  /// Whether `text` in `font` needs more room than `size` (1 pt of slack for rounding).
  static func isTruncated(_ text: String, font: NSFont, in size: CGSize, lineLimit: Int) -> Bool {
    let attributes: [NSAttributedString.Key: Any] = [.font: font]
    guard lineLimit != 1 else {
      return (text as NSString).size(withAttributes: attributes).width > size.width + 1
    }
    let needed = (text as NSString).boundingRect(
      with: CGSize(width: max(size.width, 1), height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes)
    return ceil(needed.height) > size.height + 1
  }
}

enum TooltipSource: Equatable {
  case content(TooltipContent?)
  case truncated(TruncatedText)

  func content(in size: CGSize) -> TooltipContent? {
    switch self {
    case .content(let content):
      content
    case .truncated(let truncated):
      TruncatedText.isTruncated(
        truncated.text, font: truncated.font, in: size, lineLimit: truncated.lineLimit)
        ? truncated.shown : nil
    }
  }

  /// The text VoiceOver gets as a hint.
  func hint(_ accessibility: TooltipAccessibility) -> String? {
    guard case .content(let content?) = self else { return nil }
    let keys = content.lines.compactMap(\.keys?.spokenDescription)
    switch accessibility {
    case .hint: return ([content.plainText] + keys).joined(separator: ", ")
    case .keysOnly: return keys.isEmpty ? nil : keys.joined(separator: ", ")
    case .none: return nil
    }
  }
}

private struct TooltipModifier: ViewModifier {
  let source: TooltipSource
  let placement: TooltipPlacement
  let whenDisabled: TooltipContent?
  let command: String?
  let accessibility: TooltipAccessibility
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.tooltipCenter) private var center

  func body(content: Content) -> some View {
    let active = isEnabled ? source : .content(whenDisabled)
    content
      .background(
        TooltipAnchor(
          source: active, placement: placement, command: command, center: center ?? .shared)
      )
      .modifier(TooltipHint(hint: source.hint(accessibility)))
  }
}

private struct TooltipHint: ViewModifier {
  let hint: String?

  func body(content: Content) -> some View {
    if let hint { content.accessibilityHint(Text(verbatim: hint)) } else { content }
  }
}

private struct TooltipAnchor: NSViewRepresentable {
  let source: TooltipSource
  let placement: TooltipPlacement
  let command: String?
  let center: TooltipCenter

  func makeNSView(context: Context) -> TooltipAnchorView {
    let view = TooltipAnchorView()
    update(view)
    return view
  }

  func updateNSView(_ view: TooltipAnchorView, context: Context) { update(view) }

  static func dismantleNSView(_ view: TooltipAnchorView, coordinator: ()) {
    view.detach()
  }

  private func update(_ view: TooltipAnchorView) {
    view.center = center
    view.placement = placement
    view.command = command
    view.setSource(source)
  }
}

/// The view behind a control with a tooltip: it tracks the pointer (and lets every click through)
/// and tells the center where the control is.
public final class TooltipAnchorView: NSView, TooltipTarget {
  var center: TooltipCenter = .shared
  var placement: TooltipPlacement = .automatic
  /// The command the control runs, if any.
  public internal(set) var command: String?
  private(set) var source: TooltipSource = .content(nil)
  private var trackingArea: NSTrackingArea?
  private(set) var isPointerInside = false

  func setSource(_ source: TooltipSource) {
    guard source != self.source else { return }
    self.source = source
    guard isPointerInside else { return }
    if center.shownTarget === self {
      center.targetChanged(self)
    } else {
      center.pointerEntered(self)
    }
  }

  /// The pointer left for good: the view left its window or SwiftUI removed it.
  func detach() {
    isPointerInside = false
    center.targetRemoved(self)
  }

  override public func hitTest(_ point: NSPoint) -> NSView? { nil }

  override public func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea, trackingAreas.contains(trackingArea) { return }
    let area = NSTrackingArea(
      rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    trackingArea = area
  }

  override public func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    center.pointerEntered(self)
  }

  override public func mouseExited(with event: NSEvent) {
    isPointerInside = false
    center.pointerExited(self)
  }

  override public func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    if newWindow == nil { detach() }
  }

  override public func viewDidHide() {
    super.viewDidHide()
    detach()
  }

  // MARK: TooltipTarget

  public var tooltipScreenRect: NSRect? {
    guard let window, !isHiddenOrHasHiddenAncestor, bounds.width > 0, bounds.height > 0 else {
      return nil
    }
    return window.convertToScreen(convert(bounds, to: nil))
  }

  public var tooltipWindow: NSWindow? { window }

  public var tooltipPlacement: TooltipPlacement { placement }

  public func tooltipContent() -> TooltipContent? { source.content(in: bounds.size) }
}
