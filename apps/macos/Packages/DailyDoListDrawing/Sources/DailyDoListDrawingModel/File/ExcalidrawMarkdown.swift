import Foundation

/// What went wrong reading a drawing file (`DrawingProblem` in `@ddl/core`).
public struct DrawingProblem: Hashable, Sendable {
  public enum Code: String, Hashable, Sendable {
    /// No `## Drawing` block with a json or compressed-json fence.
    case noDrawing = "no-drawing"
    case decompressFailed = "decompress-failed"
    case invalidJSON = "invalid-json"
    /// The JSON isn't an object with an `elements` array.
    case notAScene = "not-a-scene"
    /// Elements without a string `id` and `type` were dropped.
    case invalidElement = "invalid-element"
    /// The fence isn't closed; the rest of the file was read as the scene.
    case unclosedFence = "unclosed-fence"
  }

  public enum Severity: String, Hashable, Sendable {
    /// The scene couldn't be read.
    case error
    case warning
  }

  public var code: Code
  public var severity: Severity
  public var message: String
}

/// Thrown when asked to write over a file whose scene couldn't be read.
public struct DrawingUnreadableError: Error, Hashable, Sendable, CustomStringConvertible {
  public var problems: [DrawingProblem]

  public var description: String {
    "The previous drawing couldn't be read (\(problems.map(\.code.rawValue).joined(separator: ", "))); writing would lose it"
  }
}

/// The frontmatter block of a drawing file.
public struct DrawingFrontmatter: Hashable, Sendable {
  /// The whole block with its `---` fences and final line break; `""` when there is none.
  public var raw: String
  /// Top-level `key: value` lines, values as written (`tags` → `[excalidraw]`), in order.
  public var entries: [(key: String, value: String)]

  public subscript(key: String) -> String? { entries.last { $0.key == key }?.value }

  public static func == (lhs: DrawingFrontmatter, rhs: DrawingFrontmatter) -> Bool {
    lhs.raw == rhs.raw && lhs.entries.map(\.key) == rhs.entries.map(\.key)
      && lhs.entries.map(\.value) == rhs.entries.map(\.value)
  }

  public func hash(into hasher: inout Hasher) { hasher.combine(raw) }
}

/// One `## Text Elements` entry: the text, then ` ^<element id>` (an Obsidian block reference).
public struct TextElementEntry: Hashable, Sendable {
  public var id: String
  public var text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

/// A part of the file after the frontmatter, split at headings.
public struct DrawingFileSection: Hashable, Sendable {
  /// The heading line (`## Embedded Files`); `""` for the text above the drawing data.
  public var heading: String
  /// Everything after the heading line, up to the next section, verbatim.
  public var body: String

  public init(heading: String, body: String) {
    self.heading = heading
    self.body = body
  }
}

/// An Obsidian Excalidraw plugin file (`Name.excalidraw.md`), read and written exactly the way
/// `@ddl/core` does (`packages/core/src/drawings/file.ts`, the reference; the shared fixtures in
/// `packages/core/test/drawings/` hold both to it):
///
/// ```
/// ---
///
/// excalidraw-plugin: parsed
/// tags: [excalidraw]
///
/// ---
/// ==⚠  Switch to EXCALIDRAW VIEW … ⚠== …
///
/// # Excalidraw Data
///
/// ## Text Elements
/// API ^k3JwQm9a
///
/// %%
/// ## Drawing
/// ```json
/// { "type": "excalidraw", "version": 2, "source": …, "elements": […], … }
/// ```
/// %%
/// ```
///
/// It writes `json` and reads `json` and `compressed-json` (LZ-String base64). `## Text Elements`
/// is the truth on reading (an edited entry updates its element, as in the plugin) and is
/// regenerated on writing; everything else (frontmatter, the text above the data, other sections,
/// fields of the scene, its `appState`, files and elements) is kept from the previous file.
public struct ExcalidrawMarkdown: Sendable {
  /// The scene (empty when it couldn't be read). Edit it and call ``serialized(compressed:)``.
  public var scene: ExcalidrawScene
  public let frontmatter: DrawingFrontmatter
  /// As listed under `## Text Elements`; one that differed from its element was applied to it.
  public let textElements: [TextElementEntry]
  public let sections: [DrawingFileSection]
  /// The scene was stored as `compressed-json`.
  public let compressed: Bool
  /// False when the scene couldn't be read: show the problem and don't save over the file.
  public let readable: Bool
  public let problems: [DrawingProblem]
  /// The scene as read, what writing keeps fields from.
  public let parsedScene: ExcalidrawScene

