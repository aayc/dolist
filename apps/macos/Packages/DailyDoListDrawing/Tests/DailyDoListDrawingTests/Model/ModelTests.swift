import DailyDoListDrawingModel
import Foundation
import Testing

@Suite("Model")
struct ModelTests {
  @Test func bumpingAVersionLooksLikeExcalidrawsMutation() {
    let environment = DeterministicDrawingEnvironment(now: 1_000)
    var element = ExcalidrawElement(id: "a", type: .rectangle)
    element.version = 4
    element.versionNonce = 7
    element.bumpVersion(in: environment)
    #expect(element.version == 5)
    #expect(element.versionNonce != 7)
    #expect((0..<(1 << 31)).contains(element.versionNonce))
    #expect(element.updated == 1_000)
  }

  @Test func idsAreThePluginsEightCharacters() {
    let id = SystemDrawingEnvironment().randomId()
    #expect(id.count == 8)
    #expect(id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) })
  }

  @Test(
    arguments: [
      (nil, nil, "a0"), ("a0", nil, "a1"), ("a1", nil, "a2"), ("az", nil, "b00"),
      (nil, "a0", "Zz"), ("a0", "a1", "a0V"), ("a0V", "a1", "a0l"), ("Zz", "a0", "ZzV"),
      ("a1", "a2", "a1V"), ("b00", nil, "b01"),
    ] as [(String?, String?, String)])
  func fractionalIndicesMatchTheJavaScriptLibrary(a: String?, b: String?, expected: String) {
    #expect(FractionalIndex.key(between: a, and: b) == expected)
  }

  @Test func invalidFractionalIndexNeighborsGiveNil() {
    #expect(FractionalIndex.key(between: "a1", and: "a0") == nil)
    #expect(FractionalIndex.key(between: "a10", and: nil) == nil, "trailing zero")
    #expect(FractionalIndex.key(between: "?", and: nil) == nil)
    #expect(FractionalIndex.isValid("a0"))
    #expect(!FractionalIndex.isValid(""))
  }

  @Test func rectsAndPoints() {
    let rect = DrawingRect(x: 10, y: 20, width: -5, height: 30)
    #expect(rect.minX == 5 && rect.maxX == 10)
    #expect(rect.contains(DrawingPoint(7, 30)))
    let rotated = DrawingPoint(10, 0).rotated(around: .zero, by: .pi / 2)
    #expect(abs(rotated.x) < 1e-9 && abs(rotated.y - 10) < 1e-9)
  }

  @Test func contentHashIsStableAndSensitive() throws {
    let scene = try SceneCodec.decode(Fixtures.text("scene-plugin.excalidraw"))
    var changed = scene
    changed.elements[0].x += 1
    #expect(DrawingContentHash.hash(scene) == DrawingContentHash.hash(scene))
    #expect(DrawingContentHash.hash(scene) != DrawingContentHash.hash(changed))
  }
}
