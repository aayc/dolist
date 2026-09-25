import AppKit
import DailyDoListDrawingModel
import DailyDoListUI
import Foundation
import Testing

@testable import DailyDoListDrawing

/// The canvas driven with real mouse and key events, and rendered for review in
/// `.build/drawing-snapshots/`.
@MainActor
@Suite("Canvas view", .serialized)
struct CanvasViewTests {
  @Test func drawsARectangleWithTheMouse() throws {
    let harness = CanvasHarness()
    defer { harness.close() }
    harness.press("r")
    #expect(harness.editor.tool == .rectangle)
    harness.drag(from: CGPoint(x: 100, y: 120), to: CGPoint(x: 260, y: 220))
    let rectangle = try #require(harness.elements.first)
    #expect(rectangle.type == .rectangle)
    #expect((rectangle.x, rectangle.y, rectangle.width, rectangle.height) == (100, 120, 160, 100))
    #expect(harness.changes.count == 1)
    #expect(harness.editor.selectedIds == [rectangle.id])
  }

  @Test func movesResizesAndUndoesWithTheMouseAndKeys() throws {
    let harness = CanvasHarness()
    defer { harness.close() }
    harness.press("r")
    harness.drag(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 160))
    let id = try #require(harness.editor.selectedIds.first)
    harness.drag(from: CGPoint(x: 130, y: 100), to: CGPoint(x: 180, y: 150))
    #expect(harness.editor.element(id)?.x == 150)
    #expect(harness.editor.element(id)?.y == 150)
    // The north-west handle, 5 points out from the corner.
    harness.drag(from: CGPoint(x: 145, y: 145), to: CGPoint(x: 115, y: 125))
    let resized = try #require(harness.editor.element(id))
    #expect((resized.x, resized.y, resized.width, resized.height) == (120, 130, 130, 80))
    harness.press("z", flags: .command)
    #expect(harness.editor.element(id)?.width == 100)
    harness.press("z", flags: [.command, .shift])
    #expect(harness.editor.element(id)?.width == 130)
    harness.press("d", flags: .command)
    #expect(harness.elements.count == 2)
    harness.press("delete")
    #expect(harness.elements.count == 1)
  }

  @Test func drawsABoundArrowBetweenShapes() throws {
    let left = TestScenes.element(.rectangle, id: "left", x: 60, y: 100, width: 120, height: 80)
    let right = TestScenes.element(.diamond, id: "right", x: 400, y: 90, width: 140, height: 100)
    let harness = CanvasHarness(scene: ExcalidrawScene(elements: [left, right]))
    defer { harness.close() }
    harness.press("a")
    harness.drag(from: CGPoint(x: 185, y: 140), to: CGPoint(x: 395, y: 140))
    let arrow = try #require(harness.elements.last)
    #expect(arrow.type == .arrow)
    #expect(arrow.startBinding?.elementId == "left")
    #expect(arrow.endBinding?.elementId == "right")
    // Drag the diamond down: the arrow's end follows.
    harness.drag(from: CGPoint(x: 471, y: 91), to: CGPoint(x: 471, y: 231))
    let moved = try #require(harness.editor.element(arrow.id))
    let end = ArrowBinding.absolutePoint(moved, moved.points.count - 1)
    #expect(end.y > 180)
    _ = try harness.writeSnapshot("canvas-bound-arrow")
  }

  @Test func typesTextInPlace() throws {
    let harness = CanvasHarness()
    defer { harness.close() }
    harness.press("t")
    harness.click(CGPoint(x: 200, y: 200))
    let textView = try #require(harness.canvas.textEditor)
    #expect(harness.window.firstResponder === textView)
    textView.insertText("Hello, canvas", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(harness.editor.element(textView.elementId)?.text?.text == "Hello, canvas")
    _ = try harness.writeSnapshot("canvas-text-editing")
    harness.press("escape")
    #expect(harness.canvas.textEditor == nil)
    let text = try #require(harness.elements.first)
    #expect(text.text?.originalText == "Hello, canvas")
    #expect(harness.changes.count == 1)
  }

  @Test func labelsAShapeOnDoubleClick() throws {
    let box = TestScenes.element(.rectangle, id: "box", x: 100, y: 100, width: 200, height: 100) {
      $0.backgroundColor = "#ffec99"
    }
    let harness = CanvasHarness(scene: ExcalidrawScene(elements: [box]))
    defer { harness.close() }
    harness.click(CGPoint(x: 200, y: 150), count: 2)
    let textView = try #require(harness.canvas.textEditor)
    textView.insertText("Ship it", replacementRange: NSRange(location: NSNotFound, length: 0))
    harness.press("escape")
    let label = try #require(harness.elements.first { $0.type == .text })
    #expect(label.containerId == "box")
    #expect(abs(label.x + label.width / 2 - 200) < 1, "centered in the box")
  }

  @Test func escapeWithNothingLeftEndsEditing() {
    let harness = CanvasHarness(
      scene: ExcalidrawScene(elements: [TestScenes.element(.rectangle, id: "a", x: 0, y: 0)]))
    defer { harness.close() }
    harness.editor.select(["a"])
    harness.press("escape")
    #expect(harness.endedEditing == 0)
    harness.press("escape")
    #expect(harness.endedEditing == 1)
  }

  @Test func scrollingPansAndCommandScrollZooms() throws {
    let harness = CanvasHarness()
    defer { harness.close() }
    harness.canvas.zoom(by: 2, around: CGPoint(x: 400, y: 300))
    #expect(harness.canvas.viewport.zoom == 2)
    let anchor = harness.canvas.viewport.viewToScene(CGPoint(x: 400, y: 300))
    #expect(abs(anchor.x - 400) < 1e-9 && abs(anchor.y - 300) < 1e-9, "zooms around the pointer")
    harness.press("space")
    harness.drag(from: CGPoint(x: 400, y: 300), to: CGPoint(x: 300, y: 300))
    harness.release("space")
    #expect(abs(harness.canvas.viewport.origin.x - 250) < 1e-9, "space-drag pans")
    #expect(harness.elements.isEmpty)
  }

  @Test func displayModeFitsTheDrawingAndPassesEventsOn() throws {
    let harness = CanvasHarness(
      scene: TestScenes.gallery(), mode: .display, size: CGSize(width: 360, height: 260))
    defer { harness.close() }
    harness.canvas.zoomToFit()
    #expect(harness.canvas.viewport.zoom < 1)
    harness.click(CGPoint(x: 50, y: 50))
    #expect(harness.editor.selectedIds.isEmpty)
    #expect(!harness.canvas.acceptsFirstResponder)
    #expect(harness.canvas.preferredHeight(forWidth: 360) > 200)
    _ = try harness.writeSnapshot("canvas-display")
  }

  @Test(arguments: DrawingTheme.allCases)
  func rendersTheEditingCanvasWithItsToolBar(theme: DrawingTheme) throws {
    let harness = CanvasHarness(
      scene: TestScenes.gallery(), theme: theme, size: CGSize(width: 820, height: 560))
    defer { harness.close() }
    harness.canvas.setViewport(DrawingViewport(zoom: 1.2, origin: DrawingPoint(0, -60)))
    harness.editor.select(["r1"])
    harness.move(to: harness.canvas.viewport.sceneToView(DrawingPoint(315, 70)))
    let rep = try harness.writeSnapshot("canvas-editing-\(theme.rawValue)")
    #expect(harness.canvas.toolbarHost != nil)
    #expect(harness.editor.hoveredId == "e1")
    // The tool bar shows over the top of the canvas.
    let toolbar = try #require(harness.canvas.toolbarHost)
    #expect(toolbar.frame.minY == 8)
    #expect(toolbar.frame.width > 300)
    _ = rep
  }

  @Test func toolTooltipsCarryExcalidrawsShortcuts() {
    for tool in DrawingTool.toolbarTools {
      #expect(tool.shortcut.modifiers.isEmpty)
      #expect(DrawingTool.tool(forKey: Character(tool.shortcut.key.cap.lowercased())) == tool)
    }
    #expect(DrawingTool.rectangle.shortcut.caps == ["R"])
    #expect(DrawingCommand.redo.shortcut.caps == ["⇧", "⌘", "Z"])
  }
}