  /// The line the plugin writes under the frontmatter, for readers without the plugin.
  public static let notice =
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'"
  static let defaultFrontmatter = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n"
  static let compressedLineChars = 256

  // MARK: Reading

  /// Reads a drawing file. Never throws: problems are reported, and a file whose scene is
  /// unreadable comes back with an empty scene and `readable` false.
  public static func parse(_ text: String) -> ExcalidrawMarkdown {
    var source = text
    if source.hasPrefix("\u{FEFF}") { source.removeFirst() }
    source = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(
      of: "\r", with: "\n")
    var problems: [DrawingProblem] = []
    let block = splitFrontmatter(source)
    let frontmatter = DrawingFrontmatter(
      raw: block?.raw ?? "", entries: block.map { frontmatterEntries($0.inner) } ?? [])
    let body = String(source.dropFirst(frontmatter.raw.count))
    let drawing = findDrawingBlock(body)

    var scene: ExcalidrawScene?
    if let drawing {
      if !drawing.closed {
        problems.append(
          DrawingProblem(
            code: .unclosedFence, severity: .warning,
            message: "The scene's code block isn't closed; read it to the end of the file."))
      }
      scene = readScene(drawing, problems: &problems)
    } else {
      problems.append(
        DrawingProblem(
          code: .noDrawing, severity: .error,
          message: "The file has no `## Drawing` section with the scene."))
    }

    let sections = splitSections(body, drawing: drawing)
    let drawingIndex = drawing != nil ? findDrawingSection(sections) : sections.count
    let textIndex = findSection(sections, isTextHeading, before: drawingIndex)
    let ids = scene.map { Set($0.elements.map(\.id)) }
    let entries = textIndex == -1 ? [] : readTextEntries(sections[textIndex].body, ids: ids).entries
    if scene != nil { applyTextEntries(&scene!, entries) }
    let result = scene ?? ExcalidrawScene()
    return ExcalidrawMarkdown(
      scene: result, frontmatter: frontmatter, textElements: entries, sections: sections,
      compressed: drawing?.format == .compressedJSON, readable: scene != nil, problems: problems,
      parsedScene: result)
  }

  static func splitFrontmatter(_ text: String) -> (raw: String, inner: String)? {
    guard text.hasPrefix("---"), let first = text.firstIndex(of: "\n"),
      trimEnd(text[..<first]) == "---"
    else { return nil }
    var position = text.index(after: first)
    while position < text.endIndex {
      let newline = text[position...].firstIndex(of: "\n")
      let end = newline ?? text.endIndex
      if trimEnd(text[position..<end]) == "---" {
        let rawEnd = newline.map { text.index(after: $0) } ?? end
        return (String(text[..<rawEnd]), String(text[text.index(after: first)..<position]))
      }
      guard let newline else { break }
      position = text.index(after: newline)
    }
    return nil
  }

