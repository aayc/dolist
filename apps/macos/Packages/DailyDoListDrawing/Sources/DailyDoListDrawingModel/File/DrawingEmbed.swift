import Foundation

/// A drawing embedded in a note with the plugin's syntax (`embed.ts` in `@ddl/core`):
/// `![[Plan.excalidraw|360|right-wrap]]`, `![[Plan.excalidraw|360x240]]`, `![[Plan.excalidraw|left]]`.
/// After the first `|` come an optional alias, an optional size (`360`, `360x240`, `x240`, `50%`)
/// and an optional style; no style is full width. The embed's line is its anchor in the note.
public struct DrawingEmbed: Hashable, Sendable {
  public enum Placement: String, Hashable, Sendable, CaseIterable {
    case full
    case left
    case right
    case center
    case leftWrap = "left-wrap"
    case rightWrap = "right-wrap"

    /// Whether text flows around the drawing.
    public var wraps: Bool { self == .leftWrap || self == .rightWrap }
  }

  /// As written: `Plan.excalidraw` (Obsidian leaves out `.md`), or a path.
  public var target: String
  /// `#…` after the target.
  public var subpath: String?
  public var alias: String?
  /// Pixels.
  public var width: Double?
  public var height: Double?
  /// Percent of the note's width, instead of `width`.
  public var widthPercent: Double?
  public var heightPercent: Double?
  public var placement: Placement
  /// A style that isn't a placement, kept so writing the embed back doesn't drop it.
  public var style: String?
  /// Where the whole `![[…]]` is in the text it was found in (UTF-16 offsets).
  public var range: NSRange?

  public init(
    target: String, subpath: String? = nil, alias: String? = nil, width: Double? = nil,
    height: Double? = nil, widthPercent: Double? = nil, heightPercent: Double? = nil,
    placement: Placement = .full, style: String? = nil
  ) {
    self.target = target
    self.subpath = subpath
    self.alias = alias
    self.width = width
    self.height = height
    self.widthPercent = widthPercent
    self.heightPercent = heightPercent
    self.placement = placement
    self.style = style
  }

  /// A new drawing's embed: 360 px wide, floating right with text wrapping around it.
  public static func newDrawing(target: String) -> DrawingEmbed {
    DrawingEmbed(target: target, width: 360, placement: .rightWrap)
  }

  /// True when a link target names a drawing file (`Plan.excalidraw` or `Plan.excalidraw.md`).
  public static func isDrawingTarget(_ target: String) -> Bool {
    let lower = target.trimmingCharacters(in: .whitespaces).lowercased()
    return lower.hasSuffix(".excalidraw") || lower.hasSuffix(".excalidraw.md")
  }

  /// Every drawing embed in `text`, in order.
  public static func find(in text: String) -> [DrawingEmbed] {
    let ns = text as NSString
    var embeds: [DrawingEmbed] = []
    var searchFrom = 0
    while searchFrom < ns.length {
      let open = ns.range(
        of: "![[", range: NSRange(location: searchFrom, length: ns.length - searchFrom))
      guard open.location != NSNotFound else { break }
      let innerStart = open.location + 3
      let close = ns.range(
        of: "]]", range: NSRange(location: innerStart, length: ns.length - innerStart))
      guard close.location != NSNotFound else { break }
      let inner = ns.substring(
        with: NSRange(location: innerStart, length: close.location - innerStart))
      if !inner.contains("\n"), !inner.contains("[["), var embed = parse(inner: inner) {
        embed.range = NSRange(location: open.location, length: close.location + 2 - open.location)
        embeds.append(embed)
        searchFrom = close.location + 2
      } else {
        searchFrom = innerStart
      }
    }
    return embeds
  }

