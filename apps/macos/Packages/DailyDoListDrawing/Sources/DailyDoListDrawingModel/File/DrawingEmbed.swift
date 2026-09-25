import Foundation

/// A drawing embedded in a note with the plugin's syntax: `![[Name.excalidraw|360|right-wrap]]`.
/// Modifiers: a width (`360`) or a size (`360x240`), and where it sits (`left`, `right`,
/// `center`, `left-wrap`, `right-wrap`); no placement is full width. The embed's line is its
/// anchor in the note.
public struct DrawingEmbed: Hashable, Sendable {
  public enum Placement: String, Hashable, Sendable, CaseIterable {
    case left
    case right
    case center
    case leftWrap = "left-wrap"
    case rightWrap = "right-wrap"

    /// Whether text flows around the drawing.
    public var wraps: Bool { self == .leftWrap || self == .rightWrap }
  }

  /// The link target as written (`Name.excalidraw`, `Excalidraw/Name.excalidraw.md`).
  public var target: String
  public var width: Double?
  public var height: Double?
  public var placement: Placement?
  /// Other modifiers (an alias, a newer plugin's options), kept in order.
  public var otherModifiers: [String]

  public init(
    target: String, width: Double? = nil, height: Double? = nil, placement: Placement? = nil,
    otherModifiers: [String] = []
  ) {
    self.target = target
    self.width = width
    self.height = height
    self.placement = placement
    self.otherModifiers = otherModifiers
  }

  /// A new drawing's embed: 360 px wide, floating right with text wrapping around it.
  public static func newDrawing(target: String) -> DrawingEmbed {
    DrawingEmbed(target: target, width: 360, placement: .rightWrap)
  }

  /// Reads an embed from a line (it must be the whole line, surrounding spaces aside) whose
  /// target is a drawing (`.excalidraw` or `.excalidraw.md`).
  public static func parse(line: String) -> DrawingEmbed? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("![["), trimmed.hasSuffix("]]"), trimmed.count > 5 else { return nil }
    let inner = trimmed.dropFirst(3).dropLast(2)
    guard !inner.contains("[["), !inner.contains("]]") else { return nil }
    var parts = inner.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    let target = parts.removeFirst().trimmingCharacters(in: .whitespaces)
    let path = target.split(separator: "#", maxSplits: 1).first.map(String.init) ?? target
    guard path.hasSuffix(".excalidraw") || path.hasSuffix(".excalidraw.md") else { return nil }
    var embed = DrawingEmbed(target: target)
    for part in parts {
      let modifier = part.trimmingCharacters(in: .whitespaces)
      if let placement = Placement(rawValue: modifier), embed.placement == nil {
        embed.placement = placement
      } else if let (width, height) = size(modifier), embed.width == nil {
        embed.width = width
        embed.height = height
      } else {
        embed.otherModifiers.append(part)
      }
    }
    return embed
  }

  /// The embed as written in the note.
  public var markdown: String {
    var parts = [target]
    if let width {
      let widthText = JSNumberFormat.string(width)
      parts.append(height.map { "\(widthText)x\(JSNumberFormat.string($0))" } ?? widthText)
    }
    if let placement { parts.append(placement.rawValue) }
    parts += otherModifiers
    return "![[\(parts.joined(separator: "|"))]]"
  }

  /// The target's file name without `.excalidraw` / `.excalidraw.md` (the drawing's name).
  public var name: String {
    var path = target.split(separator: "#", maxSplits: 1).first.map(String.init) ?? target
    path = path.split(separator: "/").last.map(String.init) ?? path
    for suffix in [".excalidraw.md", ".excalidraw"] where path.hasSuffix(suffix) {
      return String(path.dropLast(suffix.count))
    }
    return path
  }

  private static func size(_ modifier: String) -> (Double, Double?)? {
    let pieces = modifier.split(separator: "x", omittingEmptySubsequences: false)
    guard (1...2).contains(pieces.count),
      pieces.allSatisfy({
        !$0.isEmpty && $0.allSatisfy { $0.isASCII && ($0.isNumber || $0 == ".") }
      }),
      let width = Double(pieces[0]), width > 0
    else { return nil }
    if pieces.count == 2 {
      guard let height = Double(pieces[1]), height > 0 else { return nil }
      return (width, height)
    }
    return (width, nil)
  }
}

/// New drawing file names, the way the plugin names them: `Drawing 2026-09-25 11.52.33`, in the
/// plugin's default folder `Excalidraw/`.
public enum DrawingFileName {
  public static let folder = "Excalidraw"
  public static let fileExtension = ".excalidraw.md"

  /// The name for a drawing made at `date`, in local time.
  public static func name(at date: Date, timeZone: TimeZone = .current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents(
      [.year, .month, .day, .hour, .minute, .second], from: date)
    func two(_ value: Int?) -> String { String(format: "%02d", value ?? 0) }
    return "Drawing \(parts.year ?? 0)-\(two(parts.month))-\(two(parts.day)) "
      + "\(two(parts.hour)).\(two(parts.minute)).\(two(parts.second))"
  }

  /// The vault path of that drawing: `Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md`.
  public static func path(at date: Date, timeZone: TimeZone = .current) -> String {
    "\(folder)/\(name(at: date, timeZone: timeZone))\(fileExtension)"
  }
}