  static func frontmatterEntries(_ inner: String) -> [(key: String, value: String)] {
    var entries: [(key: String, value: String)] = []
    for line in inner.split(separator: "\n", omittingEmptySubsequences: false) {
      guard let first = line.first, !JSWhitespace.contains(first), first != "#", first != "-",
        let colon = line.firstIndex(of: ":"), colon != line.startIndex
      else { continue }
      var key = JSWhitespace.trim(line[..<colon])
      if key.count >= 2, let q = key.first, q == "\"" || q == "'", key.last == q {
        key = String(key.dropFirst().dropLast())
      }
      guard !key.isEmpty else { continue }
      let value = JSWhitespace.trim(line[line.index(after: colon)...])
      if let index = entries.firstIndex(where: { $0.key == key }) {
        entries[index].value = value
      } else {
        entries.append((key, value))
      }
    }
    return entries
  }

  enum SceneFormat: Equatable {
    case json
    case compressedJSON
  }

  struct DrawingBlock {
    /// Where the heading line starts (an offset in the body, in characters).
    var start: String.Index
    var heading: String
    var bodyStart: String.Index
    var end: String.Index
    var format: SceneFormat
    var content: String
    var closed: Bool
  }

  /// Lines of `text` (from `start`) with where each starts, ends and where the next one does,
  /// scanned lazily on the UTF-8 view (a line break is always a character boundary).
  static func lines(_ text: String, from start: String.Index? = nil) -> LineSequence {
    LineSequence(text: text, start: start ?? text.startIndex)
  }

  struct LineSequence: Sequence {
    let text: String
    let start: String.Index

    struct Iterator: IteratorProtocol {
      let utf8: String.UTF8View
      var position: String.Index

      mutating func next() -> (start: String.Index, end: String.Index, next: String.Index)? {
        guard position < utf8.endIndex else { return nil }
        let lineStart = position
        let newline = utf8[position...].firstIndex(of: 10)
        let end = newline ?? utf8.endIndex
        position = newline.map { utf8.index(after: $0) } ?? utf8.endIndex
        return (lineStart, end, position)
      }
    }

    func makeIterator() -> Iterator { Iterator(utf8: text.utf8, position: start) }
  }

  /// The first byte of a line, for cheap checks before comparing text.
  static func firstByte(_ text: String, _ index: String.Index) -> UInt8? {
    index < text.utf8.endIndex ? text.utf8[index] : nil
  }

  static func isDrawingHeading(_ line: Substring) -> Bool {
    var rest = line
    guard rest.hasPrefix("#") else { return false }
    rest = rest.dropFirst()
    if rest.hasPrefix("#") { rest = rest.dropFirst() }
    guard rest.hasPrefix(" Drawing") else { return false }
    return rest.dropFirst(8).allSatisfy { $0 == " " || $0 == "\t" }
  }

  static func sceneFence(_ line: Substring) -> SceneFormat? {
    let trimmed = line.reversed().drop { $0 == " " || $0 == "\t" }
    let content = String(trimmed.reversed())
    if content == "```json" { return .json }
    if content == "```compressed-json" { return .compressedJSON }
    return nil
  }

  static func isClosingFence(_ line: Substring) -> Bool {
    line.hasPrefix("```") && line.dropFirst(3).allSatisfy { $0 == " " || $0 == "\t" }
  }

  /// `%%` then spaces or tabs, then a line break or the end.
  static func commentLineLength(_ text: Substring) -> Int? {
    guard text.hasPrefix("%%") else { return nil }
    var index = text.index(text.startIndex, offsetBy: 2)
    while index < text.endIndex, text[index] == " " || text[index] == "\t" {
      index = text.index(after: index)
    }
    if index == text.endIndex { return text.distance(from: text.startIndex, to: index) }
    guard text[index] == "\n" else { return nil }
    return text.distance(from: text.startIndex, to: text.index(after: index))
  }

  /// The last `## Drawing` heading followed (after blank lines) by a json or compressed-json fence.
  static func findDrawingBlock(_ body: String) -> DrawingBlock? {
    var found: DrawingBlock?
    for line in lines(body)
    where firstByte(body, line.start) == UInt8(ascii: "#")
      && isDrawingHeading(body[line.start..<line.end])
    {
      if let block = readDrawingBlock(
        body, start: line.start, heading: String(body[line.start..<line.end]))
      {
        found = block
      }
    }
    return found
  }

