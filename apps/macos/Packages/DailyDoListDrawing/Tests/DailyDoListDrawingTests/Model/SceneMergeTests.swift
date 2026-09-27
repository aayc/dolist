import DailyDoListDrawingModel
import Testing

@testable import DailyDoListDrawing
@testable import DailyDoListDrawingCore

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

  @Test func takesTheirSceneFieldsAndBothSidesFiles() throws {
    var local = ExcalidrawScene(elements: [])
    local.files = .object(JSONObject([("mine", .string("data:1"))]))
    var remote = try SceneCodec.decode(
      ##"{"type":"excalidraw","version":2,"elements":[],"appState":{"viewBackgroundColor":"#fff9db"},"files":{},"futureTopLevel":{"revision":2}}"##
    )
    remote.files = .object(JSONObject([("theirs", .string("data:2"))]))
    let merged = SceneMerge.merge(base: nil, local: local, remote: remote)
    #expect(merged.viewBackgroundColor == "#fff9db")
    #expect(merged.files.objectValue?.keys == ["theirs", "mine"])
    #expect(
      SceneCodec.encodeObject(merged)["futureTopLevel"]
        == SceneCodec.encodeObject(remote)["futureTopLevel"])
  }

  @Test func keepsOfflineBackgroundAndGridWithDisjointRemoteSettings() {
    var base = ExcalidrawScene()
    base.appState["theme"] = .string("light")
    base.appState["custom"] = .object(
      JSONObject([("a", .number(1)), ("b", .array([.bool(true), .null]))]))
    var local = base
    local.appState["viewBackgroundColor"] = .string("#fff9db")
    local.appState["gridSize"] = .number(20)
    local.appState["custom"] = .object(JSONObject([("offline", .bool(true))]))
    var remote = base
    remote.appState["theme"] = .string("dark")
    remote.appState["custom"] = .object(
      JSONObject([("b", .array([.bool(true), .null])), ("a", .number(1))]))
    remote.appState["remoteOnly"] = .number(7)
    let merged = SceneMerge.merge(base: base, local: local, remote: remote)
    #expect(merged.viewBackgroundColor == "#fff9db")
    #expect(merged.appState["gridSize"] == .number(20))
    #expect(merged.appState["theme"] == .string("dark"))
    #expect(merged.appState["custom"] == local.appState["custom"])
    #expect(merged.appState["remoteOnly"] == .number(7))
    #expect(SceneMerge.merge(base: base, local: local, remote: base).appState == local.appState)
  }

  @Test func remoteSettingsWinConflictsAndDeletionIsDifferentFromNull() {
    let base = ExcalidrawScene(
      appState: JSONObject([
        ("viewBackgroundColor", .string("#ffffff")), ("gridSize", .number(20)),
        ("localRemoved", .bool(true)), ("remoteRemoved", .bool(true)), ("nullValue", .null),
      ]))
    let local = ExcalidrawScene(
      appState: JSONObject([
        ("viewBackgroundColor", .string("#fff9db")), ("gridSize", .number(30)),
        ("remoteRemoved", .bool(false)), ("nullValue", .null),
      ]))
    let remote = ExcalidrawScene(
      appState: JSONObject([
        ("viewBackgroundColor", .string("#000000")), ("gridSize", .null),
        ("localRemoved", .bool(true)), ("nullValue", .null),
      ]))
    let merged = SceneMerge.merge(base: base, local: local, remote: remote)
    #expect(merged.viewBackgroundColor == "#000000")
    #expect(merged.appState["gridSize"] == .null)
    #expect(!merged.appState.contains("localRemoved"))
    #expect(!merged.appState.contains("remoteRemoved"))
    #expect(merged.appState["nullValue"] == .null)
    let freshLocal = ExcalidrawScene(
      appState: JSONObject([("gridSize", .number(20)), ("localOnly", .bool(true))]))
    let freshRemote = ExcalidrawScene(appState: JSONObject([("gridSize", .number(30))]))
    let fresh = SceneMerge.merge(base: nil, local: freshLocal, remote: freshRemote)
    #expect(fresh.appState["gridSize"] == .number(30))
    #expect(fresh.appState["localOnly"] == .bool(true))
  }
}
