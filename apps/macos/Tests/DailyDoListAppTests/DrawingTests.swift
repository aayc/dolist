import AppKit
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListDomain
import DailyDoListDrawing
import DailyDoListEditor
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// Synthetic drawing files.
enum DrawingFiles {
  static func element(_ id: String, x: Double = 0, version: Int = 1) -> ExcalidrawElement {
    var element = ExcalidrawElement(id: id, type: .rectangle)
    element.x = x
    element.y = 0
    element.width = 80
    element.height = 60
    element.seed = 7
    element.version = version
    return element
  }

  static func file(_ ids: [String], extra: String = "") -> String {
    let scene = ExcalidrawScene(elements: ids.map { element($0) })
    return ExcalidrawMarkdown.newFile(for: scene) + extra
  }

  static func ids(_ scene: ExcalidrawScene?) -> Set<String> {
    Set(scene?.visibleElements.map(\.id) ?? [])
  }

  static func ids(inFile content: String) -> Set<String> {
    ids(ExcalidrawMarkdown.parse(content).scene)
  }
}

@MainActor
@Suite("Drawing store: reads, debounced saves, merges")
struct DrawingStoreTests {
  static let path = "Excalidraw/Plan.excalidraw.md"
  let client = FakeDaemonClient(notes: [
    Self.path: DrawingFiles.file(["a"], extra: "\n## Unknown section\nkept as is\n")
  ])
  let scheduler = ManualScheduler()
  let store: DrawingStore
  var changes = 0

  init() {
    store = DrawingStore(client: client, scheduler: scheduler)
    store.resolve = { target in
      WikiLinks.resolve(NotePaths.wikiLinkTarget(target), in: [Self.path, "Ideas.md"])
    }
  }

  @Test func readsADrawingOnceAndShowsItsScene() async throws {
    var changed = 0
    store.onChange = { changed += 1 }
    #expect(store.state(forTarget: "Plan.excalidraw") == .loading)
    #expect(store.state(forTarget: "Plan.excalidraw") == .loading)
    try await eventually { store.has(Self.path) }
    scheduler.advance(by: 0)
    #expect(changed == 1)
    let drawing = try #require(store.state(forTarget: "Plan.excalidraw").drawing)
    #expect(drawing.path == Self.path)
    #expect(DrawingFiles.ids(drawing.scene) == ["a"])
    #expect(client.calls("readNote") == ["readNote:\(Self.path)"])
    #expect(store.state(forTarget: "Missing.excalidraw") == .missing)
  }