  static func readDrawingBlock(_ body: String, start: String.Index, heading: String)
    -> DrawingBlock?
  {
    let headingEnd = body.index(start, offsetBy: heading.count)
    let bodyStart = headingEnd < body.endIndex ? body.index(after: headingEnd) : body.endIndex
    for line in lines(body, from: bodyStart) {
      let text = body[line.start..<line.end]
      if JSWhitespace.trim(text).isEmpty { continue }
      guard let format = sceneFence(text) else { return nil }
      let contentStart = line.next
      for candidate in lines(body, from: contentStart)
      where isClosingFence(body[candidate.start..<candidate.end]) {
        var end = candidate.end
        if end < body.endIndex, body[end] == "\n" { end = body.index(after: end) }
        if let comment = commentLineLength(body[end...]) {
          end = body.index(end, offsetBy: comment)
        }
        return DrawingBlock(
          start: start, heading: heading, bodyStart: bodyStart, end: end, format: format,
          content: String(body[contentStart..<candidate.start]), closed: true)
      }
      var content = String(body[contentStart...])
      // No closing fence: the rest, minus a trailing `%%` line.
      if let range = content.range(of: "\n%%[ \\t]*\\n*$", options: .regularExpression) {
        content.replaceSubrange(range, with: "\n")
      }
      return DrawingBlock(
        start: start, heading: heading, bodyStart: bodyStart, end: body.endIndex, format: format,
        content: content, closed: false)
    }
    return nil
  }

  static func readScene(_ block: DrawingBlock, problems: inout [DrawingProblem]) -> ExcalidrawScene?
  {
    var json = block.content
    if block.format == .compressedJSON {
      let packed = String(block.content.filter { !JSWhitespace.contains($0) })
      guard !packed.isEmpty, let unpacked = LZString.decompressFromBase64(packed), !unpacked.isEmpty
      else {
        problems.append(
          DrawingProblem(
            code: .decompressFailed, severity: .error,
            message: "The compressed scene couldn't be decompressed."))
        return nil
      }
      json = unpacked
    }
    // Like the plugin: ignore anything after the last brace.
    if let last = json.lastIndex(of: "}") { json = String(json[...last]) }
    let value: JSONValue
    do {
      value = try JSONParser.parse(json)
    } catch {
      problems.append(
        DrawingProblem(
          code: .invalidJSON, severity: .error, message: "The scene isn't valid JSON: \(error)"))
      return nil
    }
    guard var object = value.objectValue, let items = object["elements"]?.arrayValue else {
      problems.append(
        DrawingProblem(
          code: .notAScene, severity: .error,
          message: "The scene isn't an object with an `elements` list."))
      return nil
    }
    let kept = items.filter { item in
      guard let element = item.objectValue else { return false }
      return element["id"]?.stringValue != nil && element["type"]?.stringValue != nil
    }
    let dropped = items.count - kept.count
    if dropped > 0 {
      problems.append(
        DrawingProblem(
          code: .invalidElement, severity: .warning,
          message:
            "\(dropped) element\(dropped == 1 ? "" : "s") without an id and a type were dropped."))
    }
    object["elements"] = .array(kept)
    if object["appState"]?.objectValue == nil { object["appState"] = .object(JSONObject()) }
    if object["files"]?.objectValue == nil { object["files"] = .object(JSONObject()) }
    return try? SceneCodec.decode(.object(object))
  }

  static func isTextHeading(_ line: String) -> Bool {
    line.range(of: "^##? Text Elements[ \\t]*$", options: .regularExpression) != nil
  }

  static func isDataHeading(_ line: String) -> Bool {
    line.range(of: "^# Excalidraw Data[ \\t]*$", options: .regularExpression) != nil
  }

  static func isAfterTextHeading(_ line: Substring) -> Bool {
    String(line).range(
      of: "^##? (?:Element Links|Embedded [Ff]iles)[ \\t]*$", options: .regularExpression) != nil
  }

