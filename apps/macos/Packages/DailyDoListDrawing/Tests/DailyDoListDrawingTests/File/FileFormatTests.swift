import DailyDoListDrawingModel
import Foundation
import Testing

@Suite("File format")
struct FileFormatTests {
  @Test func readsThePluginsJSONLayout() throws {
    let document = try ExcalidrawMarkdown.parse(Fixtures.text("plugin-json.excalidraw.md"))
    #expect(document.encoding == .json)
    #expect(!document.dataCommentedOut)
    #expect(document.header.hasPrefix("---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n"))
    #expect(document.header.hasSuffix("'Saving'\n\n\n"))
    #expect(
      document.textElements == [
        TextElementEntry(id: "Tx1a2b3c", text: "Plan"),
        TextElementEntry(id: "Tx4d5e6f", text: "Hello, drawings!\nSecond line"),
      ])
    #expect(document.otherSections.hasPrefix("## Element Links\nRc1a2b3c: [[Project plan]]\n"))
    #expect(document.otherSections.contains("## Embedded Files\n"))
    #expect(document.scene.elements.count == 12)
    #expect(document.trailer == "%%")
  }

  @Test func writesThePluginsJSONLayoutBackByteForByte() throws {
    let text = try Fixtures.text("plugin-json.excalidraw.md")
    #expect(try ExcalidrawMarkdown.parse(text).serialized() == text)
  }

  @Test func readsCompressedJSONAndWritesItUncompressed() throws {
    let compressed = try ExcalidrawMarkdown.parse(Fixtures.text("plugin-compressed.excalidraw.md"))
    let plain = try ExcalidrawMarkdown.parse(Fixtures.text("plugin-json.excalidraw.md"))
    #expect(compressed.encoding == .compressedJSON)
    #expect(compressed.dataCommentedOut)
    #expect(compressed.scene == plain.scene)
    #expect(compressed.textElements == plain.textElements)
    #expect(compressed.otherSections == plain.otherSections)
    let written = compressed.serialized()
    #expect(written.contains("%%\n# Excalidraw Data\n\n## Text Elements\nPlan ^Tx1a2b3c\n\n"))
    #expect(written.contains("## Drawing\n```json\n{\n\t\"type\": \"excalidraw\""))
    #expect(!written.contains("compressed-json"))
    let reread = try ExcalidrawMarkdown.parse(written)
    #expect(reread.scene == plain.scene)
    #expect(reread.serialized() == written)
  }

  @Test func readsThePluginsBlankTemplate() throws {
    let document = try ExcalidrawMarkdown.parse(Fixtures.text("plugin-blank.excalidraw.md"))
    #expect(document.scene.elements.isEmpty)
    #expect(document.header == ExcalidrawMarkdown.defaultHeader)
    let written = document.serialized()
    #expect(
      written.hasPrefix(
        ExcalidrawMarkdown.defaultHeader
          + "# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n```json\n"))
  }

  @Test func newDrawingsFollowTheSpecLayout() throws {
    var scene = ExcalidrawScene()
    var text = ExcalidrawElement(id: "t1", type: .text)
    text.text = TextProperties(text: "Hi there")
    scene.elements = [text]
    let written = ExcalidrawMarkdown(scene: scene).serialized()
    #expect(
      written.hasPrefix(
        "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==⚠  Switch to EXCALIDRAW VIEW"
      ))
    #expect(
      written.contains(
        "\n\n\n# Excalidraw Data\n\n## Text Elements\nHi there ^t1\n\n%%\n## Drawing\n```json\n{\n\t\"type\": \"excalidraw\",\n\t\"version\": 2,\n\t\"source\": \"daily-do-list\",\n\t\"elements\": ["
      ))
    #expect(written.hasSuffix("\n```\n%%\n"))
    let reread = try ExcalidrawMarkdown.parse(written)
    #expect(SceneCodec.encode(reread.scene) == SceneCodec.encode(scene))
    #expect(reread.serialized() == written)
  }

  @Test func textElementsAreRegeneratedFromTheScene() throws {
    var document = try ExcalidrawMarkdown.parse(Fixtures.text("plugin-json.excalidraw.md"))
    let index = try #require(document.scene.elements.firstIndex { $0.id == "Tx4d5e6f" })
    document.scene.elements[index].text?.originalText = "Edited on the Mac"
    document.scene.elements[index].text?.text = "Edited on the Mac"
    document.scene.elements[index].version += 1
    var added = ExcalidrawElement(id: "NewText01", type: .text)
    added.text = TextProperties(text: "Brand new")
    document.scene.elements.append(added)
    let removed = try #require(document.scene.elements.firstIndex { $0.id == "Tx1a2b3c" })
    document.scene.elements[removed].isDeleted = true
    #expect(
      document.regeneratedTextElements() == [
        TextElementEntry(id: "Tx4d5e6f", text: "Edited on the Mac"),
        TextElementEntry(id: "NewText01", text: "Brand new"),
      ])
  }

  @Test func rawTextOfTheFileSurvivesWhileTheElementIsUnchanged() throws {
    let text = try Fixtures.text("plugin-json.excalidraw.md").replacingOccurrences(
      of: "Hello, drawings!\nSecond line ^Tx4d5e6f",
      with: "Hello, [[drawings]]!\nSecond line ^Tx4d5e6f")
    let document = try ExcalidrawMarkdown.parse(text)
    #expect(document.regeneratedTextElements()[1].text == "Hello, [[drawings]]!\nSecond line")
    #expect(document.serialized() == text)
  }

  @Test func crlfFilesAreRead() throws {
    let text = try Fixtures.text("plugin-json.excalidraw.md").replacingOccurrences(
      of: "\n", with: "\r\n")
    #expect(try ExcalidrawMarkdown.parse(text).scene.elements.count == 12)
  }

  @Test func missingOrBrokenDrawingsThrow() {
    #expect(throws: DrawingFileError.missingDrawing) {
      try ExcalidrawMarkdown.parse("# Just a note\n")
    }
    #expect(throws: DrawingFileError.undecompressable) {
      try ExcalidrawMarkdown.parse("x\n## Drawing\n```compressed-json\n\n```\n%%")
    }
    #expect(throws: DrawingFileError.self) {
      try ExcalidrawMarkdown.parse("x\n## Drawing\n```json\n{\"type\": 1}\n```\n%%")
    }
  }

  @Test(
    arguments: [
      (
        "![[Drawing 1.excalidraw|360|right-wrap]]", "Drawing 1.excalidraw", 360.0, nil,
        DrawingEmbed.Placement.rightWrap
      ),
      (
        "![[Excalidraw/Plan.excalidraw.md|left-wrap|200x120]]", "Excalidraw/Plan.excalidraw.md",
        200, 120, .leftWrap
      ),
      ("  ![[Plan.excalidraw]]  ", "Plan.excalidraw", nil, nil, nil),
      ("![[Plan.excalidraw|center]]", "Plan.excalidraw", nil, nil, .center),
    ] as [(String, String, Double?, Double?, DrawingEmbed.Placement?)])
  func parsesEmbeds(
    line: String, target: String, width: Double?, height: Double?,
    placement: DrawingEmbed.Placement?
  ) throws {
    let embed = try #require(DrawingEmbed.parse(line: line))
    #expect(embed.target == target)
    #expect(embed.width == width)
    #expect(embed.height == height)
    #expect(embed.placement == placement)
    #expect(DrawingEmbed.parse(line: embed.markdown) == embed)
  }

  @Test func embedsOfOtherFilesArentDrawings() {
    #expect(DrawingEmbed.parse(line: "![[photo.png|300]]") == nil)
    #expect(DrawingEmbed.parse(line: "text ![[Plan.excalidraw]]") == nil)
    #expect(DrawingEmbed.parse(line: "[[Plan.excalidraw]]") == nil)
  }

  @Test func newEmbedsAndFileNames() throws {
    let embed = DrawingEmbed.newDrawing(target: "Drawing 2026-09-25 11.52.33.excalidraw")
    #expect(embed.markdown == "![[Drawing 2026-09-25 11.52.33.excalidraw|360|right-wrap]]")
    #expect(embed.name == "Drawing 2026-09-25 11.52.33")
    let components = DateComponents(
      calendar: Calendar(identifier: .gregorian),
      timeZone: TimeZone(identifier: "America/Los_Angeles"),
      year: 2026, month: 9, day: 25, hour: 11, minute: 52, second: 33)
    let date = try #require(components.date)
    let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    #expect(
      DrawingFileName.path(at: date, timeZone: zone)
        == "Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md")
  }
}