  /// The embed a line holds when it's nothing but one (spaces aside).
  public static func parse(line: String) -> DrawingEmbed? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("![["), trimmed.hasSuffix("]]"), trimmed.count > 5 else { return nil }
    let inner = String(trimmed.dropFirst(3).dropLast(2))
    guard !inner.contains("[["), !inner.contains("]]") else { return nil }
    return parse(inner: inner)
  }

  /// `parseDrawingEmbed` for the text between `![[` and `]]`.
  public static func parse(inner: String, isDrawing: Bool = false) -> DrawingEmbed? {
    var parts = inner.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    var link = parts.removeFirst()
    var subpath: String?
    if let hash = link.firstIndex(of: "#") {
      subpath = String(link[link.index(after: hash)...])
      link = String(link[..<hash])
    }
    let target = link.trimmingCharacters(in: .whitespaces)
    guard isDrawing || isDrawingTarget(target) else { return nil }
    var embed = DrawingEmbed(target: target, subpath: subpath)
    guard !parts.isEmpty else { return embed }
    let pieces = parts.map { $0.trimmingCharacters(in: .whitespaces) }
    let (alias, size, style) = splitAlias(pieces)
    if let alias, !alias.isEmpty { embed.alias = alias }
    if let size {
      embed.width = size.width
      embed.height = size.height
      embed.widthPercent = size.widthPercent
      embed.heightPercent = size.heightPercent
    }
    if let style, !style.isEmpty {
      if let placement = Placement(rawValue: style), placement != .full {
        embed.placement = placement
      } else {
        embed.style = style
      }
    }
    return embed
  }

  /// The `![[…]]` text, in the order the plugin reads its parts back.
  public var markdown: String {
    let size = sizeText
    let styleText = placement != .full ? placement.rawValue : style
    let parts = [alias, size.isEmpty ? nil : size, styleText].compactMap { $0 }.filter {
      !$0.isEmpty
    }
    let sub = subpath.map { "#\($0)" } ?? ""
    return "![[\(target)\(sub)\(parts.map { "|\($0)" }.joined())]]"
  }

  /// The drawing's name: `Excalidraw/Plan.excalidraw.md` → `Plan`.
  public var name: String { DrawingFileName.title(fromPath: target) }

  struct Size {
    var width: Double?
    var height: Double?
    var widthPercent: Double?
    var heightPercent: Double?
  }

  /// The plugin's `parseAlias`: which parts are the alias, the size and the style.
  static func splitAlias(_ parts: [String]) -> (alias: String?, size: Size?, style: String?) {
    let first = parts.first ?? ""
    let second = parts.count > 1 ? parts[1] : ""
    let last = parts.last ?? ""
    switch parts.count {
    case 1:
      if let size = parseSize(first) { return (nil, size, nil) }
      return (nil, nil, first)
    case 2:
      if let size = parseSize(second) { return (first, size, nil) }
      if let size = parseSize(first) { return (nil, size, second) }
      return (first, nil, second)
    default:
      if let size = parseSize(second) { return (first, size, last) }
      return (first, nil, last)
    }
  }

  /// `360`, `360x240`, `x240`, `50%`, `50%x200`; a value starting with 0 must be `0` itself.
  static func parseSize(_ part: String) -> Size? {
    guard
      let regex = try? NSRegularExpression(pattern: "^(?:(\\d+%?)(?:x(\\d+%?))?|x(\\d+%?))$"),
      let match = regex.firstMatch(
        in: part, range: NSRange(location: 0, length: (part as NSString).length))
    else { return nil }
    func group(_ index: Int) -> String? {
      let range = match.range(at: index)
      return range.location == NSNotFound ? nil : (part as NSString).substring(with: range)
    }
    let width = group(1)
    let height = group(2) ?? group(3)
    for value in [width, height].compactMap({ $0 }) where value.hasPrefix("0") && value != "0" {
      return nil
    }
    var size = Size()
    if let width {
      if width.hasSuffix("%") {
        size.widthPercent = Double(width.dropLast())
      } else {
        size.width = Double(width)
      }
    }
    if let height {
      if height.hasSuffix("%") {
        size.heightPercent = Double(height.dropLast())
      } else {
        size.height = Double(height)
      }
    }
    return size
  }

  var sizeText: String {
    let widthText: String =
      if let widthPercent { "\(JSNumberFormat.string(widthPercent))%" } else if let width {
        String(Int(width.rounded()))
      } else { "" }
    let heightText: String =
      if let heightPercent { "\(JSNumberFormat.string(heightPercent))%" } else if let height {
        String(Int(height.rounded()))
      } else { "" }
    return heightText.isEmpty ? widthText : "\(widthText)x\(heightText)"
  }
}

/// Drawing file names and paths, as the plugin makes them (`file.ts` in `@ddl/core`).
public enum DrawingFileName {
  /// The plugin's default folder for new drawings.
  public static let folder = "Excalidraw"
  public static let fileExtension = ".excalidraw.md"

  /// `Drawing 2026-09-25 11.52.33`: the name for a drawing made at `date`, in local time.
  public static func name(at date: Date, timeZone: TimeZone = .current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    func two(_ value: Int?) -> String { String(format: "%02d", value ?? 0) }
    return "Drawing \(parts.year ?? 0)-\(two(parts.month))-\(two(parts.day)) "
      + "\(two(parts.hour)).\(two(parts.minute)).\(two(parts.second))"
  }

  /// `Excalidraw/<name>.excalidraw.md`, with characters that don't belong in a file name removed.
  public static func path(forName name: String, folder: String = folder) -> String {
    var clean = name.replacingOccurrences(
      of: "(\\.excalidraw)?(\\.md)?$", with: "", options: [.regularExpression, .caseInsensitive])
    clean = clean.replacingOccurrences(
      of: "[\\\\/:*?\"<>|#^\\[\\]]", with: " ", options: .regularExpression)
    clean = clean.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    if clean.isEmpty { clean = "Drawing" }
    return folder.isEmpty ? "\(clean)\(fileExtension)" : "\(folder)/\(clean)\(fileExtension)"
  }

  /// `path(forName:)`, then `<name>_0`, `<name>_1`, … while `exists` says it's taken.
  public static func uniquePath(
    forName name: String, folder: String = folder, exists: (String) -> Bool
  ) -> String {
    let path = path(forName: name, folder: folder)
    guard exists(path) else { return path }
    let stem = String(path.dropLast(fileExtension.count))
    var index = 0
    while exists("\(stem)_\(index)\(fileExtension)") { index += 1 }
    return "\(stem)_\(index)\(fileExtension)"
  }

  /// The path of a drawing made at `date`.
  public static func path(at date: Date, timeZone: TimeZone = .current) -> String {
    path(forName: name(at: date, timeZone: timeZone))
  }

  /// Whether a vault path is a drawing file.
  public static func isDrawingPath(_ path: String) -> Bool {
    path.lowercased().hasSuffix(fileExtension)
  }

  /// A drawing's title: `Excalidraw/Plan.excalidraw.md` → `Plan`.
  public static func title(fromPath path: String) -> String {
    let base = path.split(separator: "/").last.map(String.init) ?? path
    return base.replacingOccurrences(
      of: "(\\.excalidraw)?(\\.md)?$", with: "", options: [.regularExpression, .caseInsensitive])
  }
}
