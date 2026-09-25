import Foundation

/// Why a drawing file couldn't be read.
public enum DrawingFileError: Error, Equatable, CustomStringConvertible {
  /// No `## Drawing` section with a `json` or `compressed-json` block.
  case missingDrawing
  /// The `compressed-json` block isn't valid LZ-String data.
  case undecompressable
  case invalidScene(SceneCodecError)

  public var description: String {
    switch self {
    case .missingDrawing: "The file has no “## Drawing” section."
    case .undecompressable: "The compressed drawing couldn't be decompressed."
    case .invalidScene(let error): error.description
    }
  }
}

/// A text element as the file's `## Text Elements` section lists it: its text, then ` ^id`.
public struct TextElementEntry: Hashable, Sendable {
  public var id: String
  public var text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

/// An Obsidian Excalidraw plugin file (`*.excalidraw.md`):
///
/// ```
/// ---
/// excalidraw-plugin: parsed
/// tags: [excalidraw]
/// ---
/// ==⚠  Switch to EXCALIDRAW VIEW … ⚠== …
///
/// # Excalidraw Data
///
/// ## Text Elements
/// Hello ^abc12345
///
/// %%
/// ## Drawing
/// ```json
/// {"type":"excalidraw","version":2,…}
/// ```
/// %%
/// ```
///
/// It reads `json` and `compressed-json` drawings and always writes `json`. The frontmatter, the
/// notice and any markdown above the data, the `## Element Links` and `## Embedded Files`
/// sections, and what follows the drawing are kept verbatim; `## Text Elements` is regenerated
/// from the scene.
public struct ExcalidrawMarkdown: Hashable, Sendable {
  public enum Encoding: Hashable, Sendable {
    case json
    case compressedJSON
  }

  /// Everything above the data: frontmatter, the plugin's notice, the note's own markdown.
  public var header: String
  /// The plugin's newer layout opens the `%%` comment above `# Excalidraw Data` instead of
  /// above `## Drawing`.
  public var dataCommentedOut: Bool
  /// The text elements as the file listed them (their raw text, links included).
  public var textElements: [TextElementEntry]
  /// Sections between the text elements and the drawing, verbatim (`## Element Links`,
  /// `## Embedded Files`).
  public var otherSections: String
  public var scene: ExcalidrawScene
  /// How the drawing was stored when read (it's always written as `json`).
  public var encoding: Encoding
  /// What follows the drawing's closing fence: the closing `%%` and anything after it.
  public var trailer: String

  /// Element versions as read, so text elements nobody changed keep their raw text.
  var versionsAtRead: [String: Int] = [:]

  public init(
    scene: ExcalidrawScene, header: String = ExcalidrawMarkdown.defaultHeader,
    dataCommentedOut: Bool = false, textElements: [TextElementEntry] = [],
    otherSections: String = "", encoding: Encoding = .json, trailer: String = "%%\n"
  ) {
    self.scene = scene
    self.header = header
    self.dataCommentedOut = dataCommentedOut
    self.textElements = textElements
    self.otherSections = otherSections
    self.encoding = encoding
    self.trailer = trailer
  }

  /// The plugin's notice line.
  public static let notice =
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'"

  /// The frontmatter and notice of a new drawing (the plugin's `FRONTMATTER`, then a blank line).
  public static let defaultHeader =
    "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n\(notice)\n\n\n"

  // MARK: Reading

  public static func parse(_ text: String) throws -> ExcalidrawMarkdown {
    let text = text.replacingOccurrences(of: "\r\n", with: "\n")
    let ns = text as NSString
    let whole = NSRange(location: 0, length: ns.length)

    var encoding = Encoding.json
    var match = drawingJSON.firstMatch(in: text, range: whole)
    if text.contains("```compressed-json\n") {
      if let compressed = drawingCompressed.firstMatch(in: text, range: whole) {
        match = compressed
        encoding = .compressedJSON
      }
    }
    if match == nil {
      match = drawingJSONUnterminated.firstMatch(in: text, range: whole)
    }
    guard let match else { throw DrawingFileError.missingDrawing }

    let headingStart = match.range.location + 1  // after the "\n" before "## Drawing"
    let body = ns.substring(with: match.range(at: 1))
    let after = ns.substring(from: match.range.location + match.range.length)

    var sceneText: String
    switch encoding {
    case .json:
      sceneText = body
    case .compressedJSON:
      let cleaned = body.filter { $0 != "\n" && $0 != "\r" }
      guard let decompressed = LZString.decompressFromBase64(cleaned), !decompressed.isEmpty else {
        throw DrawingFileError.undecompressable
      }
      sceneText = decompressed
    }
    if let lastBrace = sceneText.lastIndex(of: "}") {
      sceneText = String(sceneText[...lastBrace])
    }
    let scene: ExcalidrawScene
    do {
      scene = try SceneCodec.decode(sceneText)
    } catch let error as SceneCodecError {
      throw DrawingFileError.invalidScene(error)
    }

    var before = ns.substring(to: headingStart)
    var document = ExcalidrawMarkdown(
      scene: scene, header: before, encoding: encoding, trailer: after)
    let beforeNS = before as NSString
    let beforeRange = NSRange(location: 0, length: beforeNS.length)
    if let data = dataHeading.firstMatch(in: before, range: beforeRange)
      ?? textElementsHeading.firstMatch(in: before, range: beforeRange)
    {
      document.header = beforeNS.substring(to: data.range.location)
      document.dataCommentedOut = beforeNS.substring(with: data.range).hasPrefix("%%")
      var section = beforeNS.substring(from: data.range.location + data.range.length)
      // "# Excalidraw Data" is followed by "## Text Elements" (and blank lines between them).
      let sectionNS = section as NSString
      if let heading = textElementsHeading.firstMatch(
        in: section, range: NSRange(location: 0, length: sectionNS.length)),
        heading.range.location == leadingBlankLength(section)
      {
        section = sectionNS.substring(from: heading.range.location + heading.range.length)
      }
      if !document.dataCommentedOut, section.hasSuffix("%%\n") {
        section.removeLast(3)
      }
      let (entries, rest) = splitTextElements(section)
      document.textElements = entries
      document.otherSections = rest
    } else {
      // No data section yet (the plugin's blank template): the opening "%%" belongs to it.
      if before.hasSuffix("%%\n") { before.removeLast(3) }
      document.header = before
    }
    document.versionsAtRead = Dictionary(
      scene.elements.map { ($0.id, $0.version) }, uniquingKeysWith: { first, _ in first })
    return document
  }

