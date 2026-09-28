import DailyDoListDrawingModel
import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import Testing
import UIKit

@testable import DailyDoList
@testable import DailyDoListMobileDrawing

@MainActor struct PhoneLinkNavigationTests {
  @Test func drawingElementLinkKeepsItsFragmentAndFocusesAfterCanvasMounts() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var profile = ConnectionProfile(
      name: "Synthetic host", origin: try ConnectionOrigin("https://notes.example.test"))
    profile.workspaceID = "workspace"
    profile.hostID = "host"
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "workspace", hostID: "host", origin: profile.origin)
    let workspace = try PhoneWorkspace(
      rootDirectory: root,
      structural: WorkspaceStructuralCoordinator(rootDirectory: root, scope: scope),
      recovery: WorkspaceRecovery(rootDirectory: root, scope: scope), profile: profile,
      repository: WorkspaceRepository(rootDirectory: root, scope: scope),
      drawingRepository: DrawingRepository(rootDirectory: root, scope: scope),
      cache: WorkspaceCache(rootDirectory: root, scope: scope),
      captureOutbox: CaptureOutbox(rootDirectory: root, scope: scope))
    var target = ExcalidrawElement(id: "target", type: .rectangle)
    target.x = 1800
    target.y = 1200
    target.width = 80
    target.height = 60
    var other = ExcalidrawElement(id: "other", type: .ellipse)
    other.width = 200
    other.height = 200
    let content = try ExcalidrawMarkdown.serialize(
      ExcalidrawScene(elements: [target, other]), previous: nil)
    let drawing = try await workspace.drawingRepository.cache(
      RemoteNote(content: content, version: "v1"), path: "Sketch.excalidraw.md")
    workspace.includeLocalDrawings([drawing])
    await workspace.followEditorLink(
      .note(target: "Sketch.excalidraw", subpath: "^target"), from: "Note.md")
    let controller = try #require(workspace.activeDrawing?.controller)
    #expect(controller.editor.selectedIds == ["target"])
    let canvas = MobileDrawingCanvasView(editor: controller.editor, forwardsChanges: false)
    controller.canvas = canvas
    canvas.controller = controller
    canvas.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
    canvas.layoutSubviews()
    #expect(canvas.viewport.zoom > 1)
    #expect(controller.scene == drawing.document.scene)
    #expect(controller.elementLink?("target") == "[[Sketch.excalidraw.md#^target]]")
    #expect(!controller.focusElement("missing"))
    #expect(controller.editor.selectedIds == ["target"])
  }
}
