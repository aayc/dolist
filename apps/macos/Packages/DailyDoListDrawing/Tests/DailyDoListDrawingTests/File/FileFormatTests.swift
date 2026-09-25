import DailyDoListDrawingModel
import Foundation
import Testing

/// The file format on this package's own plugin-style fixtures (the shared ones are replayed by
/// `SharedFixtureTests`).
@Suite("File format")
struct FileFormatTests {
  @Test func readsThePluginsJSONLayout() throws {
    let document = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-json.excalidraw.md"))
    #expect(document.readable)
    #expect(document.problems.isEmpty)
    #expect(!document.compressed)
    #expect(document.frontmatter["excalidraw-plugin"] == "parsed")
    #expect(document.frontmatter["tags"] == "[excalidraw]")
    #expect(
      document.sections.map(\.heading) == [
        "", "# Excalidraw Data", "## Text Elements", "## Element Links", "## Embedded Files",
        "## Drawing",
      ])
    #expect(document.sections[0].body.hasPrefix("==⚠  Switch to EXCALIDRAW VIEW"))
    #expect(
      document.textElements == [
        TextElementEntry(id: "Tx1a2b3c", text: "Plan"),
        TextElementEntry(id: "Tx4d5e6f", text: "Hello, drawings!\nSecond line"),
      ])
    #expect(document.scene.elements.count == 12)
  }

  @Test func writesThePluginsJSONLayoutBackWithAFinalLineBreak() throws {
    let text = try Fixtures.text("plugin-json.excalidraw.md")
    let written = try ExcalidrawMarkdown.parse(text).serialized()
    // The plugin ends its files after `%%`; the writer ends the `%%` line.
    #expect(written == text + "\n")
    #expect(try ExcalidrawMarkdown.parse(written).serialized() == written)
  }

  @Test func readsCompressedJSONAndWritesItUncompressed() throws {
    let compressed = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-compressed.excalidraw.md"))
    let plain = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-json.excalidraw.md"))
    #expect(compressed.compressed)
    #expect(compressed.readable)
    #expect(SceneCodec.encode(compressed.scene) == SceneCodec.encode(plain.scene))
    #expect(compressed.textElements == plain.textElements)
    let written = try compressed.serialized()
    #expect(written.contains("%%\n# Excalidraw Data\n\n## Text Elements\nPlan ^Tx1a2b3c\n\n"))
    #expect(written.contains("## Drawing\n```json\n{\n\t\"type\": \"excalidraw\""))
    #expect(!written.contains("compressed-json"))
    let reread = ExcalidrawMarkdown.parse(written)
    #expect(SceneCodec.encode(reread.scene) == SceneCodec.encode(plain.scene))
    #expect(try reread.serialized() == written)
    // And back to compressed, on request.
    let recompressed = try reread.serialized(compressed: true)
    #expect(recompressed.contains("```compressed-json\n"))
    #expect(
      SceneCodec.encode(ExcalidrawMarkdown.parse(recompressed).scene)
        == SceneCodec.encode(plain.scene))
  }

  @Test func fillsInThePluginsBlankTemplate() throws {
    let document = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-blank.excalidraw.md"))
    #expect(document.readable)
    #expect(document.scene.elements.isEmpty)
    let written = try document.serialized()
    #expect(
      written.contains(
        "'Saving'\n\n\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n```json\n"))
  }

  @Test func newFilesFollowTheSpecLayout() throws {
    var scene = ExcalidrawScene()
    var text = ExcalidrawElement(id: "t1abcdef", type: .text)
    text.text = TextProperties(text: "Hi there")
    scene.elements = [text]
    let written = ExcalidrawMarkdown.newFile(for: scene)
    #expect(
      written.hasPrefix(
        "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==⚠  Switch to EXCALIDRAW VIEW"
      ))
    #expect(
      written.contains(
        "'Saving'\n\n# Excalidraw Data\n\n## Text Elements\nHi there ^t1abcdef\n\n%%\n## Drawing\n```json\n{\n\t\"type\": \"excalidraw\",\n\t\"version\": 2,\n\t\"source\": \"https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.27.3\",\n\t\"elements\": ["
      ))
    #expect(written.hasSuffix("\n```\n%%\n"))
    let reread = ExcalidrawMarkdown.parse(written)
    #expect(SceneCodec.encode(reread.scene) == SceneCodec.encode(scene))
    #expect(try reread.serialized() == written)
  }

  @Test func textElementsAreRegeneratedFromTheSceneInOrder() throws {
    var document = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-json.excalidraw.md"))
    let index = try #require(document.scene.elements.firstIndex { $0.id == "Tx4d5e6f" })
    document.scene.elements[index].text?.originalText = "Edited on the Mac"
    document.scene.elements[index].text?.text = "Edited on the Mac"
    var added = ExcalidrawElement(id: "NewText1", type: .text)
    added.text = TextProperties(text: "Brand new")
    document.scene.elements.append(added)
    let removed = try #require(document.scene.elements.firstIndex { $0.id == "Tx1a2b3c" })
    document.scene.elements[removed].isDeleted = true
    let written = try document.serialized()
    #expect(
      written.contains(
        "## Text Elements\nEdited on the Mac ^Tx4d5e6f\n\nBrand new ^NewText1\n\n## Element Links\n"
      ))
  }

  @Test func anEditedTextElementsSectionWinsLikeInThePlugin() throws {
    let text = try Fixtures.text("plugin-json.excalidraw.md").replacingOccurrences(
      of: "Hello, drawings!\nSecond line ^Tx4d5e6f",
      with: "Hello, [[drawings]]!\nSecond line ^Tx4d5e6f")
    let document = ExcalidrawMarkdown.parse(text)
    let element = try #require(document.scene.element(id: "Tx4d5e6f"))
    #expect(element.text?.originalText == "Hello, [[drawings]]!\nSecond line")
    #expect(element.text?.text == "Hello, [[drawings]]!\nSecond line")
    let written = try document.serialized()
    #expect(written.contains("Hello, [[drawings]]!\nSecond line ^Tx4d5e6f"))
    #expect(written.contains("\"originalText\": \"Hello, [[drawings]]!\\nSecond line\""))
  }

  @Test func rawTextFollowsAnEditedText() throws {
    var document = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-json.excalidraw.md"))
    let index = try #require(document.scene.elements.firstIndex { $0.id == "Tx1a2b3c" })
    document.scene.elements[index].text?.originalText = "Launch"
    document.scene.elements[index].text?.text = "Launch"
    let written = try document.serialized()
    #expect(written.contains("## Text Elements\nLaunch ^Tx1a2b3c\n\n"))
    #expect(written.contains("\"rawText\": \"Launch\""))
  }

  @Test func crlfAndByteOrderMarksAreRead() throws {
    let text =
      "\u{FEFF}"
      + (try Fixtures.text("plugin-json.excalidraw.md")).replacingOccurrences(
        of: "\n", with: "\r\n")
    let document = ExcalidrawMarkdown.parse(text)
    #expect(document.readable)
    #expect(document.scene.elements.count == 12)
  }

  @Test func problemsAreReportedAndUnreadableFilesArentOverwritten() {
    let missing = ExcalidrawMarkdown.parse("# Just a note\n")
    #expect(!missing.readable)
    #expect(missing.problems.map(\.code) == [.noDrawing])
    #expect(throws: DrawingUnreadableError.self) { try missing.serialized() }
    let broken = ExcalidrawMarkdown.parse("x\n## Drawing\n```compressed-json\n###\n```\n%%")
    #expect(broken.problems.map(\.code) == [.decompressFailed])
    let notAScene = ExcalidrawMarkdown.parse("x\n## Drawing\n```json\n{\"type\": 1}\n```\n%%")
    #expect(notAScene.problems.map(\.code) == [.notAScene])
    let unclosed = ExcalidrawMarkdown.parse(
      "x\n## Drawing\n```json\n{\"elements\": [{\"id\": \"a\", \"type\": \"line\"}, 3]}\n%%\n")
    #expect(unclosed.readable)
    #expect(unclosed.problems.map(\.code) == [.unclosedFence, .invalidElement])
    #expect(unclosed.scene.elements.map(\.id) == ["a"])
  }

  @Test(
    arguments: [
      (
        "Drawing 1.excalidraw|360|right-wrap", "Drawing 1.excalidraw", 360.0, nil,
        DrawingEmbed.Placement.rightWrap, nil
      ),
      (
        "Excalidraw/Plan.excalidraw.md|200x120|left-wrap", "Excalidraw/Plan.excalidraw.md", 200,
        120, .leftWrap, nil
      ),
      ("Plan.excalidraw", "Plan.excalidraw", nil, nil, .full, nil),
      ("Plan.excalidraw|center", "Plan.excalidraw", nil, nil, .center, nil),
      ("Plan.excalidraw|My plan|300", "Plan.excalidraw", 300, nil, .full, "My plan"),
    ] as [(String, String, Double?, Double?, DrawingEmbed.Placement, String?)])
  func parsesEmbeds(
    inner: String, target: String, width: Double?, height: Double?,
    placement: DrawingEmbed.Placement,
    alias: String?
  ) throws {
    let embed = try #require(DrawingEmbed.parse(inner: inner))
    #expect(embed.target == target)
    #expect(embed.width == width)
    #expect(embed.height == height)
    #expect(embed.placement == placement)
    #expect(embed.alias == alias)
    #expect(DrawingEmbed.parse(line: embed.markdown) == embed)
  }

  @Test func findsEmbedsInANote() {
    let note =
      "Intro\n![[Plan.excalidraw|360|right-wrap]]\nText ![[photo.png|200]] and ![[Other.excalidraw.md]]"
    let embeds = DrawingEmbed.find(in: note)
    #expect(embeds.map(\.target) == ["Plan.excalidraw", "Other.excalidraw.md"])
    #expect(embeds[0].range == NSRange(location: 6, length: 35))
    #expect(DrawingEmbed.parse(line: "![[photo.png|300]]") == nil)
    #expect(DrawingEmbed.parse(line: "[[Plan.excalidraw]]") == nil)
    #expect(
      DrawingEmbed.parse(inner: "Plan.excalidraw|050")?.style == "050", "a size can't start with 0")
    #expect(DrawingEmbed.parse(inner: "Plan.excalidraw|50%x200")?.widthPercent == 50)
  }

  @Test func newEmbedsAndFileNames() throws {
    let embed = DrawingEmbed.newDrawing(target: "Drawing 2026-09-25 11.52.33.excalidraw")
    #expect(embed.markdown == "![[Drawing 2026-09-25 11.52.33.excalidraw|360|right-wrap]]")
    #expect(embed.name == "Drawing 2026-09-25 11.52.33")
    let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    let components = DateComponents(
      calendar: Calendar(identifier: .gregorian), timeZone: zone, year: 2026, month: 9, day: 25,
      hour: 11, minute: 52, second: 33)
    let date = try #require(components.date)
    #expect(
      DrawingFileName.path(at: date, timeZone: zone)
        == "Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md")
    #expect(
      DrawingFileName.path(forName: "Plan: v2 / final.excalidraw.md")
        == "Excalidraw/Plan v2 final.excalidraw.md")
    let taken: Set<String> = ["Excalidraw/Plan.excalidraw.md", "Excalidraw/Plan_0.excalidraw.md"]
    #expect(
      DrawingFileName.uniquePath(forName: "Plan") { taken.contains($0) }
        == "Excalidraw/Plan_1.excalidraw.md")
    #expect(DrawingFileName.title(fromPath: "Excalidraw/Plan.excalidraw.md") == "Plan")
    #expect(DrawingFileName.isDrawingPath("A/B.Excalidraw.md"))
  }
}
