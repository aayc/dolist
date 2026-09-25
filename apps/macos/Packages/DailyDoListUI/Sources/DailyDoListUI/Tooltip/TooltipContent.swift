import Foundation

/// What a tooltip says: one or more lines, each optionally with its keycaps, and muted detail text
/// under them (a link's hostname and URL, why something is unavailable).
public struct TooltipContent: Hashable, Sendable {
  public struct Line: Hashable, Sendable {
    public var text: String
    public var keys: KeyShortcut?

    public init(_ text: String, keys: KeyShortcut? = nil) {
      self.text = text
      self.keys = keys
    }
  }

  public var lines: [Line]
  public var detail: String?

  public init(lines: [Line], detail: String? = nil) {
    self.lines = lines
    self.detail = detail?.isEmpty == true ? nil : detail
  }

  /// A label with its shortcut: "New note [⌘][N]".
  public init(_ text: String, keys: KeyShortcut? = nil, detail: String? = nil) {
    self.init(lines: [Line(text, keys: keys)], detail: detail)
  }

  /// Multi-line text from a host (an editor link preview): the first line is the label, the rest
  /// is detail.
  public init?(multilineText text: String) {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard let first = lines.first?.trimmingCharacters(in: .whitespaces), !first.isEmpty else {
      return nil
    }
    let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .newlines)
    self.init(first, detail: rest.isEmpty ? nil : Self.wrappable(rest))
  }

  /// A path or URL that may wrap after its slashes (a zero-width space follows each one).
  public static func path(_ path: String) -> TooltipContent {
    TooltipContent(wrappable(path))
  }

  /// `text` with a break opportunity after each `/`, so long paths and URLs wrap there.
  public static func wrappable(_ text: String) -> String {
    text.replacingOccurrences(of: "/", with: "/\u{200B}")
  }

  /// A one-sentence message as a tooltip: without its final period ("The daemon is offline.").
  public static func sentence(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasSuffix("."), !trimmed.hasSuffix(".."),
      !trimmed.dropLast().contains(". ")
    else { return trimmed }
    return String(trimmed.dropLast())
  }

  /// Every string the tooltip shows, for tests and accessibility.
  public var plainText: String {
    (lines.map(\.text) + [detail].compactMap { $0 }).joined(separator: "\n")
      .replacingOccurrences(of: "\u{200B}", with: "")
  }
}

/// Where a tooltip goes relative to its target.
public enum TooltipPlacement: Hashable, Sendable {
  /// Below a control in a window's top header row, above anything else.
  case automatic
  case above
  case below
}

/// The shared timings and metrics (the web app's tooltip layer uses the same numbers).
public enum TooltipMetrics {
  /// Hover (on the same target) before a tooltip opens.
  public static let openDelay: TimeInterval = 0.5
  /// After a tooltip starts hiding, another target shows its tooltip at once (and it glides).
  public static let warmWindow: TimeInterval = 0.3
  public static let enterDuration: TimeInterval = 0.14
  public static let glideDuration: TimeInterval = 0.12
  public static let exitDuration: TimeInterval = 0.09
  /// With Reduce Motion: opacity only, this long at most.
  public static let reducedDuration: TimeInterval = 0.08
  /// The enter animation starts this much closer to the target.
  public static let slide: CGFloat = 3
  public static let enterScale: CGFloat = 0.97
  /// Between the target and the tooltip.
  public static let gap: CGFloat = 6
  /// From the edges of the screen (or window).
  public static let margin: CGFloat = 8
  public static let maxWidth: CGFloat = 280
  /// A target whose top is this close to its window's top is in the header row.
  public static let headerBand: CGFloat = 56
}