  // MARK: Writing

  /// The file's text, with the drawing as uncompressed `json`.
  public func serialized() -> String {
    var output = header
    if !output.isEmpty, !output.hasSuffix("\n") { output += "\n" }
    if dataCommentedOut { output += "%%\n" }
    output += "# Excalidraw Data\n\n## Text Elements\n"
    for entry in regeneratedTextElements() {
      output += "\(entry.text) ^\(entry.id)\n\n"
    }
    output += otherSections
    if !dataCommentedOut { output += "%%\n" }
    output += "## Drawing\n```json\n"
    output += SceneCodec.encode(scene)
    output += "\n```\n"
    output += trailer.isEmpty ? "%%\n" : trailer
    return output
  }

  /// The `## Text Elements` entries for the current scene: ids the file listed keep their
  /// place, new ones follow in z-order. The text is the element's raw text: the plugin's
  /// `rawText`, the file's own text while the element is unchanged, else `originalText`.
  public func regeneratedTextElements() -> [TextElementEntry] {
    let texts = scene.elements.filter { $0.type == .text && !$0.isDeleted }
    let byId = Dictionary(texts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let listed = Dictionary(
      textElements.map { ($0.id, $0.text) }, uniquingKeysWith: { first, _ in first })
    var order: [String] = []
    var seen = Set<String>()
    for entry in textElements where byId[entry.id] != nil && seen.insert(entry.id).inserted {
      order.append(entry.id)
    }
    for element in texts where seen.insert(element.id).inserted { order.append(element.id) }
    return order.compactMap { id in
      guard let element = byId[id] else { return nil }
      if let raw = element.extraField("rawText")?.stringValue {
        return TextElementEntry(id: id, text: raw)
      }
      if let text = listed[id], versionsAtRead[id] == element.version {
        return TextElementEntry(id: id, text: text)
      }
      let text = element.text?.originalText ?? element.text?.text ?? ""
      return TextElementEntry(id: id, text: text)
    }
  }

  // MARK: Parsing helpers

  private static func regex(_ pattern: String) -> NSRegularExpression {
    // The patterns are constants; a typo is a programming error.
    try! NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
  }

  // The plugin's own patterns (excalidrawMarkdownParsing.ts), capturing the block's body.
  static let drawingJSON = regex("\\n##? Drawing\\n[^`]*```json\\n([\\s\\S]*?)```\\n")
  static let drawingJSONUnterminated = regex(
    "\\n##? Drawing\\n[^`]*```json\\n([\\s\\S]*?)```")
  static let drawingCompressed = regex(
    "\\n##? Drawing\\n[^`]*```compressed-json\\n([\\s\\S]*?)```\\n?")
  static let dataHeading = regex("^(%%\\n+)?# Excalidraw Data(?:\\n|$)")
  static let textElementsHeading = regex("^(%%\\n+)?##? Text Elements(?:\\n|$)")
  static let blockReference = regex("\\s\\^([A-Za-z0-9_-]+)\\n+")

  private static func leadingBlankLength(_ text: String) -> Int {
    (text as NSString).length - (text.drop { $0 == "\n" } as Substring).utf16.count
  }

  /// The text elements (each text up to its ` ^id`) and what follows the last one, verbatim.
  static func splitTextElements(_ section: String) -> ([TextElementEntry], String) {
    let ns = section as NSString
    var entries: [TextElementEntry] = []
    var position = 0
    let whole = NSRange(location: 0, length: ns.length)
    for match in blockReference.matches(in: section, range: whole) {
      let text = ns.substring(
        with: NSRange(location: position, length: match.range.location - position))
      entries.append(TextElementEntry(id: ns.substring(with: match.range(at: 1)), text: text))
      position = match.range.location + match.range.length
    }
    return (entries, ns.substring(from: position))
  }
}