  @Test func editsSaveDebouncedWithTheVersionTheyWereReadAt() async throws {
    await store.load(Self.path).value
    let version = try #require(store.version(Self.path))
    var scene = try #require(store.scene(Self.path))
    scene.elements.append(DrawingFiles.element("b", x: 120))
    store.edit(Self.path, scene: scene)
    #expect(store.state(forPath: Self.path).drawing?.contentHash == DrawingContentHash.hash(scene))
    scheduler.advance(by: 0.3)
    #expect(client.writes.isEmpty, "saves are debounced")
    scheduler.advance(by: 0.3)
    try await eventually { !store.isDirty(Self.path) }
    let write = try #require(client.writes.last)
    #expect(write.base == .match(version))
    #expect(DrawingFiles.ids(inFile: write.content) == ["a", "b"])
    #expect(
      write.content.contains("## Unknown section\nkept as is"), "the file around the scene stays")
    #expect(store.version(Self.path) == client.note(Self.path)?.version)
  }

  @Test func aConflictMergesBothSidesElementByElementAndSavesOnTopOfTheirs() async throws {
    var changed = 0
    store.onChange = { changed += 1 }
    await store.load(Self.path).value
    var scene = try #require(store.scene(Self.path))
    scene.elements.append(DrawingFiles.element("mine", x: 200))
    store.edit(Self.path, scene: scene)
    // Someone else (the web app) saved in the meantime.
    let theirs = client.setNote(Self.path, DrawingFiles.file(["a", "theirs"]))
    scheduler.advance(by: 0.6)
    try await eventually { !store.isDirty(Self.path) && client.writes.count == 2 }
    #expect(client.writes[1].base == .match(theirs))
    let saved = try #require(client.note(Self.path))
    #expect(DrawingFiles.ids(inFile: saved.content) == ["a", "mine", "theirs"])
    #expect(DrawingFiles.ids(store.scene(Self.path)) == ["a", "mine", "theirs"])
    scheduler.advance(by: 0)
    #expect(changed > 0, "the editor is told about the merged scene")
  }

  @Test func aChangeElsewhereShowsAndMergesWithUnsavedEdits() async throws {
    await store.load(Self.path).value
    client.setNote(Self.path, DrawingFiles.file(["a", "web"]))
    await store.handleRemoteChange(Self.path)
    #expect(DrawingFiles.ids(store.scene(Self.path)) == ["a", "web"])
    #expect(client.writes.isEmpty, "nothing of ours to save")

    var scene = try #require(store.scene(Self.path))
    scene.elements.append(DrawingFiles.element("mine", x: 300))
    store.edit(Self.path, scene: scene)
    client.setNote(Self.path, DrawingFiles.file(["a", "web", "obsidian"]))
    await store.handleRemoteChange(Self.path)
    #expect(DrawingFiles.ids(store.scene(Self.path)) == ["a", "web", "obsidian", "mine"])
    try await eventually { !store.isDirty(Self.path) }
    #expect(
      DrawingFiles.ids(inFile: try #require(client.note(Self.path)).content)
        == ["a", "web", "obsidian", "mine"])
  }

  @Test func anUnreadableFileIsNeverWrittenOver() async throws {
    client.setNote(
      Self.path, "---\nexcalidraw-plugin: parsed\n---\n## Drawing\n```json\n{ broken\n```\n")
    await store.load(Self.path).value
    #expect(store.state(forPath: Self.path) == .unreadable)
    store.edit(Self.path, scene: ExcalidrawScene(elements: [DrawingFiles.element("x")]))
    scheduler.advance(by: 1)
    await settle()
    #expect(client.writes.isEmpty)
  }
}

@MainActor
@Suite("Drawings in the workspace: insert, edit in place, open on their own")
struct WorkspaceDrawingTests {
  let client = FakeDaemonClient(notes: [
    "Ideas.md": "First line\n\nLast",
    "Excalidraw/Plan.excalidraw.md": DrawingFiles.file(["a"]),
    "Embeds.md": "Intro\n![[Plan.excalidraw|240|right-wrap]]\nAfter",
  ])
  let scheduler = ManualScheduler()
  let workspace: Workspace

  init() async throws {
    workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
  }

  static let newPath = "Excalidraw/Drawing 2026-09-23 12.00.00.excalidraw.md"

  @Test func insertDrawingCreatesTheFileEmbedsItAndEditsItInPlace() async throws {
    await workspace.openNote("Ideas.md")
    let editor = workspace.editor.controller
    editor.scrollToLine(1)
    let path = await workspace.insertDrawing()
    #expect(path == Self.newPath)
    let write = try #require(client.writes.first { $0.path == Self.newPath })
    #expect(write.base == .createOnly)
    #expect(ExcalidrawMarkdown.parse(write.content).readable)
    #expect(
      editor.text
        == "First line\n![[Drawing 2026-09-23 12.00.00.excalidraw|360|right-wrap]]\n\nLast")
    #expect(editor.isEditingDrawing)
    #expect(editor.editingDrawingPath == Self.newPath)
    #expect(workspace.notes.isDirty("Ideas.md"), "the embed is the user's edit, saved like typing")

    // Drawing in place saves the drawing, debounced, with the version it was created at.
    let created = try #require(workspace.drawings.version(Self.newPath))
    var scene = try #require(editor.drawingCanvas?.scene)
    scene.elements.append(DrawingFiles.element("new"))
    workspace.editorDidEditDrawing(
      EditorDrawing(path: Self.newPath, scene: scene, contentHash: DrawingContentHash.hash(scene)))
    scheduler.advance(by: 0.6)
    try await eventually { !workspace.drawings.isDirty(Self.newPath) }
    let saved = try #require(client.writes.last { $0.path == Self.newPath })
    #expect(saved.base == .match(created))
    #expect(DrawingFiles.ids(inFile: saved.content) == ["new"])

