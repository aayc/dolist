#if DEBUG
  import DailyDoListMobileDrawing
  import SwiftUI

  /// Real touch regression surface with synthetic memory-only content and no host connection.
  struct DrawingSpikeView: View {
    @State private var controller = MobileDrawingController(scene: .init())
    @State private var count = 0
    var body: some View {
      VStack {
        Text("Elements: \(count)").accessibilityIdentifier("drawing.count")
        MobileDrawingView(controller: controller)
          .accessibilityIdentifier("drawing.surface")
      }
      .onAppear {
        controller.onChange = { scene in count = scene.elements.filter { !$0.isDeleted }.count }
      }
    }
  }
#endif
