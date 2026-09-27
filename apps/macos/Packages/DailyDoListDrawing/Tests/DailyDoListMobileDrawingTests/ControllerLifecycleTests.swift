#if canImport(UIKit)
  import DailyDoListMobileDrawing
  import Testing
  import SwiftUI
  import UIKit

  @MainActor
  @Suite("Mobile drawing controller lifecycle")
  struct ControllerLifecycleTests {
    @Test func hostedCanvasFillsAvailableSpaceAndOwnsHitTesting() async throws {
      let controller = MobileDrawingController(scene: .init())
      let host = UIHostingController(rootView: MobileDrawingView(controller: controller))
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
      window.rootViewController = host
      window.isHidden = false
      defer {
        window.isHidden = true
        window.rootViewController = nil
      }
      host.view.frame = window.bounds
      host.view.layoutIfNeeded()
      await Task.yield()
      host.view.layoutIfNeeded()
      func find(_ view: UIView) -> MobileDrawingCanvasView? {
        if let canvas = view as? MobileDrawingCanvasView { return canvas }
        return view.subviews.lazy.compactMap { find($0) }.first
      }
      let canvas = try #require(find(host.view))
      #expect(canvas.bounds.width >= 350 && canvas.bounds.height > 400)
      let point = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
      #expect(canvas.hitTest(point, with: nil) === canvas)
      #expect(canvas.accessibilityElements?.isEmpty == false)
      #expect(canvas.gestureRecognizers?.filter { $0 is UIPanGestureRecognizer }.count == 2)
    }

    @Test func controllerSavesBeforeMountAfterDisposalAndWithoutDuplicates() {
      let controller = MobileDrawingController(scene: .init())
      var changes = 0
      controller.onChange = { _ in changes += 1 }
      controller.editor.setCanvasBackground("#fafafa")
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