    // A second drawing made in the same second gets its own name.
    editor.endEditingDrawing()
    editor.scrollToLine(0)
    #expect(
      await workspace.insertDrawing() == "Excalidraw/Drawing 2026-09-23 12.00.00_0.excalidraw.md")
  }

  @Test func embedsResolveToTheirFilesAndFollowChangesElsewhere() async throws {
    await workspace.openNote("Embeds.md")
    #expect(workspace.editorDrawing(for: "Plan.excalidraw") == .loading)
    try await eventually { workspace.drawings.has("Excalidraw/Plan.excalidraw.md") }
    scheduler.advance(by: 0)
    let drawing = try #require(workspace.editorDrawing(for: "Plan.excalidraw")?.drawing)
    #expect(DrawingFiles.ids(drawing.scene) == ["a"])
    #expect(workspace.editorDrawing(for: "Nope.excalidraw") == .missing)

    // Obsidian (or the web app) changes the drawing: the embed shows the new version.
    let version = client.setNote("Excalidraw/Plan.excalidraw.md", DrawingFiles.file(["a", "b"]))
    workspace.handleVaultChanged(
      VaultChangedEvent(
        changes: [
          VaultChange(path: "Excalidraw/Plan.excalidraw.md", kind: .modified, version: version)
        ], origin: .external))
    try await eventually {
      DrawingFiles.ids(workspace.drawings.scene("Excalidraw/Plan.excalidraw.md")) == ["a", "b"]
    }
    #expect(
      DrawingFiles.ids(workspace.editorDrawing(for: "Plan.excalidraw")?.drawing?.scene) == [
        "a", "b",
      ])
  }

  @Test func theContextMenuOffersInsertDrawingWithItsShortcut() async throws {
    await workspace.openNote("Ideas.md")
    let menu = NSMenu()
    workspace.editorWillShowContextMenu(menu)
    let item = try #require(menu.items.first as? CommandMenuItem)
    #expect(item.title == "Insert Drawing")
    #expect(item.keyEquivalent == "x")
    #expect(item.keyEquivalentModifierMask == [.command, .shift])
    // Not in a drawing opened on its own.
    await workspace.openNote("Excalidraw/Plan.excalidraw.md")
    let other = NSMenu()
    workspace.editorWillShowContextMenu(other)
    #expect(other.items.isEmpty)
    #expect(!workspace.canInsertDrawing)
  }

  @Test func aDrawingOpenedOnItsOwnShowsTheDrawingOrItsSource() async throws {
    await workspace.openNote("Excalidraw/Plan.excalidraw.md")
    #expect(workspace.isDrawing(workspace.activePath))
    #expect(!workspace.showsDrawingSource("Excalidraw/Plan.excalidraw.md"))
    _ = workspace.drawingState(forDocument: "Excalidraw/Plan.excalidraw.md", revision: 0)
    try await eventually { workspace.drawings.has("Excalidraw/Plan.excalidraw.md") }
    var scene = try #require(workspace.drawings.scene("Excalidraw/Plan.excalidraw.md"))
    scene.elements.append(DrawingFiles.element("drawn"))
    workspace.drawings.edit("Excalidraw/Plan.excalidraw.md", scene: scene)
    // The source shows what's saved.
    await workspace.setShowsDrawingSource(true, for: "Excalidraw/Plan.excalidraw.md")
    #expect(workspace.showsDrawingSource("Excalidraw/Plan.excalidraw.md"))
    #expect(DrawingFiles.ids(inFile: workspace.editor.controller.text) == ["a", "drawn"])
    await workspace.setShowsDrawingSource(false, for: "Excalidraw/Plan.excalidraw.md")
    #expect(!workspace.showsDrawingSource("Excalidraw/Plan.excalidraw.md"))
  }

  @Test func linkTargetsAreTheShortestUniqueName() {
    let paths = [
      "Excalidraw/Plan.excalidraw.md", "Old/Plan.excalidraw.md", "Excalidraw/Map.excalidraw.md",
    ]
    #expect(
      Workspace.linkTarget(forDrawing: "Excalidraw/Map.excalidraw.md", in: paths)
        == "Map.excalidraw")
    #expect(
      Workspace.linkTarget(forDrawing: "Excalidraw/Plan.excalidraw.md", in: paths)
        == "Excalidraw/Plan.excalidraw")
  }
}