  /// `^#{1,6}(?:[ \t].*)?$`.
  static func isHeading(_ line: Substring) -> Bool {
    let hashes = line.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes) else { return false }
    let rest = line.dropFirst(hashes)
    return rest.isEmpty || rest.first == " " || rest.first == "\t"
  }

  /// The text after the frontmatter as sections: the part above the drawing data (heading
  /// `""`), then one per heading from `# Excalidraw Data` on. `## Text Elements` runs to
  /// `## Element Links`, `## Embedded Files` or the drawing.
  static func splitSections(_ body: String, drawing: DrawingBlock?) -> [DrawingFileSection] {
    let limit = drawing?.start ?? body.endIndex
    let before = lines(body).prefix { $0.start < limit }.filter {
      firstByte(body, $0.start) == UInt8(ascii: "#")
    }
    let data =
      before.first { isDataHeading(String(body[$0.start..<$0.end])) }
      ?? before.first { isTextHeading(String(body[$0.start..<$0.end])) }
    let dataStart = data?.start ?? limit
    var sections = [DrawingFileSection(heading: "", body: String(body[..<dataStart]))]
    splitAtHeadings(String(body[dataStart..<limit]), into: &sections, dataArea: true)
    if let drawing {
      sections.append(
        DrawingFileSection(
          heading: drawing.heading, body: String(body[drawing.bodyStart..<drawing.end])))
      splitAtHeadings(String(body[drawing.end...]), into: &sections, dataArea: false)
    }
    return sections
  }

  /// Appends `text`'s sections; text before its first heading joins the last section.
  static func splitAtHeadings(
    _ text: String, into sections: inout [DrawingFileSection], dataArea: Bool
  ) {
    guard !text.isEmpty else { return }
    var inText = false
    for line in lines(text) {
      let content = text[line.start..<line.end]
      let starts =
        firstByte(text, line.start) == UInt8(ascii: "#")
        && (inText ? isAfterTextHeading(content) : isHeading(content))
      if starts {
        sections.append(DrawingFileSection(heading: String(content), body: ""))
        inText = dataArea && isTextHeading(String(content))
      } else {
        sections[sections.count - 1].body += text[line.start..<line.next]
      }
    }
  }

  /// A block reference: `^` + non-space characters, after whitespace or at the start, then
  /// spaces or tabs, then line breaks or the end.
  static let blockReference = try! NSRegularExpression(
    pattern: "(?<=^|\\s)\\^(\\S+)[ \\t]*(?:\\n+|$(?![\\s\\S]))")

