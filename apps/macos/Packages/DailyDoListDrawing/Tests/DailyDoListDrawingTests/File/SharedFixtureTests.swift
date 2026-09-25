import DailyDoListDrawingModel
import Foundation
import Testing

/// The drawing fixtures shared with `@ddl/core` (`packages/core/test/drawings/`, see its
/// README): every fixture is parsed, described and written back, and must give what the
/// TypeScript reference gave, byte for byte. `DRAWING_FIXTURES_DIR` points elsewhere (a checkout
/// of another branch's fixtures); without either, the suite has nothing to replay.
@Suite("Shared drawing fixtures")
struct SharedFixtureTests {
  static let directory: URL? = {
    if let override = ProcessInfo.processInfo.environment["DRAWING_FIXTURES_DIR"] {
      return URL(fileURLWithPath: override, isDirectory: true)
    }
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 { url.deleteLastPathComponent() }  // File, Tests…, apps → the repository
    let shared = url.appendingPathComponent(
      "packages/core/test/drawings/fixtures", isDirectory: true)
    return FileManager.default.fileExists(atPath: shared.path) ? shared : nil
  }()

  static let names: [String] = {
    guard let directory,
      let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
    else { return [] }
    return files.filter {
      $0.hasSuffix(".excalidraw.md") && !$0.hasSuffix(".roundtrip.excalidraw.md")
    }
    .map { String($0.dropLast(".excalidraw.md".count)) }.sorted()
  }()

  static func text(_ file: String) throws -> String {
    try String(contentsOf: directory!.appendingPathComponent(file), encoding: .utf8)
  }

  @Test(.enabled(if: directory != nil, "the shared fixtures aren't in this checkout"))
  func fixturesAreThere() {
    #expect(Self.names.count >= 10)
  }

  @Test(
    .enabled(if: directory != nil, "the shared fixtures aren't in this checkout"), arguments: names)
  func replays(_ name: String) throws {
    let input = try Self.text("\(name).excalidraw.md")
    let expected = try #require(JSONParser.parse(Self.text("\(name).expected.json")).objectValue)
    let summary = try #require(expected["parse"]?.objectValue)
    let parsed = ExcalidrawMarkdown.parse(input)

    // 1. Parse.
    #expect(parsed.readable == summary["readable"]?.boolValue)
    #expect(parsed.compressed == summary["compressed"]?.boolValue)
    let problems = (summary["problems"]?.arrayValue ?? []).compactMap(\.objectValue).map {
      "\($0["code"]?.stringValue ?? "") \($0["severity"]?.stringValue ?? "")"
    }
    #expect(parsed.problems.map { "\($0.code.rawValue) \($0.severity.rawValue)" } == problems)
    let frontmatter = Dictionary(
      (summary["frontmatter"]?.objectValue ?? JSONObject()).map {
        ($0.key, $0.value.stringValue ?? "")
      },
      uniquingKeysWith: { $1 })
    #expect(
      Dictionary(parsed.frontmatter.entries.map { ($0.key, $0.value) }, uniquingKeysWith: { $1 })
        == frontmatter)
    #expect(
      parsed.sections.map(\.heading)
        == (summary["sections"]?.arrayValue ?? []).compactMap(\.stringValue))
    let entries = (summary["textElements"]?.arrayValue ?? []).compactMap(\.objectValue).map {
      TextElementEntry(id: $0["id"]?.stringValue ?? "", text: $0["text"]?.stringValue ?? "")
    }
    #expect(parsed.textElements == entries)
    let elements = (summary["elements"]?.arrayValue ?? []).compactMap(\.objectValue).map {
      "\($0["id"]?.stringValue ?? "") \($0["type"]?.stringValue ?? "")\($0["isDeleted"]?.boolValue == true ? " deleted" : "")"
    }
    #expect(
      parsed.scene.elements.map { "\($0.id) \($0.type.rawValue)\($0.isDeleted ? " deleted" : "")" }
        == elements)
    let texts = (summary["texts"]?.arrayValue ?? []).compactMap(\.objectValue).map {
      "\($0["id"]?.stringValue ?? ""): \($0["text"]?.stringValue ?? "")"
    }
    #expect(
      parsed.scene.elements.filter { $0.type == .text && !$0.isDeleted }.map {
        "\($0.id): \($0.text?.text ?? "")"
      }
        == texts)
    let files = (summary["files"]?.arrayValue ?? []).compactMap(\.stringValue)
    #expect((parsed.scene.files.objectValue?.keys ?? []) == files)

    // 2. Describe.
    let title = try #require(expected["title"]?.stringValue)
    #expect(
      DrawingDescription.describe(parsed.scene, title: title)
        == expected["description"]?.stringValue)

    // 3. Write it back.
    guard let roundTripName = expected["roundTrip"]?.stringValue else {
      #expect(throws: DrawingUnreadableError.self) { try parsed.serialized() }
      return
    }
    let written = try parsed.serialized()
    let roundTrip = try Self.text(roundTripName)
    #expect(written == roundTrip, "writing \(name) back")
    if written != roundTrip { Self.showDifference(written, roundTrip) }

    // 4. The round trip is stable and holds the same scene.
    let reparsed = ExcalidrawMarkdown.parse(roundTrip)
    #expect(try reparsed.serialized() == roundTrip)
    #expect(Self.sameJSON(reparsed.scene, parsed.scene))

    // 5. Same scene as another fixture.
    if let other = expected["sameSceneAs"]?.stringValue {
      let otherParsed = ExcalidrawMarkdown.parse(try Self.text(other))
      #expect(Self.sameJSON(parsed.scene, otherParsed.scene))
    }
  }

  /// Scenes equal as JSON values (key order aside).
  static func sameJSON(_ a: ExcalidrawScene, _ b: ExcalidrawScene) -> Bool {
    unordered(.object(SceneCodec.encodeObject(a))) == unordered(.object(SceneCodec.encodeObject(b)))
  }

  indirect enum Unordered: Equatable {
    case value(JSONValue)
    case array([Unordered])
    case object([String: Unordered])
  }

  static func unordered(_ value: JSONValue) -> Unordered {
    switch value {
    case .array(let items): .array(items.map(unordered))
    case .object(let object):
      .object(Dictionary(object.map { ($0.key, unordered($0.value)) }, uniquingKeysWith: { $1 }))
    default: .value(value)
    }
  }

  static func showDifference(_ a: String, _ b: String) {
    let left = Array(a)
    let right = Array(b)
    let common = zip(left, right).prefix { $0 == $1 }.count
    let start = max(0, common - 80)
    print("first difference at \(common):")
    print("written:  \(String(left[start..<min(left.count, common + 80)]).debugDescription)")
    print("expected: \(String(right[start..<min(right.count, common + 80)]).debugDescription)")
  }
}
