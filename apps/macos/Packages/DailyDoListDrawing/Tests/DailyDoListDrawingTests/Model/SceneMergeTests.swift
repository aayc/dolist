import DailyDoListDrawingModel
import Testing

@testable import DailyDoListDrawing

@Suite("Scene merge: two versions of a drawing, element by element")
struct SceneMergeTests {
  static func element(
    _ id: String, x: Double = 0, version: Int = 1, nonce: Int = 0, index: String? = nil,
    deleted: Bool = false
  ) -> ExcalidrawElement {
    TestScenes.element(.rectangle, id: id, x: x, y: 0) {
      $0.version = version
      $0.versionNonce = nonce
      $0.index = index
      $0.isDeleted = deleted
    }
  }

  static func ids(_ scene: ExcalidrawScene) -> [String] { scene.elements.map(\.id) }

  @Test func keepsWhatEachSideAdded() {
    let base = ExcalidrawScene(elements: [Self.element("a")])
    let local = ExcalidrawScene(elements: [Self.element("a"), Self.element("mine")])
    let remote = ExcalidrawScene(elements: [Self.element("a"), Self.element("theirs")])
    let merged = SceneMerge.merge(base: base, local: local, remote: remote)
    #expect(Set(Self.ids(merged)) == ["a", "mine", "theirs"])
  }

  @Test func theNewerVersionOfAnElementWins() {
    let base = ExcalidrawScene(elements: [Self.element("a"), Self.element("b")])
    let local = ExcalidrawScene(elements: [
      Self.element("a", x: 50, version: 3), Self.element("b"),
    ])
    let remote = ExcalidrawScene(elements: [
      Self.element("a", x: 10, version: 2), Self.element("b", x: 80, version: 2),
    ])
    let merged = SceneMerge.merge(base: base, local: local, remote: remote)
    #expect(merged.element(id: "a")?.x == 50, "ours is newer")
    #expect(merged.element(id: "b")?.x == 80, "theirs is newer")
  }

  @Test func theSameVersionGoesToTheLowerNonceAndOursOnATie() {
    let local = ExcalidrawScene(elements: [Self.element("a", x: 1, version: 2, nonce: 9)])
    let remote = ExcalidrawScene(elements: [Self.element("a", x: 2, version: 2, nonce: 4)])
    #expect(SceneMerge.merge(base: nil, local: local, remote: remote).element(id: "a")?.x == 2)
    let tie = ExcalidrawScene(elements: [Self.element("a", x: 3, version: 2, nonce: 4)])
    #expect(SceneMerge.merge(base: nil, local: tie, remote: remote).element(id: "a")?.x == 3)
  }

  @Test func deletionsWinAsTombstonesAndAsRemovals() {
    let base = ExcalidrawScene(elements: [Self.element("a"), Self.element("b"), Self.element("c")])
    // We deleted a (tombstone); they removed b from the file (as Excalidraw saves).
    let local = ExcalidrawScene(elements: [
      Self.element("a", version: 2, deleted: true), Self.element("b"), Self.element("c"),
    ])
    let remote = ExcalidrawScene(elements: [Self.element("a"), Self.element("c")])
    let merged = SceneMerge.merge(base: base, local: local, remote: remote)
    #expect(merged.element(id: "a")?.isDeleted == true)
    #expect(merged.element(id: "b") == nil)
    #expect(merged.element(id: "c") != nil)
  }

  @Test func anElementWeChangedSurvivesTheirRemovingIt() {
    let base = ExcalidrawScene(elements: [Self.element("a")])
    let local = ExcalidrawScene(elements: [Self.element("a", x: 40, version: 2)])
    let remote = ExcalidrawScene(elements: [])
    #expect(SceneMerge.merge(base: base, local: local, remote: remote).element(id: "a")?.x == 40)
  }

  @Test func ordersByFractionalIndexOrByTheirOrderWithOursAfterTheirPredecessor() {
    let indexed = SceneMerge.merge(
      base: nil,
      local: ExcalidrawScene(elements: [
        Self.element("a", index: "a0"), Self.element("mine", index: "a1"),
      ]),
      remote: ExcalidrawScene(elements: [
        Self.element("a", index: "a0"), Self.element("theirs", index: "a0V"),
      ]))
    #expect(Self.ids(indexed) == ["a", "theirs", "mine"])
    let unindexed = SceneMerge.merge(
      base: nil,
      local: ExcalidrawScene(elements: [Self.element("a"), Self.element("mine"), Self.element("b")]
      ),
      remote: ExcalidrawScene(elements: [Self.element("a"), Self.element("b"), Self.element("c")]))
    #expect(Self.ids(unindexed) == ["a", "mine", "b", "c"])
  }

  @Test func takesTheirSceneFieldsAndBothSidesFiles() {
    var local = ExcalidrawScene(elements: [])
    local.files = .object(JSONObject([("mine", .string("data:1"))]))
    var remote = ExcalidrawScene(
      elements: [], appState: JSONObject([("viewBackgroundColor", .string("#fff9db"))]))
    remote.files = .object(JSONObject([("theirs", .string("data:2"))]))
    let merged = SceneMerge.merge(base: nil, local: local, remote: remote)
    #expect(merged.viewBackgroundColor == "#fff9db")
    #expect(merged.files.objectValue?.keys == ["theirs", "mine"])
  }
}