  /// The entries of a `## Text Elements` body, and where the text after the last one starts.
  static func readTextEntries(_ body: String, ids: Set<String>?) -> (
    entries: [TextElementEntry], tail: String.Index
  ) {
    var entries: [TextElementEntry] = []
    let ns = body as NSString
    var chunk = 0
    var tail = 0
    for match in blockReference.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
      let id = ns.substring(with: match.range(at: 1))
      let known = ids == nil || ids!.contains(id)
      if !known && id.count != 8 { continue }
      if known {
        var text = ns.substring(
          with: NSRange(location: chunk, length: match.range.location - chunk))
        while text.hasPrefix("\n") { text.removeFirst() }
        if text.hasSuffix(" ") || text.hasSuffix("\t") { text.removeLast() }
        entries.append(TextElementEntry(id: id, text: text))
      }
      chunk = match.range.location + match.range.length
      tail = chunk
    }
    let tailIndex = String.Index(utf16Offset: tail, in: body)
    return (entries, tailIndex)
  }

  /// The plugin treats `## Text Elements` as the truth: an entry that differs updates its element.
  static func applyTextEntries(_ scene: inout ExcalidrawScene, _ entries: [TextElementEntry]) {
    guard !entries.isEmpty else { return }
    var indices: [String: Int] = [:]
    for (index, element) in scene.elements.enumerated()
    where element.type == .text && !element.isDeleted {
      indices[element.id] = index
    }
    for entry in entries {
      guard let index = indices[entry.id] else { continue }
      var element = scene.elements[index]
      var current = sectionText(element)
      while current.hasPrefix("\n") { current.removeFirst() }
      guard entry.text != current else { continue }
      if element.text == nil { element.text = TextProperties(text: "") }
      element.text?.text = entry.text
      element.text?.originalText = entry.text
      if element.extraField("rawText") != nil {
        element.setExtraField("rawText", .string(entry.text))
      }
      scene.elements[index] = element
    }
  }

  /// What `## Text Elements` lists for a text element: the plugin's raw text, else the text as
  /// typed, else the text.
  static func sectionText(_ element: ExcalidrawElement) -> String {
    if let raw = element.extraField("rawText")?.stringValue, !raw.isEmpty { return raw }
    return displayText(element)
  }

  static func displayText(_ element: ExcalidrawElement) -> String {
    if let original = element.text?.originalText, !original.isEmpty { return original }
    return element.text?.text ?? ""
  }

  // MARK: Writing

  /// This file with its scene written back (the file as read is the previous file).
  public func serialized(compressed: Bool = false) throws -> String {
    try Self.serialize(scene, previous: self, compressed: compressed)
  }

  /// A new file for a scene: the plugin's frontmatter and notice, the data sections, the scene.
  public static func newFile(for scene: ExcalidrawScene) -> String {
    // A new file has no previous one to be unreadable.
    (try? serialize(scene, previous: nil)) ?? ""
  }

  /// The file for `scene`. With the previous file, everything that isn't regenerated is kept.
  /// Throws ``DrawingUnreadableError`` when the previous file's scene couldn't be read.
  public static func serialize(
    _ scene: ExcalidrawScene, previous: ExcalidrawMarkdown?, compressed: Bool = false
  ) throws -> String {
    if let previous, !previous.readable {
      throw DrawingUnreadableError(problems: previous.problems)
    }
    let written = SceneWriter.object(for: scene, previous: previous?.parsedScene)
    let entries = SceneWriter.textEntries(written)
    let json = JSONWriter.string(.object(written), indent: "\t")
    let block =
      compressed
      ? "```compressed-json\n\(chunkLines(LZString.compressToBase64(json)))\n```\n%%\n"
      : "```json\n\(json)\n```\n%%\n"
    let entriesText = entries.map { "\($0.text) ^\($0.id)\n\n" }.joined()

    guard let previous else {
      return defaultFrontmatter + "\(notice)\n\n" + "# Excalidraw Data\n\n"
        + "## Text Elements\n\(entriesText)%%\n" + "## Drawing\n\(block)"
    }

    var sections = previous.sections
    if findDrawingSection(sections) == -1 {
      sections.append(DrawingFileSection(heading: "## Drawing", body: ""))
    }
    let drawingIndex = findDrawingSection(sections)
    sections[drawingIndex].body = block + afterSceneBlock(sections[drawingIndex].body)

    let textIndex = findSection(sections, isTextHeading, before: drawingIndex)
    if textIndex != -1 {
      let old = sections[textIndex].body
      let ids = Set(previous.parsedScene.elements.map(\.id))
      sections[textIndex].body = entriesText + old[readTextEntries(old, ids: ids).tail...]
    } else {
      let dataIndex = findSection(sections, isDataHeading, before: drawingIndex)
      if dataIndex != -1 && dataIndex + 1 < drawingIndex {
        sections.insert(
          DrawingFileSection(heading: "## Text Elements", body: entriesText), at: dataIndex + 1)
      } else {
        // The plugin's layout: the data, then `%%` to hide the scene in reading view.
        if sections[drawingIndex - 1].body.hasSuffix("%%\n") {
          sections[drawingIndex - 1].body.removeLast(3)
        }
        var inserted: [DrawingFileSection] = []
        if dataIndex == -1 {
          inserted.append(DrawingFileSection(heading: "# Excalidraw Data", body: "\n"))
        }
        inserted.append(DrawingFileSection(heading: "## Text Elements", body: "\(entriesText)%%\n"))
        sections.insert(contentsOf: inserted, at: drawingIndex)
      }
    }
    return frontmatterForWriting(previous.frontmatter)
      + sections.map { $0.heading.isEmpty ? $0.body : "\($0.heading)\n\($0.body)" }.joined()
  }

  /// The section holding the scene: the last `## Drawing` whose body opens with its fence.
  static func findDrawingSection(_ sections: [DrawingFileSection]) -> Int {
    var index = sections.count - 1
    while index > 0 {
      let section = sections[index]
      if isDrawingHeading(Substring(section.heading)) {
        let firstLine =
          section.body.split(separator: "\n", omittingEmptySubsequences: false)
          .first { !$0.allSatisfy { $0 == " " || $0 == "\t" } } ?? ""
        if sceneFence(firstLine) != nil { return index }
      }
      index -= 1
    }
    return -1
  }

  static func findSection(
    _ sections: [DrawingFileSection], _ matches: (String) -> Bool, before end: Int
  ) -> Int {
    guard end > 1 else { return -1 }
    for index in 1..<min(end, sections.count) where matches(sections[index].heading) {
      return index
    }
    return -1
  }

  /// What follows the scene's closing fence and `%%` line in the drawing section's body.
  static func afterSceneBlock(_ body: String) -> String {
    let allLines = lines(body)
    guard let open = allLines.first(where: { sceneFence(body[$0.start..<$0.end]) != nil }) else {
      return ""
    }
    guard
      let close = lines(body, from: open.end).first(where: {
        $0.start > open.start && isClosingFence(body[$0.start..<$0.end])
      })
    else { return "" }
    var after = body[close.end...]
    if after.hasPrefix("\n") { after = after.dropFirst() }
    if let comment = commentLineLength(after) { after = after.dropFirst(comment) }
    return String(after)
  }

  static func frontmatterForWriting(_ frontmatter: DrawingFrontmatter) -> String {
    if frontmatter.raw.isEmpty { return defaultFrontmatter }
    if frontmatter["excalidraw-plugin"] != nil { return frontmatter.raw }
    // The plugin recognizes drawings by this key; add it the way the plugin does.
    guard let range = frontmatter.raw.range(of: "^---[ \\t]*\\n", options: .regularExpression)
    else {
      return frontmatter.raw
    }
    return frontmatter.raw.replacingCharacters(in: range, with: "---\nexcalidraw-plugin: parsed\n")
  }

  static func chunkLines(_ text: String) -> String {
    var lines: [Substring] = []
    var index = text.startIndex
    while index < text.endIndex {
      let end =
        text.index(index, offsetBy: compressedLineChars, limitedBy: text.endIndex) ?? text.endIndex
      lines.append(text[index..<end])
      index = end
    }
    return lines.joined(separator: "\n\n")
  }

  static func trimEnd(_ text: Substring) -> String {
    String(text.reversed().drop { JSWhitespace.contains($0) }.reversed())
  }
}

/// JavaScript's `\s` (what `trim` and `\s` regexes strip).
enum JSWhitespace {
  static let scalars: Set<UInt32> = [
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
  ]

  static func contains(_ character: Character) -> Bool {
    character.unicodeScalars.allSatisfy { scalars.contains($0.value) }
  }

  static func contains(_ scalar: Unicode.Scalar) -> Bool { scalars.contains(scalar.value) }

  static func trim(_ text: Substring) -> String {
    let scalars = text.unicodeScalars
    guard let first = scalars.firstIndex(where: { !contains($0) }),
      let last = scalars.lastIndex(where: { !contains($0) })
    else { return "" }
    return String(String.UnicodeScalarView(scalars[first...last]))
  }
}
