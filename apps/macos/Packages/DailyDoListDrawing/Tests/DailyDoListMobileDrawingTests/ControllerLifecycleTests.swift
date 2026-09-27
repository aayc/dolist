#if canImport(UIKit)
  import DailyDoListMobileDrawing
  import Testing

  @MainActor
  @Suite("Mobile drawing controller lifecycle")
  struct ControllerLifecycleTests {
    @Test func controllerSavesBeforeMountAfterDisposalAndWithoutDuplicates() {
      let controller = MobileDrawingController(scene: .init())
      var changes = 0
      controller.onChange = { _ in changes += 1 }
      controller.editor.setCanvasBackground("#ffffff")
      #expect(changes == 1)
      var canvas: MobileDrawingCanvasView? = MobileDrawingCanvasView(
        editor: controller.editor, forwardsChanges: false)
      canvas?.editor.setCanvasBackground("#ffeeee")
      #expect(changes == 2)
      canvas?.finishEditing()
      canvas = nil
      controller.editor.setCanvasBackground("#eeeeff")
      #expect(changes == 3)
      let recreated = MobileDrawingCanvasView(editor: controller.editor, forwardsChanges: false)
      recreated.editor.setCanvasBackground("#eeffee")
      #expect(changes == 4)
    }
  }
#endif
