import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Drawing interaction checkpoints")
struct InteractionCheckpointTests {
  @Test func reportsSelectionOnlyCompletionAndCommitsVisibleDraft() throws {
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    var completions = 0
    var commits = 0
    editor.onInteractionEnd = { completions += 1 }
    editor.onChange = { _ in commits += 1 }
    editor.pointerDown(at: .zero)
    #expect(editor.hasActiveInteraction)
    editor.pointerUp(at: .zero)
    #expect(!editor.hasActiveInteraction && completions == 1 && commits == 0)
    editor.tool = .rectangle
    editor.pointerDown(at: DrawingPoint(10, 10))
    editor.pointerDragged(to: DrawingPoint(80, 60))
    editor.commitInteraction()
    #expect(!editor.hasActiveInteraction)
    #expect(editor.scene.visibleElements.count == 1 && commits == 1)
    #expect(editor.scene.visibleElements[0].width == 70)
    editor.undo()
    #expect(editor.scene.visibleElements.isEmpty)
  }

  @Test func cancellationEndsInteractionAndRestoresCommittedScene() {
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    var completions = 0
    editor.onInteractionEnd = { completions += 1 }
    editor.tool = .rectangle
    editor.pointerDown(at: .zero)
    editor.pointerDragged(to: DrawingPoint(80, 60))
    editor.handleKey(.escape)
    #expect(!editor.hasActiveInteraction && completions == 1)
    #expect(editor.scene.visibleElements.isEmpty && !editor.canUndo)
  }

  @Test func aLateImportIsRefusedRatherThanEndingTheUsersGesture() {
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    editor.tool = .rectangle
    editor.pointerDown(at: .zero)
    editor.pointerDragged(to: DrawingPoint(80, 60))
    #expect(throws: DrawingTransferError.interactionInProgress) {
      try editor.validatedImport(
        validate: { _ in }, operation: { _ in Issue.record("The import ran") })
    }
    #expect(editor.hasActiveInteraction)
    editor.pointerUp(at: DrawingPoint(80, 60))
    #expect(editor.scene.visibleElements.count == 1)
  }
}
